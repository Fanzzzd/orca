import Foundation
import Network
import IrohLib

@MainActor
final class ProbeModel: ObservableObject {
    enum ConnState: Equatable {
        case idle
        case binding
        case ready
        case connecting
        case connected
        case failed(String)

        var label: String {
            switch self {
            case .idle: return "idle"
            case .binding: return "binding…"
            case .ready: return "ready"
            case .connecting: return "connecting…"
            case .connected: return "connected"
            case .failed(let m): return "failed: \(m)"
            }
        }
    }

    static let alpn = Data("orca-iroh-poc/1".utf8)
    static let pingCount = 20
    static let throughputBytes = 10 * 1024 * 1024
    static let chunk = 64 * 1024

    @Published var hostEndpointId: String = ""
    @Published var state: ConnState = .idle
    @Published var pathType: String = "—"
    @Published var pathDetail: String = ""
    @Published var pingStats: String = "—"
    @Published var throughputStats: String = "—"
    @Published var networkInfo: String = "detecting…"
    @Published var logLines: [String] = []
    @Published var busy = false

    private var endpoint: Endpoint?
    private var connection: Connection?
    /// Polls `Connection.paths()` — do NOT use `watchPaths` (iroh-ffi #277).
    private var pathPollTask: Task<Void, Never>?
    private var pathMonitor: NWPathMonitor?
    private let monitorQueue = DispatchQueue(label: "dev.fanzzzd.irohprobe.netmon")

    init() {
        startNetworkMonitor()
    }

    deinit {
        pathMonitor?.cancel()
    }

    func appendLog(_ line: String) {
        let ts = ISO8601DateFormatter().string(from: Date())
        logLines.append("[\(ts.suffix(8))] \(line)")
        if logLines.count > 400 {
            logLines.removeFirst(logLines.count - 400)
        }
    }

    /// Bind is deferred until Connect — avoid any iroh work at cold launch.
    func ensureEndpoint() async {
        if endpoint != nil { return }
        state = .binding
        appendLog("binding endpoint (n0 preset)…")
        do {
            // Match hello-iroh: bind with presetN0; no watch* APIs.
            let ep = try await Endpoint.bind(options: EndpointOptions(
                preset: presetN0(),
                alpns: [Self.alpn]
            ))
            // Wait for home relay so public-key dial can resolve.
            await ep.online()
            endpoint = ep
            state = .ready
            appendLog("local endpoint: \(ep.id().description)")
        } catch {
            state = .failed(String(describing: error))
            appendLog("bind failed: \(error)")
        }
    }

    func connect() async {
        busy = true
        defer { busy = false }
        await ensureEndpoint()
        guard let ep = endpoint else { return }

        let trimmed = hostEndpointId
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        guard trimmed.count == 64, trimmed.allSatisfy(\.isHexDigit) else {
            appendLog("invalid EndpointId (expect 64 hex chars)")
            state = .failed("invalid EndpointId")
            return
        }

        let remoteId: EndpointId
        do {
            remoteId = try EndpointId.fromString(s: trimmed)
        } catch {
            appendLog("EndpointId parse error: \(error)")
            state = .failed("bad EndpointId")
            return
        }

        stopPathPoll()
        if let old = connection {
            try? old.close(errorCode: 0, reason: Data("reconnect".utf8))
        }
        connection = nil
        pathType = "—"
        pathDetail = ""

        state = .connecting
        appendLog("dialing \(remoteId.description.prefix(16))… by EndpointId only")
        let addr = EndpointAddr(id: remoteId, relayUrl: nil, addresses: [])
        do {
            let conn = try await ep.connect(addr: addr, alpn: Self.alpn)
            connection = conn
            state = .connected
            applyPaths(conn.paths())
            appendLog("connected remote=\(conn.remoteId().description.prefix(16))…")
            if let rtt = conn.rtt() {
                appendLog("quic rtt ≈ \(rtt) ms")
            }
            // Poll paths every 1s — same pattern as hello-iroh-ffi.
            // `watchPaths` panics: n0_future::task::spawn outside Tokio
            // (iroh-ffi#277, path.rs:201).
            startPathPoll(conn)
        } catch {
            state = .failed(String(describing: error))
            appendLog("connect failed: \(error)")
        }
    }

    func runPings() async {
        guard let conn = connection else {
            appendLog("not connected")
            return
        }
        busy = true
        defer { busy = false }
        appendLog("ping ×\(Self.pingCount)…")
        _ = try? await roundTrip(conn, "ECHO warm")
        var samples: [Double] = []
        for i in 0..<Self.pingCount {
            do {
                let (ms, resp) = try await roundTrip(conn, "PING")
                if resp != "PONG" {
                    appendLog("ping \(i): unexpected \(resp)")
                }
                samples.append(ms)
            } catch {
                appendLog("ping \(i) failed: \(error)")
            }
        }
        guard !samples.isEmpty else {
            pingStats = "no samples"
            return
        }
        let minV = samples.min()!
        let maxV = samples.max()!
        let avg = samples.reduce(0, +) / Double(samples.count)
        pingStats = String(format: "min %.1f / avg %.1f / max %.1f ms", minV, avg, maxV)
        appendLog("latency: \(pingStats)")
        applyPaths(conn.paths())
    }

    func runThroughput() async {
        guard let conn = connection else {
            appendLog("not connected")
            return
        }
        busy = true
        defer { busy = false }
        let n = Self.throughputBytes
        appendLog("throughput: requesting \(n) bytes…")
        do {
            let bi = try await conn.openBi()
            let t0 = Date()
            try await bi.send().writeAll(buf: Data("THROUGHPUT \(n)".utf8))
            try await bi.send().finish()
            let got = try await readExact(bi.recv(), n)
            let ms = Date().timeIntervalSince(t0) * 1000
            let mbps = (Double(got) * 8) / (ms / 1000) / 1e6
            throughputStats = String(
                format: "%.2f Mbit/s (%d/%d B in %.0f ms)",
                mbps, got, n, ms
            )
            appendLog("throughput: \(throughputStats)")
        } catch {
            appendLog("throughput failed: \(error)")
            throughputStats = "failed"
        }
        applyPaths(conn.paths())
    }

    // MARK: - path polling (not watchPaths)

    private func startPathPoll(_ conn: Connection) {
        stopPathPoll()
        pathPollTask = Task { [weak self] in
            while !Task.isCancelled {
                let paths = conn.paths()
                await MainActor.run {
                    self?.applyPaths(paths)
                }
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
    }

    private func stopPathPoll() {
        pathPollTask?.cancel()
        pathPollTask = nil
    }

    // MARK: - protocol helpers

    private func roundTrip(_ conn: Connection, _ payload: String) async throws -> (Double, String) {
        let bi = try await conn.openBi()
        let t0 = Date()
        try await bi.send().writeAll(buf: Data(payload.utf8))
        try await bi.send().finish()
        let resp = try await bi.recv().readToEnd(sizeLimit: 1024)
        let ms = Date().timeIntervalSince(t0) * 1000
        return (ms, String(decoding: resp, as: UTF8.self))
    }

    private func readExact(_ recv: RecvStream, _ n: Int) async throws -> Int {
        var got = 0
        while got < n {
            let want = UInt32(min(Self.chunk, n - got))
            let chunk = try await recv.read(sizeLimit: want)
            if chunk.isEmpty { break }
            got += chunk.count
        }
        return got
    }

    private func applyPaths(_ paths: [PathSnapshot]) {
        pathType = Self.pathLabel(paths)
        pathDetail = paths.map { p in
            let kind = [p.isIp ? "IP" : nil, p.isRelay ? "RELAY" : nil]
                .compactMap { $0 }.joined(separator: "+")
            let mark = p.isSelected ? "*" : " "
            return "\(mark) \(kind) \(p.remoteAddr) rtt=\(p.rttMs)ms"
        }.joined(separator: "\n")
        if pathDetail.isEmpty { pathDetail = "(no paths yet)" }
    }

    static func pathLabel(_ paths: [PathSnapshot]) -> String {
        let selected = paths.first(where: \.isSelected) ?? paths.first
        guard let s = selected else { return "unknown" }
        var kinds: [String] = []
        if s.isIp { kinds.append("direct") }
        if s.isRelay { kinds.append("relayed") }
        if kinds.isEmpty { return "unknown" }
        if kinds.count == 2 { return "mixed" }
        return kinds[0]
    }

    private func startNetworkMonitor() {
        let mon = NWPathMonitor()
        pathMonitor = mon
        mon.pathUpdateHandler = { [weak self] path in
            var parts: [String] = []
            if path.usesInterfaceType(.wifi) { parts.append("Wi-Fi") }
            if path.usesInterfaceType(.cellular) { parts.append("Cellular") }
            if path.usesInterfaceType(.wiredEthernet) { parts.append("Ethernet") }
            if path.usesInterfaceType(.other) { parts.append("Other") }
            let status: String
            switch path.status {
            case .satisfied: status = "up"
            case .unsatisfied: status = "down"
            case .requiresConnection: status = "requires-conn"
            @unknown default: status = "?"
            }
            let line = parts.isEmpty
                ? "network: \(status) (no known iface)"
                : "network: \(parts.joined(separator: "+")) (\(status))"
            Task { @MainActor in
                self?.networkInfo = line
            }
        }
        mon.start(queue: monitorQueue)
    }
}

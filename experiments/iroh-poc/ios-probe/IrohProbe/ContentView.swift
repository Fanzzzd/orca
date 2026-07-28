import SwiftUI

struct ContentView: View {
    @StateObject private var model = ProbeModel()

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                Text(model.networkInfo)
                    .font(.caption)
                    .foregroundStyle(.secondary)

                TextField("Host EndpointId (64 hex)", text: $model.hostEndpointId)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(.system(.body, design: .monospaced))
                    .padding(10)
                    .background(Color(.secondarySystemBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 8))

                HStack(spacing: 8) {
                    Button("Connect") {
                        Task { await model.connect() }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.busy)

                    Button("Ping ×20") {
                        Task { await model.runPings() }
                    }
                    .buttonStyle(.bordered)
                    .disabled(model.busy || model.state != .connected)

                    Button("Throughput 10MB") {
                        Task { await model.runThroughput() }
                    }
                    .buttonStyle(.bordered)
                    .disabled(model.busy || model.state != .connected)
                }

                Group {
                    LabeledContent("State", value: model.state.label)
                    LabeledContent("Path", value: model.pathType)
                    if !model.pathDetail.isEmpty {
                        Text(model.pathDetail)
                            .font(.system(.caption2, design: .monospaced))
                            .foregroundStyle(.secondary)
                    }
                    LabeledContent("Ping", value: model.pingStats)
                    LabeledContent("Throughput", value: model.throughputStats)
                }
                .font(.subheadline)

                Divider()

                Text("Log")
                    .font(.headline)
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 2) {
                            ForEach(Array(model.logLines.enumerated()), id: \.offset) { idx, line in
                                Text(line)
                                    .font(.system(.caption2, design: .monospaced))
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .id(idx)
                            }
                        }
                    }
                    .onChange(of: model.logLines.count) { _, count in
                        if count > 0 {
                            proxy.scrollTo(count - 1, anchor: .bottom)
                        }
                    }
                }
                .frame(maxHeight: .infinity)
                .padding(8)
                .background(Color(.secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
            .padding()
            .navigationTitle("IrohProbe")
            // Bind is deferred to Connect — no iroh FFI on cold launch.
        }
    }
}

#Preview {
    ContentView()
}

# iroh connectivity PoC (Phase 1)

Prove that **iroh 1.0 / JS binding 1.1.0** can establish a connection using **only a public-key dial** (EndpointId — no IP or port), report whether traffic is **direct** or **relayed**, and measure latency + throughput.

Standalone Node ESM project. Does not join the Orca pnpm workspace.

## Requirements

- Node.js **≥ 20.3**
- Network access (n0 default relays + discovery; first connect may take a few seconds)
- Prebuilt N-API binary for your platform (this machine: **darwin-arm64**)

## Install

```bash
cd experiments/iroh-poc
npm install
```

## Run

### Machine A — host

```bash
node host.mjs
```

Within ~10s you should see:

```text
========================================
  EndpointId: <64-char hex endpoint id>
========================================
```

Leave this process running.

### Machine B (or same machine) — client

```bash
node client.mjs <EndpointId>
```

Optional: skip the 60s path-hold (useful for CI / quick local check):

```bash
node client.mjs <EndpointId> --quick
```

### Same-machine smoke test

Two terminals on one host is enough to prove the binding and protocol. On this machine a local run first selected the **relay** path (~100 ms RTT), then upgraded to **direct** after pings (sub-ms RTT) — useful even for same-host tests. Still, that does **not** replace a cross-NAT / cellular validation by a reviewer.

## What the client report means

| Field | Meaning |
| --- | --- |
| `connection established` | Whether `Endpoint.connect` succeeded using only `EndpointAddr(EndpointId)`. |
| `connection type` | From `Connection.paths()`: selected path `isIp` → **direct**, `isRelay` → **relayed**. May change after a few RTTs as hole-punch completes. |
| `latency (20 pings)` | App-level RTT: open bi-stream, send `PING`, read `PONG`. min / avg / max in ms. |
| `throughput` | Host streams **10 MiB** on request; client times wall clock and reports Mbit/s. |
| hold (60s) | Keeps the connection open and prints path / path-event callbacks if the selected path changes. `--quick` skips this. |

Host also logs each accept and whether the **incoming** address was IP or relay (`Incoming.remoteAddr().kind`).

## Protocol (custom ALPN)

ALPN: `orca-iroh-poc/1`

Each request is one bidirectional stream:

1. Client writes a short UTF-8 command and finishes the send half.
2. Host responds and finishes.

| Command | Host response |
| --- | --- |
| `PING` | `PONG` |
| `ECHO <payload>` | echoes `<payload>` |
| `THROUGHPUT <n>` | streams `n` zero-bytes |

## Findings (Phase 1)

### Package

| Item | Value |
| --- | --- |
| npm package | `@number0/iroh` |
| version used | **1.1.0** (latest as of 2026-07-16) |
| engines | Node ≥ 20.3.0 |
| native binary (this machine) | `@number0/iroh-darwin-arm64` → `iroh.darwin-arm64.node` **~12.4 MiB** (12,986,704 bytes) |
| binding tech | napi-rs prebuilds (no local Rust toolchain required) |
| docs | https://docs.iroh.computer/languages/javascript · TypeDoc https://n0-computer.github.io/iroh-ffi/js/ |

### API maturity impressions

- **Usable for a PoC.** 1.x surface maps cleanly to iroh 1.0: `Endpoint.bind` / `connect` / `acceptNext`, bi-streams, tickets, relays, path watchers.
- **Public-key dial works** via `new EndpointAddr(EndpointId.fromString(id))` plus the default **n0** preset (discovery + relays). No IP/port needed in the client CLI. `EndpointId.toString()` in 1.1.0 is **64-char hex** (not base32, despite older docs).
- **Path quality is first-class in JS:** `Connection.paths()`, `watchPaths`, `watchPathEvents`, `PathSnapshot.isIp` / `isRelay` / `rttMs` — enough to answer direct vs relayed without scraping logs.
- Rough edges for product embedding:
  - Stream write APIs take `Array<number>` (typed as such); large payloads need chunking to avoid huge intermediate arrays.
  - Package `type` is CommonJS; works fine from ESM via Node’s interop (`import { Endpoint } from '@number0/iroh'`).
  - macOS **Intel not listed** in published targets (arm64 only on Darwin) — check matrix before shipping to older Macs.
  - Higher-level protocols (blobs/docs/gossip) are out of scope for this binding; transport-only is what we need for Orca’s use case.

### Electron main-process notes

| Topic | Notes |
| --- | --- |
| Native addon | ~12 MiB per platform optionalDependency; must ship correct `*-darwin-arm64` / `linux-*` / `win32-*` binary with the app. |
| Runtime | Node/Electron N-API; not a pure-JS polyfill. Rebuild / ship prebuilds for **Electron’s ABI** if Electron’s Node version ≠ system Node (verify with electron-rebuild or ship napi-compatible prebuilds). |
| Main vs renderer | Load only in **main** (or a utility process). Renderer has no native module access under contextIsolation. |
| Mobile | Official Swift / Kotlin bindings exist for real mobile peers; this PoC is desktop Node only. |
| Potential blockers | (1) Electron ABI mismatch for `.node` binary, (2) no darwin-x64 prebuild, (3) app size + codesign of native lib, (4) need product story for EndpointId exchange (QR / account / ticket) — dial itself does not need IP. |

### Caveats

- First `online()` / connect can take several seconds while discovery and relay handshake complete.
- Same-machine tests often show **direct** immediately; treat “direct” as provisional until validated across NATs.
- Root repo `.gitignore` already ignores `node_modules/` and `package-lock.json`; this folder is intentionally standalone (`npm install` locally).

## Acceptance checklist

- [ ] `npm install && node host.mjs` prints EndpointId within 10s  
- [ ] `node client.mjs <id> --quick` connects, prints type + latency + ~10MB throughput, exits 0  
- [ ] Full client without `--quick` holds ~60s then exits 0  
- [ ] No app code outside `experiments/iroh-poc/` modified  

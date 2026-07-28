# IrohProbe (Phase 1.5)

Minimal iOS client that dials the Phase 1 `host.mjs` peer **by EndpointId only** (cellular cross-NAT path), reports **direct vs relayed**, and measures **ping** + **10 MiB throughput**.

Self-contained Xcode project under `experiments/iroh-poc/ios-probe/`. No app code outside this tree.

## Status

- **Installed** on **fanzzzd** (iPhone 15 Pro Max) as display name **IrohProbe**
- Bundle id used for this install: **`asdad12312`** (see [Signing](#signing))
- Launch verified: process stays alive >10s with no Tokio panic (see [Launch crash fix](#launch-crash-fix))
- Open the app on the phone yourself for the cellular cross-NAT test

## Requirements

- macOS with **Xcode 16+** (built with Xcode 26.0.1 / deployment **iOS 17.5+**)
- Paired iPhone; this machine’s device:
  - Name: **fanzzzd**
  - CoreDevice id (for `devicectl`): `3EDE1972-4C30-5ECD-A46C-289FB306BD35`
  - Hardware UDID (for `xcodebuild -destination`): `00008130-00125586187A8D3A`
- Identity: `Apple Development: Zhendi FAN (DM6777SZW2)`, team **59AW6PWR73**
- Network so SPM can fetch `iroh-ffi` and the phone can reach n0 relays/discovery

## Package pin

| Item | Value |
| --- | --- |
| SPM URL | `https://github.com/n0-computer/iroh-ffi` |
| Product | **IrohLib** |
| Version | **1.1.0** (exact pin; matches host JS `@number0/iroh@1.1.0`) |
| Docs | https://docs.iroh.computer/languages/swift |
| API | https://n0-computer.github.io/iroh-ffi/swift/documentation/irohlib/ |
| Platforms (package) | iOS 17.5+, macOS 14.5+ |

## Protocol (same as Phase 1 host)

ALPN: `orca-iroh-poc/1`

Each request is one bidirectional stream:

1. Client writes a UTF-8 command and finishes the send half.
2. Host responds and finishes.

| Command | Response |
| --- | --- |
| `PING` | `PONG` |
| `ECHO <p>` | `<p>` |
| `THROUGHPUT <n>` | `n` zero bytes |

## UI

| Element | Meaning |
| --- | --- |
| Network line | Phone path from `NWPathMonitor` (Wi-Fi / Cellular / both). For the real test: **Wi-Fi OFF**. |
| EndpointId field | Paste the 64-hex id printed by `node host.mjs` (Universal Clipboard works Mac → iPhone). |
| **Connect** | Binds a local `Endpoint` (n0 preset), dials `EndpointAddr(id only)`, ALPN above. |
| **State** | idle → binding → ready → connecting → connected / failed. |
| **Path** | Selected path: `direct` / `relayed` / `mixed` / `unknown`, from `Connection.paths()` + live `watchPaths`. Detail lines show IP/RELAY, remote addr, RTT. |
| **Ping ×20** | App-level RTT: open bi, send `PING`, read `PONG`. min / avg / max ms. |
| **Throughput 10MB** | Host streams 10 MiB zeros; wall-clock → Mbit/s. |
| Log | Timestamped events (bind, connect, errors, results). |

## Rebuild / reinstall (CLI only)

```bash
cd experiments/iroh-poc/ios-probe

# Resolve packages (first time / after pin change)
xcodebuild -resolvePackageDependencies \
  -project IrohProbe.xcodeproj \
  -scheme IrohProbe

# Build for the physical device (use HARDWARE UDID, not CoreDevice UUID)
xcodebuild \
  -project IrohProbe.xcodeproj \
  -scheme IrohProbe \
  -configuration Debug \
  -destination 'id=00008130-00125586187A8D3A' \
  -derivedDataPath ./DerivedData \
  DEVELOPMENT_TEAM=59AW6PWR73 \
  CODE_SIGN_STYLE=Automatic \
  build

# Install (CoreDevice id)
xcrun devicectl device install app \
  --device 3EDE1972-4C30-5ECD-A46C-289FB306BD35 \
  ./DerivedData/Build/Products/Debug-iphoneos/IrohProbe.app
```

First launch: if prompted, trust the developer cert under **Settings → General → VPN & Device Management**.

## Reviewer acceptance flow

1. On the Mac: `cd experiments/iroh-poc && node host.mjs` — copy the printed **EndpointId**.
2. On the iPhone: turn **Wi-Fi OFF** (cellular only). Open **IrohProbe**.
3. Paste EndpointId → **Connect**. Expect state `connected` and a path type (often `relayed` first, may upgrade to `direct`).
4. **Ping ×20** and **Throughput 10MB** without crash.

## Signing

| Item | Value |
| --- | --- |
| Display name | IrohProbe |
| Bundle id (this install) | **`asdad12312`** |
| Team | `59AW6PWR73` (Digital Artisan LTD) |
| Identity | Apple Development: Zhendi FAN (DM6777SZW2) |
| Profile | iOS Team Provisioning Profile: asdad12312 (`c8e0f4f1-…`) |

### Caveats found while building

1. **`xcodebuild -destination id=` needs the hardware UDID** (`00008130-…`), not the CoreDevice UUID (`3EDE1972-…`). The latter is for `devicectl`.
2. **Preferred bundle id `dev.fanzzzd.irohprobe` could not be provisioned** on this machine right now:
   - Team `59AW6PWR73` reports **membership not active** / ASC API returns `FORBIDDEN.REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED` (cannot register new App IDs or refresh profiles).
   - Local Xcode has **no Apple ID account session** for the team (`No Account for Team "Digital Artisan LTD"`), so `-allowProvisioningUpdates` cannot mint a new profile.
3. **Workaround used:** reuse existing throwaway App ID **`asdad12312`**, which already has a valid Xcode-managed development profile that lists **fanzzzd**. App still displays as **IrohProbe**.
4. After renewing Apple Developer Program agreements / re-adding the team account in Xcode → Settings → Accounts, switch `PRODUCT_BUNDLE_IDENTIFIER` back to `dev.fanzzzd.irohprobe` and rebuild with Automatic signing.

## Launch crash fix

### Symptom

App terminated ~1s after open with:

```text
thread '<unnamed>' panicked at src/path.rs:201:16:
there is no reactor running, must be called from the context of a Tokio 1.x runtime
IrohLib/IrohLib.swift:1827: Fatal error: 'try!' … UniffiInternalError.rustPanic(...)
signal 5
```

### Root cause

`Connection.watchPaths` (and other `watch*` helpers) call `n0_future::task::spawn` **outside** UniFFI’s `async_runtime = "tokio"` boundary (`iroh-ffi` `src/path.rs:201` → `spawn_paths_watch`). That spawn requires an entered Tokio 1.x reactor; the Swift wrapper is a **sync** method, so it panics and aborts.

This is the same class of bug as [iroh-ffi#277](https://github.com/n0-computer/iroh-ffi/issues/277) (documented for JS/Kotlin; Swift hits the same Rust path). The official [hello-iroh-ffi](https://github.com/n0-computer/hello-iroh-ffi) Swift app **does not** use `watchPaths`; it polls `Connection.paths()` on a timer.

### Fix (this app)

1. **Removed `watchPaths`** — poll `conn.paths()` every 1s while connected (same pattern as hello-iroh).
2. **No iroh work on cold launch** — bind is deferred until **Connect** (no `.task { ensureEndpoint() }` on appear), so the UI comes up even if bind is slow.

Path type still updates live via polling. When upstream fixes `watch*`, we can switch back.

## API notes (Swift IrohLib 1.1.0)

Verified against official docs + `IrohLib` sources for v1.1.0:

| Need | Available? | API |
| --- | --- | --- |
| Bind endpoint | yes | `Endpoint.bind(options: EndpointOptions(preset: presetN0(), alpns: …))` then `online()` |
| Dial by EndpointId | yes | `EndpointId.fromString` → `EndpointAddr(id:relayUrl:addresses:)` with `nil` / `[]` → `connect(addr:alpn:)` |
| Bi streams | yes | `conn.openBi()` → `send().writeAll` / `finish` → `recv().read` / `readToEnd` |
| Path type | yes | `Connection.paths()` → `PathSnapshot.isIp` / `isRelay` / `isSelected` / `rttMs` |
| Path watch | **broken in 1.1.0** | `watchPaths` panics (no Tokio reactor). **Workaround:** poll `paths()` every 1s (hello-iroh pattern). See [Launch crash fix](#launch-crash-fix). |

Path introspection for direct/relayed is available via snapshots; only the push-style watcher is unusable until iroh-ffi fixes spawn-on-reactor.

### Build caveats (from official Swift guide)

- Package links **Network.framework**; project also passes `-framework Network`.
- **Enable Previews = NO** (Xcode 16+ SwiftUICore restriction with SPM).
- First SPM resolve downloads a large prebuilt **xcframework** zip from the GitHub release.
- `EndpointId` string form is **64-char hex** (same as JS 1.1.0).

## Layout

```text
ios-probe/
  README.md
  .gitignore
  IrohProbe.xcodeproj/
  IrohProbe/
    IrohProbeApp.swift
    ContentView.swift
    ProbeModel.swift
    Info.plist
```

## Acceptance checklist

- [x] App installs on **fanzzzd** without opening Xcode GUI  
- [ ] With host running + phone on **cellular only**, Connect succeeds  
- [ ] Path type and live updates visible  
- [ ] Ping ×20 and Throughput 10MB complete without crash  

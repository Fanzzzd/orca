# @orca/expo-iroh usage

Dumb byte-message pipe over Iroh. JS supplies opaque E2EE frames; native only
frames them (4-byte big-endian u32 length + payload, max 1 MiB) on a single
long-lived bi-stream per connection.

**ALPN:** `orca-mobile-rpc/1`  
**Platforms:** iOS (IrohLib 1.1.0). Android methods reject with
`iroh_android_not_implemented`.

## Install (already wired in mobile/)

```json
"@orca/expo-iroh": "file:./packages/expo-iroh"
```

Requires a **dev client** rebuild after adding the package. First `pod install`
runs the podspec `prepare_command` to fetch IrohLib 1.1.0 into `ios/Vendor/`
(xcframework + UniFFI Swift bindings; gitignored).

## API

```ts
import {
  irohStart,
  irohConnect,
  irohSend,
  irohPathInfo,
  irohClose,
  irohStop,
  onIrohMessage,
  onIrohPathChanged,
  onIrohClosed
} from '@orca/expo-iroh'

// 1. Bind local endpoint (idempotent)
const { endpointId } = await irohStart()

// 2. Dial desktop by its 64-hex EndpointId
const { connectionId } = await irohConnect(desktopEndpointId)

// 3. Events
const unsubMsg = onIrohMessage(({ connectionId, bytesBase64 }) => {
  // decode base64 → existing E2EE frame handler
})
const unsubPath = onIrohPathChanged(({ pathType, detail }) => {
  // 'direct' | 'relayed' | 'mixed' | 'unknown'
})
const unsubClosed = onIrohClosed(({ connectionId, reason }) => {
  // reconnect logic
})

// 4. Send opaque payload (base64 of raw bytes)
await irohSend(connectionId, Buffer.from(frame).toString('base64'))

// 5. Optional path snapshot (polls paths(); never watchPaths — iroh-ffi#277)
const { pathType, detail } = await irohPathInfo(connectionId)

// 6. Teardown
await irohClose(connectionId)
await irohStop()
unsubMsg.remove()
unsubPath.remove()
unsubClosed.remove()
```

## How to try it (end-to-end)

Iroh is **on by default** on both ends — there is no experimental flag.
`ORCA_DISABLE_IROH=1` on desktop is the emergency kill switch (also set globally
in vitest so tests never open real UDP).

1. **Pair:** generate the mobile pairing QR. Offers always include
   `iroh: { endpointId }` (64-char hex) once the endpoint binds. Desktop **Iroh**
   pairing option = iroh present, no relay block (primary off-LAN path, no
   address selection).
2. **Phone (iOS dev client):** just scan — re-pair once so the host record
   stores `iroh.endpointId`.
3. **Path order:** LAN and Iroh **race at connect** (LAN wins ties). Relay remains
   fallback when credentials exist. Cards show `Iroh` / “Iroh attempting…” /
   “Iroh failed: …”.
4. **Liveness:** shared `status.get` probe (~20s) on iroh (desktop idle reap 30s).

## Troubleshooting

Filter device logs with **`[iroh]`** (candidate / dial_begin / irohStart_ok /
irohConnect_ok / dial_fail / path_changed / session_closed).

| Symptom | Check |
| --- | --- |
| `candidate … no_iroh_endpoint_id` | Re-pair (offer must include endpointId; desktop must not run with ORCA_DISABLE_IROH=1) |
| `irohStart_or_connect_err` / `native_module_unavailable` | Need custom dev client with ExpoIroh (not Expo Go); rebuild app |
| All paths fail immediately on **cellular only** | **iOS Wireless Data gate:** Settings → Orca (or throwaway install) → **Wireless Data** → **WLAN & Cellular**. Newly installed apps can be Cellular-off; the OS blocks *all* sockets and we cannot detect it reliably. Immediate “network unreachable” on LAN + iroh is a strong hint. |
| LAN works, cellular never dials iroh | Confirm logs show `dial_begin` within ~1s of open; if only `supervisor_*` later, you are on an old build |

## Notes

- Path updates emit ~every 2s only when the snapshot changes. Do **not** call
  `Connection.watchPaths` — it panics off-Tokio (iroh-ffi#277).
- Module does no auth; transport layer owns pairing/E2EE.
- Android methods reject with `iroh_android_not_implemented` (compile stub only).

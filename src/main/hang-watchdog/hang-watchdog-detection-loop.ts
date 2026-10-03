export type HangWatchdogDetectionLoopConfig = {
  timeoutMs: number
  checkIntervalMs: number
  /** Monotonic clock in ms; on macOS it stops while the system sleeps. */
  now: () => number
  /** Wall clock in ms; keeps running through system sleep. */
  wallNow: () => number
  onHangDetected: (unresponsiveMs: number) => void
  /** Heartbeats resumed after a detected hang — the main thread was stalled, not deadlocked. */
  onHangResolved: (unresponsiveMs: number) => void
}

export type HangWatchdogDetectionLoop = {
  recordHeartbeat: () => void
  tick: () => void
}

export function createHangWatchdogDetectionLoop(
  config: HangWatchdogDetectionLoopConfig
): HangWatchdogDetectionLoop {
  let lastHeartbeatAt = config.now()
  let lastTickAt = config.now()
  let lastTickWallAt = config.wallNow()
  let detected = false
  return {
    recordHeartbeat: () => {
      const now = config.now()
      if (detected) {
        detected = false
        config.onHangResolved(now - lastHeartbeatAt)
      }
      lastHeartbeatAt = now
    },
    tick: () => {
      const now = config.now()
      const wallNow = config.wallNow()
      // Why two clocks: only the wall clock runs through system sleep, so their difference is time
      // asleep. A long tick gap alone is not sleep: App Nap delays a background app's timers too.
      const sleptMs = wallNow - lastTickWallAt - (now - lastTickAt)
      lastTickAt = now
      lastTickWallAt = wallNow
      if (detected) {
        return
      }
      if (sleptMs > config.checkIntervalMs) {
        lastHeartbeatAt = now
        return
      }
      const unresponsiveMs = now - lastHeartbeatAt
      if (unresponsiveMs > config.timeoutMs) {
        detected = true
        config.onHangDetected(unresponsiveMs)
      }
    }
  }
}

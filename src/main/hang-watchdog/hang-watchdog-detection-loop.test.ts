import { describe, expect, it, vi } from 'vitest'
import { createHangWatchdogDetectionLoop } from './hang-watchdog-detection-loop'

const TIMEOUT_MS = 45_000
const CHECK_INTERVAL_MS = 5_000

function loopWithClock(startAt = 0) {
  let now = startAt
  let wallNow = startAt
  const onHangDetected = vi.fn()
  const onHangResolved = vi.fn()
  const loop = createHangWatchdogDetectionLoop({
    timeoutMs: TIMEOUT_MS,
    checkIntervalMs: CHECK_INTERVAL_MS,
    now: () => now,
    wallNow: () => wallNow,
    onHangDetected,
    onHangResolved
  })
  const advance = (ms: number): void => {
    now += ms
    wallNow += ms
  }
  // System sleep: only the wall clock moves.
  const sleep = (ms: number): void => {
    wallNow += ms
  }
  return { loop, onHangDetected, onHangResolved, advance, sleep }
}

describe('createHangWatchdogDetectionLoop', () => {
  it('does not fire while heartbeats keep arriving', () => {
    const { loop, onHangDetected, advance } = loopWithClock()
    for (let i = 0; i < 100; i++) {
      advance(CHECK_INTERVAL_MS)
      loop.recordHeartbeat()
      loop.tick()
    }
    expect(onHangDetected).not.toHaveBeenCalled()
  })

  it('fires once when heartbeats stop for longer than the timeout', () => {
    const { loop, onHangDetected, advance } = loopWithClock()
    loop.recordHeartbeat()
    for (let i = 0; i < 12; i++) {
      advance(CHECK_INTERVAL_MS)
      loop.tick()
    }
    expect(onHangDetected).toHaveBeenCalledTimes(1)
    advance(CHECK_INTERVAL_MS)
    loop.tick()
    expect(onHangDetected).toHaveBeenCalledTimes(1)
  })

  // Why: the breadcrumb reports observed silence, so it must be the measured gap at the firing
  // tick (the first one strictly past the timeout), not the timeout constant.
  it('reports the measured stall duration, not the timeout', () => {
    const { loop, onHangDetected, advance } = loopWithClock()
    loop.recordHeartbeat()
    for (let i = 0; i < 12; i++) {
      advance(CHECK_INTERVAL_MS)
      loop.tick()
    }
    expect(onHangDetected).toHaveBeenCalledWith(50_000)
  })

  it('does not fire at exactly the timeout boundary', () => {
    const { loop, onHangDetected, advance } = loopWithClock()
    loop.recordHeartbeat()
    for (let i = 0; i < 9; i++) {
      advance(CHECK_INTERVAL_MS)
      loop.tick()
    }
    expect(onHangDetected).not.toHaveBeenCalled()
  })

  it('treats wall-clock time the monotonic clock missed as system sleep and restarts the wait', () => {
    const { loop, onHangDetected, advance, sleep } = loopWithClock()
    loop.recordHeartbeat()
    advance(CHECK_INTERVAL_MS)
    loop.tick()
    sleep(TIMEOUT_MS * 4)
    advance(CHECK_INTERVAL_MS)
    loop.tick()
    expect(onHangDetected).not.toHaveBeenCalled()
    // A responsive parent resumes heartbeats after wake; the loop must fire only after a fresh full timeout of silence.
    for (let i = 0; i < 9; i++) {
      advance(CHECK_INTERVAL_MS)
      loop.tick()
    }
    expect(onHangDetected).not.toHaveBeenCalled()
    for (let i = 0; i < 3; i++) {
      advance(CHECK_INTERVAL_MS)
      loop.tick()
    }
    expect(onHangDetected).toHaveBeenCalledTimes(1)
  })

  // Why: App Nap stretches a background app's timers; the stall under them is still a stall.
  it('still fires when the check timer itself runs late while awake', () => {
    const { loop, onHangDetected, advance } = loopWithClock()
    loop.recordHeartbeat()
    advance(TIMEOUT_MS + CHECK_INTERVAL_MS)
    loop.tick()
    expect(onHangDetected).toHaveBeenCalledWith(TIMEOUT_MS + CHECK_INTERVAL_MS)
  })

  // Why: this is the measurement the whole PR exists for — a stall that clears would have been a
  // destructive kill under the SIGKILL design, so it has to be counted separately.
  it('reports resolution when heartbeats resume after a detected hang', () => {
    const { loop, onHangDetected, onHangResolved, advance } = loopWithClock()
    loop.recordHeartbeat()
    for (let i = 0; i < 12; i++) {
      advance(CHECK_INTERVAL_MS)
      loop.tick()
    }
    expect(onHangDetected).toHaveBeenCalledTimes(1)
    advance(CHECK_INTERVAL_MS)
    loop.recordHeartbeat()
    expect(onHangResolved).toHaveBeenCalledTimes(1)
    expect(onHangResolved).toHaveBeenCalledWith(13 * CHECK_INTERVAL_MS)
  })

  it('does not report resolution when no hang was ever detected', () => {
    const { loop, onHangResolved, advance } = loopWithClock()
    for (let i = 0; i < 5; i++) {
      advance(CHECK_INTERVAL_MS)
      loop.recordHeartbeat()
      loop.tick()
    }
    expect(onHangResolved).not.toHaveBeenCalled()
  })

  it('can detect a second hang after the first one resolved', () => {
    const { loop, onHangDetected, onHangResolved, advance } = loopWithClock()
    loop.recordHeartbeat()
    for (let i = 0; i < 12; i++) {
      advance(CHECK_INTERVAL_MS)
      loop.tick()
    }
    advance(CHECK_INTERVAL_MS)
    loop.recordHeartbeat()
    expect(onHangResolved).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 12; i++) {
      advance(CHECK_INTERVAL_MS)
      loop.tick()
    }
    expect(onHangDetected).toHaveBeenCalledTimes(2)
  })
})

import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import { createHangWatchdogDetectionLoop } from './hang-watchdog-detection-loop'
import { writeHangDetectionMarker } from './hang-detection-marker'
import { captureMainThreadStack } from './main-thread-stack-capture'
import type {
  HangWatchdogWorkerData,
  MainToHangWatchdogWorkerMessage
} from './hang-watchdog-worker-protocol'

type HangWatchdogPort = {
  on: (event: 'message', listener: (message: MainToHangWatchdogWorkerMessage) => void) => unknown
  close: () => void
}

// Why bounded: each attempt opens an inspector session the blocked main thread must later drain.
const MAX_STACK_CAPTURE_ATTEMPTS = 3

type Stall = {
  unresponsiveMs: number
  selfRecovered: boolean
  mainThreadStack: string[] | null
  stackCaptureAttempts: number
}

// Observation only: a false positive must never kill a live main thread mid-write.
export function recordHangObservation(options: {
  parentPid: number
  markerPath: string
  unresponsiveMs: number
  selfRecovered: boolean
  mainThreadStack?: string[] | null
  stackCaptureAttempts?: number
}): void {
  if (!options.markerPath) {
    return
  }
  try {
    writeHangDetectionMarker(options.markerPath, {
      detectedAt: Date.now(),
      parentPid: options.parentPid,
      unresponsiveMs: options.unresponsiveMs,
      selfRecovered: options.selfRecovered,
      ...(options.mainThreadStack ? { mainThreadStack: options.mainThreadStack } : {}),
      ...(options.stackCaptureAttempts
        ? { stackCaptureAttempts: options.stackCaptureAttempts }
        : {})
    })
  } catch {
    // Why: telemetry is best-effort; a marker that cannot be written must not take down the watchdog.
  }
}

export function runWatchdog(
  config: HangWatchdogWorkerData,
  port: HangWatchdogPort | null = parentPort,
  captureStack: () => Promise<string[] | null> = captureMainThreadStack
): void {
  if (!port) {
    return
  }
  let stall: Stall | null = null
  const record = (observed: Stall): void =>
    recordHangObservation({
      parentPid: config.parentPid,
      markerPath: config.markerPath,
      ...observed
    })
  const loop = createHangWatchdogDetectionLoop({
    timeoutMs: config.timeoutMs,
    checkIntervalMs: config.checkIntervalMs,
    now: () => performance.now(),
    wallNow: () => Date.now(),
    onHangDetected: (unresponsiveMs) => {
      const current: Stall = {
        unresponsiveMs,
        selfRecovered: false,
        mainThreadStack: null,
        stackCaptureAttempts: 0
      }
      stall = current
      record(current)
      // Why: the duration says a stall happened; only the stack says where. Retry because a main
      // thread blocked in native code ignores Debugger.pause but may re-enter JS mid-stall.
      const attempt = (): void => {
        current.stackCaptureAttempts += 1
        void captureStack().then((mainThreadStack) => {
          if (stall !== current || current.selfRecovered) {
            return
          }
          current.mainThreadStack = mainThreadStack
          if (!mainThreadStack && current.stackCaptureAttempts < MAX_STACK_CAPTURE_ATTEMPTS) {
            setTimeout(attempt, config.checkIntervalMs)
          }
          record(current)
        })
      }
      attempt()
    },
    // Why: rewriting the marker keeps one observation per stall rather than two rows to reconcile.
    onHangResolved: (unresponsiveMs) => {
      if (stall) {
        stall.unresponsiveMs = unresponsiveMs
        stall.selfRecovered = true
        record(stall)
      }
    }
  })

  let checkTimer: ReturnType<typeof setInterval> | null = setInterval(
    () => loop.tick(),
    config.checkIntervalMs
  )
  port.on('message', (message: MainToHangWatchdogWorkerMessage) => {
    if (message.type === 'heartbeat') {
      loop.recordHeartbeat()
    } else if (message.type === 'shutdown') {
      if (checkTimer) {
        clearInterval(checkTimer)
        checkTimer = null
      }
      port.close()
    }
  })
}

export function isHangWatchdogWorkerData(value: unknown): value is HangWatchdogWorkerData {
  const data = value as Partial<HangWatchdogWorkerData> | null
  return (
    !!data &&
    Number.isInteger(data.parentPid) &&
    (data.parentPid ?? 0) > 0 &&
    typeof data.markerPath === 'string' &&
    Number.isFinite(data.timeoutMs) &&
    (data.timeoutMs ?? 0) > 0 &&
    Number.isFinite(data.checkIntervalMs) &&
    (data.checkIntervalMs ?? 0) > 0
  )
}

if (!isMainThread && isHangWatchdogWorkerData(workerData)) {
  runWatchdog(workerData)
}

import { pbkdf2 } from 'node:crypto'

export const THREADPOOL_WAITER_REFRESH_MS = 60_000
// Long enough (~1 ms) that a woken worker is still busy when the next job is posted.
const REFRESH_JOB_ITERATIONS = 10_000

type RefreshJob = (done: () => void) => void

const runRefreshJob: RefreshJob = (done) =>
  pbkdf2('orca', 'threadpool-waiter-refresh', REFRESH_JOB_ITERATIONS, 16, 'sha256', () => done())

/** Mirrors libuv's init_threads(): atoi, 0 becomes 1, capped at 1024. */
export function libuvThreadpoolSize(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.UV_THREADPOOL_SIZE
  if (raw === undefined) {
    return 4
  }
  const parsed = Number.parseInt(raw, 10)
  return Math.min(Math.max(Number.isFinite(parsed) ? parsed : 0, 1), 1024)
}

/**
 * Darwin's psynch condvar stops waking a libuv worker that stayed parked through ~2^23 waits of
 * its siblings (libuv#5280): every later uv_cond_signal is a no-op, so fs work queues forever
 * while timers and sockets still run. Posting one job per worker wakes every parked worker, which
 * re-parks it at the current generation long before it can fall half the sequence range behind.
 */
export function startThreadpoolWaiterRefresh(
  options: {
    platform?: NodeJS.Platform
    threads?: number
    intervalMs?: number
    runJob?: RefreshJob
  } = {}
): () => void {
  if ((options.platform ?? process.platform) !== 'darwin') {
    return () => {}
  }
  const threads = options.threads ?? libuvThreadpoolSize()
  const runJob = options.runJob ?? runRefreshJob
  let outstanding = 0
  const refresh = (): void => {
    // A pool that has not finished the last round is already stuck or saturated; never pile on.
    if (outstanding > 0) {
      return
    }
    outstanding = threads
    for (let i = 0; i < threads; i++) {
      runJob(() => {
        outstanding -= 1
      })
    }
  }
  const timer = setInterval(refresh, options.intervalMs ?? THREADPOOL_WAITER_REFRESH_MS)
  timer.unref()
  return () => clearInterval(timer)
}

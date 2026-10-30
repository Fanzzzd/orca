import { afterEach, describe, expect, it, vi } from 'vitest'
import { libuvThreadpoolSize, startThreadpoolWaiterRefresh } from './threadpool-waiter-refresh'

afterEach(() => vi.useRealTimers())

describe('threadpool waiter refresh', () => {
  it('posts one job per worker each interval so every parked worker wakes', async () => {
    vi.useFakeTimers()
    const runJob = vi.fn((done: () => void) => done())
    const stop = startThreadpoolWaiterRefresh({
      platform: 'darwin',
      threads: 4,
      intervalMs: 1_000,
      runJob
    })
    await vi.advanceTimersByTimeAsync(3_000)
    expect(runJob).toHaveBeenCalledTimes(12)
    stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('adds no work to a pool that has not finished the previous round', async () => {
    vi.useFakeTimers()
    const finish: (() => void)[] = []
    const runJob = vi.fn((done: () => void) => void finish.push(done))
    const stop = startThreadpoolWaiterRefresh({
      platform: 'darwin',
      threads: 2,
      intervalMs: 1_000,
      runJob
    })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(runJob).toHaveBeenCalledTimes(2)
    finish[0]()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(runJob).toHaveBeenCalledTimes(2)
    finish[1]()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(runJob).toHaveBeenCalledTimes(4)
    stop()
  })

  it('does nothing off macOS', async () => {
    vi.useFakeTimers()
    const runJob = vi.fn()
    startThreadpoolWaiterRefresh({ platform: 'linux', intervalMs: 1_000, runJob })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(runJob).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('sizes the round the way libuv sizes its pool', () => {
    expect(libuvThreadpoolSize({})).toBe(4)
    expect(libuvThreadpoolSize({ UV_THREADPOOL_SIZE: '8' })).toBe(8)
    expect(libuvThreadpoolSize({ UV_THREADPOOL_SIZE: '0' })).toBe(1)
    expect(libuvThreadpoolSize({ UV_THREADPOOL_SIZE: 'x' })).toBe(1)
    expect(libuvThreadpoolSize({ UV_THREADPOOL_SIZE: '5000' })).toBe(1024)
  })
})

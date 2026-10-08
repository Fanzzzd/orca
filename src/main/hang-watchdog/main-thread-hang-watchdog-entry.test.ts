import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { consumeHangDetectionMarker } from './hang-detection-marker'

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(() => ({ unref: vi.fn() }))
}))

vi.mock('node:child_process', () => ({
  spawn: spawnMock
}))

import {
  isHangWatchdogWorkerData,
  recordHangObservation,
  runWatchdog
} from './main-thread-hang-watchdog-entry'

describe('recordHangObservation', () => {
  let dir: string
  let killSpy: ReturnType<typeof vi.spyOn>
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hang-detect-'))
    spawnMock.mockClear()
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
  })

  afterEach(() => {
    killSpy.mockRestore()
    exitSpy.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  })

  it('records an unresolved hang', () => {
    const markerPath = join(dir, 'marker.json')
    recordHangObservation({
      parentPid: 4242,
      markerPath,
      unresponsiveMs: 47_000,
      selfRecovered: false
    })
    expect(consumeHangDetectionMarker(markerPath)).toMatchObject({
      parentPid: 4242,
      unresponsiveMs: 47_000,
      selfRecovered: false
    })
  })

  it('overwrites the marker when the stall clears, keeping one observation per stall', () => {
    const markerPath = join(dir, 'marker.json')
    recordHangObservation({
      parentPid: 4242,
      markerPath,
      unresponsiveMs: 47_000,
      selfRecovered: false
    })
    recordHangObservation({
      parentPid: 4242,
      markerPath,
      unresponsiveMs: 62_000,
      selfRecovered: true
    })
    expect(consumeHangDetectionMarker(markerPath)).toMatchObject({
      unresponsiveMs: 62_000,
      selfRecovered: true
    })
  })

  it('never spawns, signals, or exits', () => {
    // Why: a false positive must never kill a live main thread while writes may be in flight.
    recordHangObservation({
      parentPid: 4242,
      markerPath: join(dir, 'marker.json'),
      unresponsiveMs: 45_000,
      selfRecovered: false
    })
    expect(spawnMock).not.toHaveBeenCalled()
    expect(killSpy).not.toHaveBeenCalled()
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('survives an unwritable marker path', () => {
    expect(() =>
      recordHangObservation({
        parentPid: 4242,
        markerPath: join(dir, 'missing-subdir', 'marker.json'),
        unresponsiveMs: 45_000,
        selfRecovered: false
      })
    ).not.toThrow()
  })

  it('is a no-op when no marker path is configured', () => {
    expect(() =>
      recordHangObservation({
        parentPid: 4242,
        markerPath: '',
        unresponsiveMs: 45_000,
        selfRecovered: false
      })
    ).not.toThrow()
  })
})

describe('watchdog worker entry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('accepts only complete positive worker data', () => {
    expect(
      isHangWatchdogWorkerData({
        parentPid: 42,
        markerPath: '/tmp/marker',
        timeoutMs: 100,
        checkIntervalMs: 25
      })
    ).toBe(true)
    for (const value of [
      null,
      {},
      { parentPid: 0, markerPath: '/tmp/marker', timeoutMs: 100, checkIntervalMs: 25 },
      { parentPid: 42, markerPath: 7, timeoutMs: 100, checkIntervalMs: 25 },
      { parentPid: 42, markerPath: '/tmp/marker', timeoutMs: 0, checkIntervalMs: 25 },
      { parentPid: 42, markerPath: '/tmp/marker', timeoutMs: 100, checkIntervalMs: Infinity }
    ]) {
      expect(isHangWatchdogWorkerData(value)).toBe(false)
    }
  })

  it('routes heartbeats and shuts down its timer and port', () => {
    const markerPath = join(tmpdir(), `hang-watchdog-entry-${process.pid}.json`)
    let onMessage: ((message: { type: 'heartbeat' | 'shutdown' }) => void) | undefined
    const port = {
      on: vi.fn(
        (_event: 'message', listener: (message: { type: 'heartbeat' | 'shutdown' }) => void) => {
          onMessage = listener
        }
      ),
      close: vi.fn()
    }
    try {
      runWatchdog(
        {
          parentPid: process.pid,
          markerPath,
          timeoutMs: 100,
          checkIntervalMs: 25
        },
        port,
        async () => null
      )
      vi.advanceTimersByTime(75)
      onMessage?.({ type: 'heartbeat' })
      vi.advanceTimersByTime(75)
      expect(consumeHangDetectionMarker(markerPath)).toBeNull()
      vi.advanceTimersByTime(50)
      expect(consumeHangDetectionMarker(markerPath)).toMatchObject({ selfRecovered: false })

      onMessage?.({ type: 'heartbeat' })
      expect(consumeHangDetectionMarker(markerPath)).toMatchObject({ selfRecovered: true })
      onMessage?.({ type: 'shutdown' })
      expect(port.close).toHaveBeenCalledOnce()
      vi.advanceTimersByTime(1_000)
      expect(port.close).toHaveBeenCalledOnce()
      expect(consumeHangDetectionMarker(markerPath)).toBeNull()
    } finally {
      rmSync(markerPath, { force: true })
    }
  })

  it('adds the stuck main thread stack to the marker and keeps it once the stall clears', async () => {
    const markerPath = join(tmpdir(), `hang-watchdog-stack-${process.pid}.json`)
    let onMessage: ((message: { type: 'heartbeat' | 'shutdown' }) => void) | undefined
    const port = {
      on: vi.fn(
        (_event: 'message', listener: (message: { type: 'heartbeat' | 'shutdown' }) => void) => {
          onMessage = listener
        }
      ),
      close: vi.fn()
    }
    try {
      runWatchdog(
        { parentPid: process.pid, markerPath, timeoutMs: 100, checkIntervalMs: 25 },
        port,
        async () => ['spin out/main/index.js:1:42 | while(true){await x}']
      )
      await vi.advanceTimersByTimeAsync(150)
      onMessage?.({ type: 'heartbeat' })
      expect(consumeHangDetectionMarker(markerPath)).toMatchObject({
        selfRecovered: true,
        mainThreadStack: ['spin out/main/index.js:1:42 | while(true){await x}']
      })
      onMessage?.({ type: 'shutdown' })
    } finally {
      rmSync(markerPath, { force: true })
    }
  })

  it('retries the stack read while the stall lasts and records how many reads it tried', async () => {
    const markerPath = join(tmpdir(), `hang-watchdog-retry-${process.pid}.json`)
    const port = { on: vi.fn(), close: vi.fn() }
    const captureStack = vi
      .fn<() => Promise<string[] | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue(['spin out/main/index.js:1:42 | spin()'])
    try {
      runWatchdog(
        { parentPid: process.pid, markerPath, timeoutMs: 100, checkIntervalMs: 25 },
        port,
        captureStack
      )
      await vi.advanceTimersByTimeAsync(300)
      expect(captureStack).toHaveBeenCalledTimes(3)
      expect(consumeHangDetectionMarker(markerPath)).toMatchObject({
        stackCaptureAttempts: 3,
        mainThreadStack: ['spin out/main/index.js:1:42 | spin()']
      })
    } finally {
      rmSync(markerPath, { force: true })
    }
  })

  it('stops after three failed stack reads', async () => {
    const markerPath = join(tmpdir(), `hang-watchdog-giveup-${process.pid}.json`)
    const port = { on: vi.fn(), close: vi.fn() }
    const captureStack = vi.fn(async () => null)
    try {
      runWatchdog(
        { parentPid: process.pid, markerPath, timeoutMs: 100, checkIntervalMs: 25 },
        port,
        captureStack
      )
      await vi.advanceTimersByTimeAsync(500)
      expect(captureStack).toHaveBeenCalledTimes(3)
      const marker = consumeHangDetectionMarker(markerPath)
      expect(marker).toMatchObject({ stackCaptureAttempts: 3 })
      expect(marker?.mainThreadStack).toBeUndefined()
    } finally {
      rmSync(markerPath, { force: true })
    }
  })
})

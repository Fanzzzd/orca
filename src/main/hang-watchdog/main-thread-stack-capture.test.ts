import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureMainThreadStack, type InspectorSession } from './main-thread-stack-capture'

type Paused = Parameters<Parameters<InspectorSession['on']>[1]>[0]

function fakeSession(pauseWith: Paused | null) {
  const posted: string[] = []
  let onPaused: ((message: Paused) => void) | null = null
  const session: InspectorSession = {
    post(method, _params, callback) {
      posted.push(method)
      if (method === 'Debugger.getScriptSource') {
        callback(null, { scriptSource: `header\n${'x'.repeat(100)}while(spin){await tick}` })
        return
      }
      callback(null, {})
      if (method === 'Debugger.pause' && pauseWith) {
        onPaused?.(pauseWith)
      }
    },
    on(_event, listener) {
      onPaused = listener
    },
    disconnect: vi.fn()
  }
  return { session, posted }
}

const spinning: Paused = {
  params: {
    callFrames: [
      {
        functionName: 'drain',
        url: 'file:///app/out/main/index.js',
        location: { scriptId: '7', lineNumber: 1, columnNumber: 100 }
      }
    ]
  }
}

describe('captureMainThreadStack', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('names each paused frame with a source excerpt, then resumes and disconnects', async () => {
    const { session, posted } = fakeSession(spinning)
    const stack = await captureMainThreadStack(() => session)
    expect(stack).toHaveLength(1)
    expect(stack?.[0]).toMatch(
      /^drain file:\/\/\/app\/out\/main\/index\.js:2:101 \| x+while\(spin\)/
    )
    await vi.runAllTimersAsync()
    expect(posted).toContain('Debugger.resume')
    expect(session.disconnect).toHaveBeenCalledOnce()
  })

  it('gives up and disconnects when the main thread never pauses', async () => {
    const { session } = fakeSession(null)
    const result = captureMainThreadStack(() => session)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(await result).toBeNull()
    expect(session.disconnect).toHaveBeenCalledOnce()
  })

  it('returns null when the inspector cannot connect', async () => {
    const stack = await captureMainThreadStack(() => {
      throw new Error('not in a worker')
    })
    expect(stack).toBeNull()
  })
})

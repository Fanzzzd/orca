import { Session, type Debugger } from 'node:inspector'

const CAPTURE_TIMEOUT_MS = 3_000
const MAX_FRAMES = 12
// Why an excerpt: packaged main is minified, so names and positions alone don't identify code.
const EXCERPT_RADIUS = 60

type PausedFrame = Pick<Debugger.CallFrame, 'functionName' | 'url' | 'location'>

export type InspectorSession = {
  post(
    method: string,
    params: object,
    callback: (error: Error | null, result?: object) => void
  ): void
  on(
    event: 'Debugger.paused',
    listener: (message: { params: { callFrames: PausedFrame[] } }) => void
  ): void
  disconnect(): void
}

function post(
  session: InspectorSession,
  method: string,
  params: object = {}
): Promise<object | null> {
  return new Promise((resolve) => {
    session.post(method, params, (error, result) => resolve(error ? null : (result ?? {})))
  })
}

function excerpt(source: string, line: number, column: number): string {
  const text = source.split('\n')[line] ?? ''
  return text.slice(Math.max(0, column - EXCERPT_RADIUS), column + EXCERPT_RADIUS)
}

async function describeFrames(session: InspectorSession, frames: PausedFrame[]): Promise<string[]> {
  const sources = new Map<string, Promise<string>>()
  const sourceOf = (scriptId: string): Promise<string> => {
    let source = sources.get(scriptId)
    if (!source) {
      source = post(session, 'Debugger.getScriptSource', { scriptId }).then((result) =>
        result && 'scriptSource' in result && typeof result.scriptSource === 'string'
          ? result.scriptSource
          : ''
      )
      sources.set(scriptId, source)
    }
    return source
  }
  return Promise.all(
    frames.slice(0, MAX_FRAMES).map(async (frame) => {
      const { lineNumber, columnNumber = 0 } = frame.location
      const where = `${frame.functionName || '(anonymous)'} ${frame.url}:${lineNumber + 1}:${columnNumber + 1}`
      return `${where} | ${excerpt(await sourceOf(frame.location.scriptId), lineNumber, columnNumber)}`
    })
  )
}

/**
 * Pauses the main thread's JS for one stack read, then resumes it. Only works from a worker; a main
 * thread stuck in native code never pauses, so this gives up after a timeout and returns null.
 */
export function captureMainThreadStack(
  connect: () => InspectorSession = () => {
    const session = new Session()
    session.connectToMainThread()
    return session
  }
): Promise<string[] | null> {
  let session: InspectorSession
  try {
    session = connect()
  } catch {
    return Promise.resolve(null)
  }
  return new Promise((resolve) => {
    let settled = false
    const finish = (stack: string[] | null): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      // Why disconnect last: it drops the debugger, so a pause that lands late cannot stick.
      void post(session, 'Debugger.resume').finally(() => session.disconnect())
      resolve(stack)
    }
    const timer = setTimeout(() => finish(null), CAPTURE_TIMEOUT_MS)
    session.on('Debugger.paused', (message) => {
      void describeFrames(session, message.params.callFrames).then(finish, () => finish(null))
    })
    void post(session, 'Debugger.enable').then(() => post(session, 'Debugger.pause'))
  })
}

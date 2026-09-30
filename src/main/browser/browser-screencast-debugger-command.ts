import type { WebContents } from 'electron'

const DEBUGGER_COMMAND_TIMEOUT_MS = 8_000

export async function sendDebuggerCommand(
  dbg: WebContents['debugger'],
  method: string,
  params: Record<string, unknown> = {},
  sessionId?: string
): Promise<unknown> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      Promise.resolve().then(() =>
        sessionId === undefined
          ? dbg.sendCommand(method, params)
          : dbg.sendCommand(method, params, sessionId)
      ),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Timed out while running ${method}.`))
        }, DEBUGGER_COMMAND_TIMEOUT_MS)
      })
    ])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}

import type { WebContents } from 'electron'
import type { OffscreenPageUserInput } from '../../shared/offscreen-page-protocol'
import { acquireElectronDebugger } from './electron-debugger-lease'
import { sendDebuggerCommand } from './browser-screencast-debugger-command'

/**
 * Replays one user input event into an offscreen page. Pointer and key events go through
 * sendInputEvent, which Chromium treats as trusted; IME composition has no sendInputEvent form, so
 * it rides the page's own debugger. Neither path can move the host window's focus, because an
 * offscreen WebContents has no native view to take it.
 */
export async function dispatchOffscreenPageUserInput(
  target: WebContents,
  input: OffscreenPageUserInput,
  acquireDebugger: typeof acquireElectronDebugger = acquireElectronDebugger
): Promise<void> {
  if (target.isDestroyed()) {
    return
  }
  switch (input.kind) {
    case 'mouse':
      target.sendInputEvent({
        type: input.type,
        x: Math.round(input.x),
        y: Math.round(input.y),
        button: input.button,
        clickCount: input.clickCount,
        modifiers: input.modifiers
      })
      return
    case 'wheel':
      target.sendInputEvent({
        type: 'mouseWheel',
        x: Math.round(input.x),
        y: Math.round(input.y),
        deltaX: input.deltaX,
        deltaY: input.deltaY,
        modifiers: input.modifiers
      })
      return
    case 'key':
      target.sendInputEvent({
        type: input.type,
        keyCode: input.keyCode,
        modifiers: input.modifiers
      })
      return
    case 'compose':
      return sendThroughDebugger(target, acquireDebugger, 'Input.imeSetComposition', {
        text: input.text,
        selectionStart: input.selectionStart,
        selectionEnd: input.selectionEnd
      })
    case 'commit':
      return sendThroughDebugger(target, acquireDebugger, 'Input.insertText', { text: input.text })
    case 'cancelComposition':
      // Why: an empty composition clears the page's underlined preedit without inserting text.
      return sendThroughDebugger(target, acquireDebugger, 'Input.imeSetComposition', {
        text: '',
        selectionStart: 0,
        selectionEnd: 0
      })
  }
}

async function sendThroughDebugger(
  target: WebContents,
  acquireDebugger: typeof acquireElectronDebugger,
  method: string,
  params: Record<string, unknown>
): Promise<void> {
  const lease = acquireDebugger(target)
  try {
    await sendDebuggerCommand(target.debugger, method, params)
  } finally {
    lease.release()
  }
}

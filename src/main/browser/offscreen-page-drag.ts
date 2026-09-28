import type { WebContents } from 'electron'
import type { OffscreenPageFileDrop } from '../../shared/offscreen-page-protocol'
import { sendDebuggerCommand } from './browser-screencast-debugger-command'
import { acquireElectronDebugger, type ElectronDebuggerLease } from './electron-debugger-lease'

type DragData = Record<string, unknown>

export type OffscreenPageDragBridge = {
  /**
   * Replays OS files dropped on the host element. File paths only exist at drop time, so the page
   * sees enter, over and drop together at the drop point.
   */
  dropFiles(drop: OffscreenPageFileDrop): Promise<void>
  dispose(): void
}

/**
 * Carries HTML drag-and-drop for an offscreen page. Chromium starts a drag by handing it to the
 * native view, and an offscreen page has none, so the drag would die at dragstart. With drag
 * interception on, Chromium hands the drag data to Orca instead, and later pointer input, from the
 * user or an agent alike, is replayed as drag events until the button comes up.
 */
export function createOffscreenPageDragBridge(
  contents: WebContents,
  acquireDebugger: typeof acquireElectronDebugger = acquireElectronDebugger
): OffscreenPageDragBridge {
  let lease: ElectronDebuggerLease | null = null
  let drag: { data: DragData; entered: boolean } | null = null
  let disposed = false

  const dispatch = (params: Record<string, unknown>): Promise<unknown> =>
    lease && !contents.isDestroyed()
      ? sendDebuggerCommand(contents.debugger, 'Input.dispatchDragEvent', params).catch(() => {})
      : Promise.resolve()
  const send = (params: Record<string, unknown>): void => void dispatch(params)
  const onMessage = (_event: unknown, method: string, params: unknown): void => {
    if (method === 'Input.dragIntercepted' && isRecord(params) && isRecord(params.data)) {
      drag = { data: params.data, entered: false }
    }
  }
  const onDetach = (): void => {
    lease?.release()
    lease = null
    drag = null
  }
  const onInput = (_event: unknown, input: unknown): void => {
    // Why: interception lives on the debugger session; re-arm on the next input after a detach.
    arm()
    if (!drag || !isRecord(input) || typeof input.type !== 'string') {
      return
    }
    const x = typeof input.x === 'number' ? input.x : 0
    const y = typeof input.y === 'number' ? input.y : 0
    const { data } = drag
    if (input.type === 'mouseMove') {
      if (!drag.entered) {
        drag.entered = true
        send({ type: 'dragEnter', x, y, data })
      }
      send({ type: 'dragOver', x, y, data })
    } else if (input.type === 'mouseUp') {
      drag = null
      send({ type: 'drop', x, y, data })
    } else if (
      input.type === 'mouseLeave' ||
      (input.type === 'rawKeyDown' && input.key === 'Escape')
    ) {
      drag = null
      send({ type: 'dragCancel', x, y, data })
    }
  }

  function arm(): void {
    if (disposed || lease || contents.isDestroyed()) {
      return
    }
    try {
      lease = acquireDebugger(contents)
    } catch {
      // DevTools owns the session; drags stay native-only until it lets go.
      return
    }
    void sendDebuggerCommand(contents.debugger, 'Input.setInterceptDrags', { enabled: true }).catch(
      () => {}
    )
  }

  contents.debugger.on('message', onMessage)
  contents.debugger.on('detach', onDetach)
  contents.on('input-event', onInput)
  arm()

  return {
    async dropFiles(drop) {
      arm()
      const x = Math.round(drop.x)
      const y = Math.round(drop.y)
      // Why mask 1 (copy): that is what an OS file drop offers a page.
      const data = { items: [], files: drop.files, dragOperationsMask: 1 }
      for (const type of ['dragEnter', 'dragOver', 'drop']) {
        await dispatch({ type, x, y, data })
      }
    },
    dispose() {
      disposed = true
      drag = null
      if (!contents.isDestroyed()) {
        contents.debugger.off('message', onMessage)
        contents.debugger.off('detach', onDetach)
        contents.off('input-event', onInput)
      }
      lease?.release()
      lease = null
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

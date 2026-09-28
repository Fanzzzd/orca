import { ipcRenderer, sharedTexture } from 'electron'
import type {
  OffscreenPageCaret,
  OffscreenPageCommand,
  OffscreenPageGuestEvent,
  OffscreenPageUserInput,
  OffscreenPageViewport
} from '../../shared/offscreen-page-protocol'

export type OffscreenPageListeners = {
  onEvent: (event: OffscreenPageGuestEvent) => void
  onCursor: (cursorType: string) => void
}

export type OffscreenPageApi = {
  /** Returns the page's WebContents id, or null when main refused the partition or URL. */
  create(args: {
    browserPageId: string
    partition: string
    src: string
    viewport: OffscreenPageViewport
  }): Promise<number | null>
  /** Frames for this page are drawn straight into `canvas`; VideoFrames can't cross the context bridge. */
  attach(browserPageId: string, canvas: HTMLCanvasElement, listeners: OffscreenPageListeners): void
  detach(browserPageId: string): void
  setViewport(browserPageId: string, viewport: OffscreenPageViewport): void
  input(browserPageId: string, input: OffscreenPageUserInput): void
  command(browserPageId: string, command: OffscreenPageCommand): void
  focus(browserPageId: string): void
  readCaret(browserPageId: string): Promise<OffscreenPageCaret | null>
  close(browserPageId: string): void
}

type Attachment = {
  canvas: HTMLCanvasElement
  context: CanvasRenderingContext2D | null
  listeners: OffscreenPageListeners
}

const attachments = new Map<string, Attachment>()
let receiverInstalled = false

function installFrameReceiver(): void {
  if (receiverInstalled) {
    return
  }
  receiverInstalled = true
  sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture }, pageId: unknown) => {
    const attachment = typeof pageId === 'string' ? attachments.get(pageId) : undefined
    if (!attachment) {
      importedSharedTexture.release()
      return
    }
    const frame = importedSharedTexture.getVideoFrame()
    try {
      const { canvas } = attachment
      if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
        canvas.width = frame.displayWidth
        canvas.height = frame.displayHeight
        attachment.context = null
      }
      attachment.context ??= canvas.getContext('2d', { alpha: false })
      attachment.context?.drawImage(frame, 0, 0)
    } finally {
      frame.close()
      importedSharedTexture.release()
    }
  })
  ipcRenderer.on('offscreen-page:event', (_e, pageId: string, event: OffscreenPageGuestEvent) => {
    attachments.get(pageId)?.listeners.onEvent(event)
  })
  ipcRenderer.on('offscreen-page:cursor', (_e, pageId: string, cursorType: string) => {
    attachments.get(pageId)?.listeners.onCursor(cursorType)
  })
}

export const offscreenPageApi: OffscreenPageApi = {
  create: (args) => ipcRenderer.invoke('offscreenPage:create', args),
  attach(browserPageId, canvas, listeners) {
    installFrameReceiver()
    attachments.set(browserPageId, { canvas, context: null, listeners })
  },
  detach(browserPageId) {
    attachments.delete(browserPageId)
  },
  setViewport: (id, viewport) => ipcRenderer.send('offscreenPage:viewport', id, viewport),
  input: (id, input) => ipcRenderer.send('offscreenPage:input', id, input),
  command: (id, command) => ipcRenderer.send('offscreenPage:command', id, command),
  focus: (id) => ipcRenderer.send('offscreenPage:focus', id),
  readCaret: (id) => ipcRenderer.invoke('offscreenPage:caret', id),
  close: (id) => {
    attachments.delete(id)
    ipcRenderer.send('offscreenPage:close', id)
  }
}

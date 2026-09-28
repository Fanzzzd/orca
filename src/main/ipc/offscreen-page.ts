import { ipcMain } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import { join } from 'node:path'
import { z } from 'zod'
import {
  OffscreenPageCommandSchema,
  OffscreenPageFileDropSchema,
  OffscreenPageSelectMenuPointSchema,
  OffscreenPageUserInputSchema,
  OffscreenPageViewportSchema
} from '../../shared/offscreen-page-protocol'
import { isBrowserRoutePartition } from '../../shared/browser-route-partition'
import { isAdmissibleBrowserPageGuest } from '../browser/browser-page-guest-admission'
import { OffscreenPageHost } from '../browser/offscreen-page-host'
import {
  clearOffscreenPageKeyboardFocus,
  setOffscreenPageKeyboardFocus
} from '../browser/offscreen-page-keyboard-routing'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'

export const offscreenPageHost = new OffscreenPageHost()

const CreateArgsSchema = z.object({
  browserPageId: z.string().min(1).max(256),
  partition: z.string().min(1).max(512),
  src: z.string().max(32 * 1024),
  viewport: OffscreenPageViewportSchema
})
const PageIdSchema = z.string().min(1).max(256)

const INVOKE_CHANNELS = ['offscreenPage:create', 'offscreenPage:caret'] as const
const SEND_CHANNELS = [
  'offscreenPage:viewport',
  'offscreenPage:input',
  'offscreenPage:command',
  'offscreenPage:focus',
  'offscreenPage:keyboardFocus',
  'offscreenPage:selectMenu',
  'offscreenPage:dropFiles',
  'offscreenPage:close'
] as const

const watchedRenderers = new WeakSet<WebContents>()

export function registerOffscreenPageHandlers(): void {
  for (const channel of INVOKE_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  for (const channel of SEND_CHANNELS) {
    ipcMain.removeAllListeners(channel)
  }
  const closeWindowPreloadPath = join(__dirname, 'browser-window-close-preload.js')

  ipcMain.handle('offscreenPage:create', (event, rawArgs: unknown) => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      return null
    }
    const args = CreateArgsSchema.safeParse(rawArgs)
    // Why fail closed: this is the offscreen twin of will-attach-webview and must refuse the same inputs.
    // Why refuse routed partitions: route registration authenticates guests by webview host.
    if (
      !args.success ||
      isBrowserRoutePartition(args.data.partition) ||
      !isAdmissibleBrowserPageGuest(args.data.partition, args.data.src)
    ) {
      return null
    }
    closePagesWithRenderer(event.sender)
    const contents = offscreenPageHost.create({
      ...args.data,
      rendererWebContentsId: event.sender.id,
      closeWindowPreloadPath
    })
    return contents.id
  })

  ipcMain.handle('offscreenPage:caret', (event, rawPageId: unknown) => {
    const pageId = ownedPageId(event, rawPageId)
    return pageId ? offscreenPageHost.readCaret(pageId) : null
  })

  onOwnedPage('offscreenPage:viewport', (pageId, payload) => {
    const viewport = OffscreenPageViewportSchema.safeParse(payload)
    if (viewport.success) {
      offscreenPageHost.setViewport(pageId, viewport.data)
    }
  })
  onOwnedPage('offscreenPage:input', (pageId, payload) => {
    const input = OffscreenPageUserInputSchema.safeParse(payload)
    if (input.success) {
      void offscreenPageHost.dispatchUserInput(pageId, input.data).catch(() => {})
    }
  })
  onOwnedPage('offscreenPage:command', (pageId, payload) => {
    const command = OffscreenPageCommandSchema.safeParse(payload)
    if (command.success) {
      offscreenPageHost.runCommand(pageId, command.data)
    }
  })
  onOwnedPage('offscreenPage:focus', (pageId) => offscreenPageHost.focusPage(pageId))
  ipcMain.on('offscreenPage:keyboardFocus', (event, rawPageId: unknown, focused: unknown) => {
    const pageId = ownedPageId(event, rawPageId)
    if (pageId && typeof focused === 'boolean') {
      setOffscreenPageKeyboardFocus(event.sender.id, pageId, focused)
    }
  })
  onOwnedPage('offscreenPage:dropFiles', (pageId, payload) => {
    const drop = OffscreenPageFileDropSchema.safeParse(payload)
    if (drop.success) {
      offscreenPageHost.dropFiles(pageId, drop.data)
    }
  })
  onOwnedPage('offscreenPage:selectMenu', (pageId, payload) => {
    const point = OffscreenPageSelectMenuPointSchema.safeParse(payload)
    if (point.success) {
      offscreenPageHost.showSelectMenu(pageId, point.data)
    }
  })
  onOwnedPage('offscreenPage:close', (pageId) => offscreenPageHost.close(pageId))
}

function ownedPageId(event: IpcMainEvent | IpcMainInvokeEvent, rawPageId: unknown): string | null {
  const pageId = PageIdSchema.safeParse(rawPageId)
  if (!pageId.success || !isTrustedBrowserRenderer(event.sender)) {
    return null
  }
  return offscreenPageHost.isOwnedBy(pageId.data, event.sender.id) ? pageId.data : null
}

function onOwnedPage(
  channel: (typeof SEND_CHANNELS)[number],
  handle: (pageId: string, payload: unknown) => void
): void {
  ipcMain.on(channel, (event, rawPageId: unknown, payload: unknown) => {
    const pageId = ownedPageId(event, rawPageId)
    if (pageId) {
      handle(pageId, payload)
    }
  })
}

/** Pages die with the renderer document that shows them, exactly as <webview> guests do. */
function closePagesWithRenderer(renderer: WebContents): void {
  if (watchedRenderers.has(renderer)) {
    return
  }
  watchedRenderers.add(renderer)
  const closeOwned = () => {
    clearOffscreenPageKeyboardFocus(renderer.id)
    offscreenPageHost.closeOwnedBy(renderer.id)
  }
  renderer.once('destroyed', closeOwned)
  renderer.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      closeOwned()
    }
  })
}

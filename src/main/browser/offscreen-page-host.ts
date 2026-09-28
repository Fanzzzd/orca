import { BrowserWindow, screen, sharedTexture, webContents as electronWebContents } from 'electron'
import type { OffscreenSharedTexture, WebContents, WebPreferences } from 'electron'
import type {
  OffscreenPageCaret,
  OffscreenPageCommand,
  OffscreenPageUserInput,
  OffscreenPageViewport
} from '../../shared/offscreen-page-protocol'
import {
  attachBrowserPageGuestPolicies,
  hardenBrowserPageGuestPreferences
} from './browser-page-guest-admission'
import { browserManager } from './browser-manager'
import {
  forwardOffscreenPageGuestEvents,
  OFFSCREEN_PAGE_EVENT_CHANNEL
} from './offscreen-page-guest-events'
import {
  createOffscreenPageFrameForwarder,
  type OffscreenPageFrameForwarder
} from './offscreen-page-frame-forwarder'
import { dispatchOffscreenPageUserInput } from './offscreen-page-user-input'

export const OFFSCREEN_PAGE_FRAME_CHANNEL = 'offscreen-page:frame'
export const OFFSCREEN_PAGE_CURSOR_CHANNEL = 'offscreen-page:cursor'

const VISIBLE_FRAME_RATE = 60
// Why not 0: hidden pages still paint slowly so agent screenshots and the mobile screencast see
// fresh content without the page burning a full frame budget.
const HIDDEN_FRAME_RATE = 4

type HostedPage = {
  window: BrowserWindow
  rendererWebContentsId: number
  forwarder: OffscreenPageFrameForwarder<OffscreenSharedTexture>
  stopForwardingEvents: () => void
}

export type OffscreenPageCreateParams = {
  browserPageId: string
  partition: string
  rendererWebContentsId: number
  viewport: OffscreenPageViewport
  /** Already admitted by isAdmissibleBrowserPageGuest; loaded after policies are attached. */
  src: string
  closeWindowPreloadPath: string
}

/**
 * Owns desktop browser pages rendered offscreen and painted into the renderer as GPU textures.
 * A page here is its own top-level WebContents with no native view, so neither agent CDP input
 * nor Chromium's mouse-down focus handoff can reach the host window's focus or IME.
 */
export class OffscreenPageHost {
  private readonly pages = new Map<string, HostedPage>()

  create(params: OffscreenPageCreateParams): WebContents {
    if (this.pages.has(params.browserPageId)) {
      throw new Error(`Offscreen page ${params.browserPageId} already exists`)
    }
    const webPreferences: WebPreferences = {}
    hardenBrowserPageGuestPreferences(
      webPreferences,
      params.partition,
      params.closeWindowPreloadPath
    )
    const window = new BrowserWindow({
      show: false,
      width: params.viewport.width,
      height: params.viewport.height,
      webPreferences: {
        ...webPreferences,
        offscreen: {
          useSharedTexture: true,
          // Why the widest display: the factor is fixed at creation, and downscaling on a 1x
          // display stays sharp while upscaling on a Retina display would blur.
          deviceScaleFactor: Math.max(...screen.getAllDisplays().map((d) => d.scaleFactor), 1)
        }
      }
    })
    const contents = window.webContents
    const page: HostedPage = {
      window,
      rendererWebContentsId: params.rendererWebContentsId,
      stopForwardingEvents: forwardOffscreenPageGuestEvents(contents, (event) => {
        this.rendererFor(page)?.send(OFFSCREEN_PAGE_EVENT_CHANNEL, params.browserPageId, event)
      }),
      forwarder: createOffscreenPageFrameForwarder(
        { deliver: (texture) => this.deliverFrame(params.browserPageId, texture) },
        (error) => console.warn('[offscreen-page] frame delivery failed:', String(error))
      )
    }
    this.pages.set(params.browserPageId, page)
    attachBrowserPageGuestPolicies(contents)
    browserManager.admitRendererOffscreenGuest(contents.id, params.rendererWebContentsId)
    contents.on('paint', (event) => {
      if (event.texture) {
        page.forwarder.onPaint(event.texture)
      }
    })
    contents.on('cursor-changed', (_event, type) => {
      this.rendererFor(page)?.send(OFFSCREEN_PAGE_CURSOR_CHANNEL, params.browserPageId, type)
    })
    contents.once('destroyed', () => {
      if (this.pages.get(params.browserPageId) === page) {
        page.forwarder.dispose()
        this.pages.delete(params.browserPageId)
      }
    })
    this.setViewport(params.browserPageId, params.viewport)
    // Why after policies: popup and navigation guards must see the very first navigation.
    void contents.loadURL(params.src).catch(() => {
      // Load failures reach the renderer as did-fail-load.
    })
    return contents
  }

  setViewport(browserPageId: string, viewport: OffscreenPageViewport): void {
    const page = this.livePage(browserPageId)
    if (!page) {
      return
    }
    const [width, height] = page.window.getContentSize()
    if (width !== viewport.width || height !== viewport.height) {
      page.window.setContentSize(viewport.width, viewport.height)
    }
    page.window.webContents.setFrameRate(viewport.visible ? VISIBLE_FRAME_RATE : HIDDEN_FRAME_RATE)
    if (viewport.visible) {
      // Why: a newly shown pane needs a frame even when the page itself is idle.
      page.window.webContents.invalidate()
    }
  }

  async dispatchUserInput(browserPageId: string, input: OffscreenPageUserInput): Promise<void> {
    const page = this.livePage(browserPageId)
    if (page) {
      await dispatchOffscreenPageUserInput(page.window.webContents, input)
    }
  }

  runCommand(browserPageId: string, command: OffscreenPageCommand): void {
    const contents = this.livePage(browserPageId)?.window.webContents
    if (!contents) {
      return
    }
    switch (command.kind) {
      case 'loadURL':
        void contents.loadURL(command.url).catch(() => {})
        return
      case 'goBack':
        contents.navigationHistory.goBack()
        return
      case 'goForward':
        contents.navigationHistory.goForward()
        return
      case 'reload':
        contents.reload()
        return
      case 'reloadIgnoringCache':
        contents.reloadIgnoringCache()
        return
      case 'stop':
        contents.stop()
        return
      case 'setZoomLevel':
        contents.setZoomLevel(command.level)
        return
      case 'findInPage':
        contents.findInPage(command.text, {
          forward: command.forward,
          findNext: command.findNext,
          matchCase: command.matchCase
        })
        return
      case 'edit':
        contents[command.action]()
        return
      case 'stopFindInPage':
        contents.stopFindInPage(command.action)
    }
  }

  async readCaret(browserPageId: string): Promise<OffscreenPageCaret | null> {
    const page = this.livePage(browserPageId)
    if (!page) {
      return null
    }
    const caret: unknown = await page.window.webContents
      .executeJavaScript(READ_CARET_SCRIPT, false)
      .catch(() => null)
    return isCaret(caret) ? caret : null
  }

  /** Gives the page keyboard focus inside its own WebContents; there is no native view to activate. */
  focusPage(browserPageId: string): void {
    this.livePage(browserPageId)?.window.webContents.focus()
  }

  isOwnedBy(browserPageId: string, rendererWebContentsId: number): boolean {
    return this.livePage(browserPageId)?.rendererWebContentsId === rendererWebContentsId
  }

  closeOwnedBy(rendererWebContentsId: number): void {
    for (const [browserPageId, page] of this.pages) {
      if (page.rendererWebContentsId === rendererWebContentsId) {
        this.close(browserPageId)
      }
    }
  }

  getWebContents(browserPageId: string): WebContents | null {
    return this.livePage(browserPageId)?.window.webContents ?? null
  }

  close(browserPageId: string): void {
    const page = this.pages.get(browserPageId)
    this.pages.delete(browserPageId)
    page?.forwarder.dispose()
    page?.stopForwardingEvents()
    if (page && !page.window.isDestroyed()) {
      page.window.destroy()
    }
  }

  closeAll(): void {
    for (const browserPageId of this.pages.keys()) {
      this.close(browserPageId)
    }
  }

  private livePage(browserPageId: string): HostedPage | null {
    const page = this.pages.get(browserPageId)
    return page && !page.window.isDestroyed() ? page : null
  }

  private rendererFor(page: HostedPage): WebContents | null {
    const renderer = electronWebContents.fromId(page.rendererWebContentsId)
    return renderer && !renderer.isDestroyed() ? renderer : null
  }

  private async deliverFrame(
    browserPageId: string,
    texture: OffscreenSharedTexture
  ): Promise<void> {
    const page = this.pages.get(browserPageId)
    const renderer = page ? this.rendererFor(page) : null
    if (!renderer) {
      texture.release()
      return
    }
    const imported = sharedTexture.importSharedTexture({
      textureInfo: texture.textureInfo,
      allReferencesReleased: () => texture.release()
    })
    try {
      await sharedTexture.sendSharedTexture(
        { frame: renderer.mainFrame, importedSharedTexture: imported },
        browserPageId
      )
    } finally {
      imported.release()
    }
  }
}

// Why read in the page: the caret lives in the guest's layout, and the hidden IME textarea must sit
// on it so the OS candidate window opens next to the text being composed.
const READ_CARET_SCRIPT = `(() => {
  const sel = document.getSelection()
  if (sel && sel.rangeCount) {
    const rects = sel.getRangeAt(0).getClientRects()
    const r = rects[rects.length - 1]
    if (r) return { x: r.left, y: r.top, height: r.height || 16 }
  }
  const el = document.activeElement
  if (el && el !== document.body && el.getBoundingClientRect) {
    const b = el.getBoundingClientRect()
    return { x: b.left + 4, y: b.top, height: b.height }
  }
  return null
})()`

function isCaret(value: unknown): value is OffscreenPageCaret {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  if (!('x' in value && 'y' in value && 'height' in value)) {
    return false
  }
  return [value.x, value.y, value.height].every((n) => typeof n === 'number' && Number.isFinite(n))
}

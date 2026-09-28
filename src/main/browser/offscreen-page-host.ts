import { BrowserWindow, screen, sharedTexture, webContents as electronWebContents } from 'electron'
import type { OffscreenSharedTexture, WebContents, WebPreferences } from 'electron'
import type {
  OffscreenPageCaret,
  OffscreenPageCommand,
  OffscreenPageGuestEvent,
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
  OFFSCREEN_PAGE_EVENT_CHANNEL,
  readOffscreenPageGuestState
} from './offscreen-page-guest-events'
import {
  createOffscreenPageFrameForwarder,
  type OffscreenPageFrameForwarder
} from './offscreen-page-frame-forwarder'
import { dispatchOffscreenPageUserInput } from './offscreen-page-user-input'
import { readOffscreenPageCaret } from './offscreen-page-caret'

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
  /** The showing renderer's own zoom; its CSS px are this many page DIPs. */
  hostZoom: { level: number; factor: number } | null
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
      hostZoom: null,
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
    const factor = this.syncHostZoom(browserPageId, page)
    const width = Math.max(1, Math.round(viewport.width * factor))
    const height = Math.max(1, Math.round(viewport.height * factor))
    const [currentWidth, currentHeight] = page.window.getContentSize()
    if (currentWidth !== width || currentHeight !== height) {
      page.window.setContentSize(width, height)
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
      const factor = page.hostZoom?.factor ?? 1
      const scaled =
        input.kind === 'mouse' || input.kind === 'wheel'
          ? { ...input, x: input.x * factor, y: input.y * factor }
          : input
      await dispatchOffscreenPageUserInput(page.window.webContents, scaled)
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
      case 'findInPage': {
        // Why drop undefined keys: Electron silently ignores a find whose options carry them.
        const { kind: _kind, text, ...options } = command
        contents.findInPage(
          text,
          Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined))
        )
        return
      }
      case 'edit':
        contents[command.action]()
        return
      case 'stopFindInPage':
        contents.stopFindInPage(command.action)
    }
  }

  async readCaret(browserPageId: string): Promise<OffscreenPageCaret | null> {
    const page = this.livePage(browserPageId)
    return page ? readOffscreenPageCaret(page.window.webContents, page.hostZoom?.factor ?? 1) : null
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

  /**
   * Mirrors a <webview>: when the host's UI zoom changes, the page adopts the same zoom level, so
   * it keeps its CSS size on screen and renders at the host's sharper pixel ratio. Checked on
   * viewport sync because every UI zoom change resizes the element.
   */
  private syncHostZoom(browserPageId: string, page: HostedPage): number {
    const renderer = this.rendererFor(page)
    if (!renderer) {
      return page.hostZoom?.factor ?? 1
    }
    const level = renderer.getZoomLevel()
    if (page.hostZoom?.level !== level) {
      page.hostZoom = { level, factor: renderer.getZoomFactor() }
      const contents = page.window.webContents
      contents.setZoomLevel(level)
      renderer.send(OFFSCREEN_PAGE_EVENT_CHANNEL, browserPageId, {
        type: 'state',
        detail: {},
        state: readOffscreenPageGuestState(contents)
      } satisfies OffscreenPageGuestEvent)
    }
    return page.hostZoom.factor
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

import { BrowserWindow, screen, webContents as electronWebContents } from 'electron'
import type { OffscreenSharedTexture, WebContents, WebPreferences } from 'electron'
import type {
  OffscreenPageCaret,
  OffscreenPageCommand,
  OffscreenPageFileDrop,
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
  OFFSCREEN_PAGE_EVENT_CHANNEL
} from './offscreen-page-guest-events'
import {
  createOffscreenPageFrameForwarder,
  type OffscreenPageFrameForwarder
} from './offscreen-page-frame-forwarder'
import { dispatchOffscreenPageUserInput } from './offscreen-page-user-input'
import { readOffscreenPageCaret } from './offscreen-page-caret'
import { runOffscreenPageCommand } from './offscreen-page-commands'
import { sendOffscreenPageFrame } from './offscreen-page-frame-delivery'
import { syncOffscreenPageHostZoom, type OffscreenPageHostZoom } from './offscreen-page-host-zoom'
import { createOffscreenPageDragBridge, type OffscreenPageDragBridge } from './offscreen-page-drag'
import {
  createOffscreenPageFrameRate,
  type OffscreenPageFrameRate
} from './offscreen-page-frame-rate'
import {
  mayOpenOffscreenPageSelect,
  readOpenOffscreenPageSelect,
  showOffscreenPageSelectMenu,
  toHostSelectAnchor,
  type OffscreenPageSelectPopup
} from './offscreen-page-select-popup'
import { markOffscreenPageWindow } from '../window/offscreen-page-windows'

export const OFFSCREEN_PAGE_FRAME_CHANNEL = 'offscreen-page:frame'
export const OFFSCREEN_PAGE_CURSOR_CHANNEL = 'offscreen-page:cursor'
export const OFFSCREEN_PAGE_SELECT_CHANNEL = 'offscreen-page:select'

type HostedPage = {
  window: BrowserWindow
  rendererWebContentsId: number
  forwarder: OffscreenPageFrameForwarder<OffscreenSharedTexture>
  stopForwardingEvents: () => void
  frameRate: OffscreenPageFrameRate
  drag: OffscreenPageDragBridge
  hostZoom: OffscreenPageHostZoom | null
  /** An open select waiting for the renderer to say where its menu goes. */
  openSelect: OffscreenPageSelectPopup | null
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
    markOffscreenPageWindow(window)
    const contents = window.webContents
    const page: HostedPage = {
      window,
      rendererWebContentsId: params.rendererWebContentsId,
      hostZoom: null,
      frameRate: createOffscreenPageFrameRate(contents),
      drag: createOffscreenPageDragBridge(contents),
      openSelect: null,
      stopForwardingEvents: forwardOffscreenPageGuestEvents(contents, (event) => {
        this.rendererFor(page)?.send(OFFSCREEN_PAGE_EVENT_CHANNEL, params.browserPageId, event)
      }),
      forwarder: createOffscreenPageFrameForwarder(
        {
          deliver: (texture) =>
            sendOffscreenPageFrame(
              this.pages.get(params.browserPageId) === page ? this.rendererFor(page) : null,
              texture,
              params.browserPageId
            )
        },
        (error) => console.warn('[offscreen-page] frame delivery failed:', String(error))
      )
    }
    this.pages.set(params.browserPageId, page)
    attachBrowserPageGuestPolicies(contents)
    browserManager.admitRendererOffscreenGuest(contents.id, params.rendererWebContentsId)
    contents.on('paint', (event) => {
      if (!event.texture) {
        return
      }
      // Why drop popups: Electron gives no position for them; selects are drawn by showSelectMenu.
      if (event.texture.textureInfo.widgetType === 'popup') {
        event.texture.release()
        return
      }
      page.forwarder.onPaint(event.texture)
    })
    contents.on('cursor-changed', (_event, type) => {
      this.rendererFor(page)?.send(OFFSCREEN_PAGE_CURSOR_CHANNEL, params.browserPageId, type)
    })
    contents.once('destroyed', () => {
      // Only an unrequested death reaches here; close() unmaps the page first.
      if (this.pages.get(params.browserPageId) === page) {
        this.pages.delete(params.browserPageId)
        disposeHostedPage(page)
        const event: OffscreenPageGuestEvent = { type: 'destroyed', detail: {} }
        this.rendererFor(page)?.send(OFFSCREEN_PAGE_EVENT_CHANNEL, params.browserPageId, event)
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
    page.hostZoom = syncOffscreenPageHostZoom({
      browserPageId,
      contents: page.window.webContents,
      renderer: this.rendererFor(page),
      current: page.hostZoom
    })
    const factor = page.hostZoom?.factor ?? 1
    const width = Math.max(1, Math.round(viewport.width * factor))
    const height = Math.max(1, Math.round(viewport.height * factor))
    const [currentWidth, currentHeight] = page.window.getContentSize()
    if (currentWidth !== width || currentHeight !== height) {
      page.window.setContentSize(width, height)
    }
    page.frameRate.setVisible(viewport.visible)
  }

  dropFiles(browserPageId: string, drop: OffscreenPageFileDrop): void {
    const page = this.livePage(browserPageId)
    if (page) {
      const factor = page.hostZoom?.factor ?? 1
      void page.drag.dropFiles({ ...drop, x: drop.x * factor, y: drop.y * factor })
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
      if (mayOpenOffscreenPageSelect(input)) {
        const renderer = this.rendererFor(page)
        page.openSelect = await readOpenOffscreenPageSelect(page.window.webContents)
        if (page.openSelect && renderer) {
          const anchor = toHostSelectAnchor(page.openSelect, page.window.webContents, page.hostZoom)
          renderer.send(OFFSCREEN_PAGE_SELECT_CHANNEL, browserPageId, anchor)
        }
      }
    }
  }

  /** Shows the menu for the select offered by offerOpenSelect; `point` is window-client CSS px. */
  showSelectMenu(browserPageId: string, point: { x: number; y: number }): void {
    const page = this.livePage(browserPageId)
    const renderer = page && this.rendererFor(page)
    const window = renderer && BrowserWindow.fromWebContents(renderer)
    const popup = page?.openSelect
    if (!page || !window || !popup) {
      return
    }
    page.openSelect = null
    const hostFactor = renderer.getZoomFactor()
    showOffscreenPageSelectMenu({
      contents: page.window.webContents,
      window,
      popup,
      point: { x: point.x * hostFactor, y: point.y * hostFactor },
      pageZoomFactor: page.window.webContents.getZoomFactor()
    })
  }

  runCommand(browserPageId: string, command: OffscreenPageCommand): void {
    const contents = this.livePage(browserPageId)?.window.webContents
    if (contents) {
      runOffscreenPageCommand(contents, command)
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
    if (page) {
      disposeHostedPage(page)
      if (!page.window.isDestroyed()) {
        page.window.destroy()
      }
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
}

function disposeHostedPage(page: HostedPage): void {
  page.forwarder.dispose()
  page.stopForwardingEvents()
  page.frameRate.dispose()
  page.drag.dispose()
}

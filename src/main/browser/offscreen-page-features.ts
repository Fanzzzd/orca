import { screen, type BaseWindow, type WebContents, type WebPreferences } from 'electron'
import {
  createOffscreenPageCdpSession,
  type OffscreenPageCdpSession
} from './offscreen-page-cdp-session'
import { OFFSCREEN_PAGE_DIALOG_SETUP, routeOffscreenPageDialogs } from './offscreen-page-dialogs'
import {
  createOffscreenPageDragBridge,
  OFFSCREEN_PAGE_DRAG_SETUP,
  type OffscreenPageDragBridge
} from './offscreen-page-drag'
import {
  createOffscreenPageFrames,
  OFFSCREEN_PAGE_FRAME_SETUP,
  registerOffscreenPageFrames,
  type OffscreenPageFrames
} from './offscreen-page-frames'
import {
  createOffscreenPageFrameRate,
  type OffscreenPageFrameRate
} from './offscreen-page-frame-rate'
import { trackOffscreenPageZoom, type OffscreenPageZoom } from './offscreen-page-zoom'

/** Everything an offscreen page does beyond painting, each wired to the page's one CDP session. */
export type OffscreenPageFeatures = {
  readonly session: OffscreenPageCdpSession
  readonly frames: OffscreenPageFrames
  readonly frameRate: OffscreenPageFrameRate
  readonly drag: OffscreenPageDragBridge
  readonly zoom: OffscreenPageZoom
  /** Whether the user's keyboard focus is in this page; the page sees focus and blur from it. */
  setKeyboardFocus(focused: boolean): void
  dispose(): void
}

export function createOffscreenPageFeatures(args: {
  contents: WebContents
  webPreferences: WebPreferences
  parentWindow: () => BaseWindow | null
}): OffscreenPageFeatures {
  const { contents } = args
  let keyboardFocused = false
  // Why emulate focus: a page in a hidden window never has window focus, so document.hasFocus(),
  // focus/blur events and focus-dependent UI would all act as if the user were elsewhere.
  const focusCommand = (): readonly [string, Record<string, unknown>] => [
    'Emulation.setFocusEmulationEnabled',
    { enabled: keyboardFocused }
  ]
  const session = createOffscreenPageCdpSession(contents, () => [
    ...OFFSCREEN_PAGE_DRAG_SETUP,
    ...OFFSCREEN_PAGE_DIALOG_SETUP,
    ...OFFSCREEN_PAGE_FRAME_SETUP,
    focusCommand()
  ])
  // Why dialogs again: a file input in a cross-site iframe opens its chooser from that frame.
  const frames = createOffscreenPageFrames(
    session,
    () => OFFSCREEN_PAGE_DIALOG_SETUP,
    () => hasOutOfProcessFrames(contents)
  )
  const unregisterFrames = registerOffscreenPageFrames(contents, frames)
  const frameRate = createOffscreenPageFrameRate(contents, () =>
    Math.max(...screen.getAllDisplays().map((display) => display.displayFrequency))
  )
  const zoom = trackOffscreenPageZoom(contents, session)
  const drag = createOffscreenPageDragBridge(session, frames, contents, zoom)
  const stopDialogs = routeOffscreenPageDialogs({
    contents,
    session,
    webPreferences: args.webPreferences,
    parentWindow: args.parentWindow
  })
  return {
    session,
    frames,
    frameRate,
    drag,
    zoom,
    setKeyboardFocus(focused) {
      if (focused === keyboardFocused) {
        return
      }
      keyboardFocused = focused
      const [method, params] = focusCommand()
      void session.send(method, params).catch(() => {})
    },
    dispose() {
      stopDialogs()
      drag.dispose()
      zoom.dispose()
      frameRate.dispose()
      unregisterFrames()
      frames.dispose()
      session.dispose()
    }
  }
}

function hasOutOfProcessFrames(contents: WebContents): boolean {
  if (contents.isDestroyed()) {
    return false
  }
  const main = contents.mainFrame
  return main.framesInSubtree.some((frame) => frame.processId !== main.processId)
}

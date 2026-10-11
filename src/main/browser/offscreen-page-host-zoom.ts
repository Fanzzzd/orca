import type { WebContents } from 'electron'
import type {
  OffscreenPageGuestEvent,
  OffscreenPageUserInput
} from '../../shared/offscreen-page-protocol'
import {
  OFFSCREEN_PAGE_EVENT_CHANNEL,
  readOffscreenPageGuestState
} from './offscreen-page-guest-events'

/** The showing renderer's own zoom; its CSS px are `factor` page DIPs. */
export type OffscreenPageHostZoom = { level: number; factor: number }

/** Page DIPs per host CSS px: every point crossing between the pane and the page scales by it. */
export function hostZoomFactor(hostZoom: OffscreenPageHostZoom | null): number {
  return hostZoom?.factor ?? 1
}

/** User input with its pointer position moved from host CSS px to page DIPs. */
export function inputInPageDips(
  input: OffscreenPageUserInput,
  hostZoom: OffscreenPageHostZoom | null
): OffscreenPageUserInput {
  if (input.kind !== 'mouse' && input.kind !== 'wheel') {
    return input
  }
  const factor = hostZoomFactor(hostZoom)
  return { ...input, x: input.x * factor, y: input.y * factor }
}

/**
 * Mirrors a <webview>: when the host's UI zoom changes, the page adopts the same zoom level, so it
 * keeps its CSS size on screen and renders at the host's sharper pixel ratio. Called on viewport
 * sync because every UI zoom change resizes the element. Returns the zoom now in effect.
 */
export function syncOffscreenPageHostZoom(args: {
  browserPageId: string
  contents: WebContents
  renderer: WebContents | null
  current: OffscreenPageHostZoom | null
}): OffscreenPageHostZoom | null {
  const { renderer, contents, current } = args
  if (!renderer) {
    return current
  }
  const level = renderer.getZoomLevel()
  if (current?.level === level) {
    return current
  }
  contents.setZoomLevel(level)
  const event: OffscreenPageGuestEvent = {
    type: 'state',
    detail: {},
    state: readOffscreenPageGuestState(contents)
  }
  renderer.send(OFFSCREEN_PAGE_EVENT_CHANNEL, args.browserPageId, event)
  return { level, factor: renderer.getZoomFactor() }
}

// Chromium's built-in PDF viewer, which a full-page PDF hosts as a child frame.
const PDF_VIEWER_ORIGIN = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai'

/**
 * Page CSS px per page DIP as the main frame draws them. Why not getZoomFactor alone: the PDF
 * viewer puts its page in manual zoom mode, which reports the PDF's fit zoom but draws at 100%.
 */
export function appliedPageZoomFactor(contents: WebContents): number {
  const hostsPdfViewer = contents.mainFrame.frames.some(
    (frame) => frame.origin === PDF_VIEWER_ORIGIN
  )
  return hostsPdfViewer ? 1 : contents.getZoomFactor()
}

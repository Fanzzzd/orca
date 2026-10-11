import type { WebContents } from 'electron'
import type { OffscreenPageCdpSession } from './offscreen-page-cdp-session'

/** The page's zoom as Blink draws it: page DIPs per main-frame CSS px. */
export type OffscreenPageZoom = {
  factor(): number
  dispose(): void
}

/**
 * Tracks the zoom the page's main frame is drawn at, as Blink reports it. Why not getZoomFactor:
 * a full-page PDF puts the page in manual zoom mode, where Electron reports the viewer's fit zoom
 * while the page draws at 100%. Blink's own figure is right in every zoom mode.
 */
export function trackOffscreenPageZoom(
  contents: WebContents,
  session: OffscreenPageCdpSession
): OffscreenPageZoom {
  let factor = contents.getZoomFactor()
  let latest = 0
  const refresh = (): void => {
    const asked = ++latest
    void session
      .send('Page.getLayoutMetrics')
      .then((metrics) => {
        const zoom = readBlinkZoom(metrics)
        // Why the counter: only the newest answer reflects the page as it is now.
        if (zoom !== null && asked === latest) {
          factor = zoom
        }
      })
      .catch(() => {})
  }
  // A zoom change resizes the main frame's CSS viewport; a navigation can land on another zoom.
  const stop = session.onMessage((method, params, sessionId) => {
    if (sessionId !== undefined) {
      return
    }
    const frame = isRecord(params.frame) ? params.frame : null
    if (method === 'Page.frameResized' || (method === 'Page.frameNavigated' && !frame?.parentId)) {
      refresh()
    }
  })
  refresh()
  return { factor: () => factor, dispose: stop }
}

export function readBlinkZoom(metrics: unknown): number | null {
  const viewport = isRecord(metrics) ? metrics.cssVisualViewport : null
  const zoom = isRecord(viewport) ? viewport.zoom : null
  return typeof zoom === 'number' && zoom > 0 ? zoom : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

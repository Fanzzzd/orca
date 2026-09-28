import type { BrowserPageZoomDirection } from '../../shared/browser-page-zoom'
import {
  forwardGuestShortcutInput,
  type GuestShortcutForwardContext,
  type GuestShortcutInput
} from './browser-guest-shortcut-dispatch'

/**
 * Keys typed into an offscreen page arrive at the Orca window, not at a guest, so the window's key
 * routing asks here first. While a page holds keyboard focus its chords resolve exactly as a
 * focused <webview> guest's would: page zoom, history and reload act on that page, not on Orca.
 */
const contextByPageId = new Map<string, GuestShortcutForwardContext>()
const focusedPageByRenderer = new Map<number, string>()

export function setOffscreenPageShortcutContext(
  browserPageId: string,
  context: GuestShortcutForwardContext | null
): void {
  if (context) {
    contextByPageId.set(browserPageId, context)
    return
  }
  contextByPageId.delete(browserPageId)
  for (const [rendererId, pageId] of focusedPageByRenderer) {
    if (pageId === browserPageId) {
      focusedPageByRenderer.delete(rendererId)
    }
  }
}

export function setOffscreenPageKeyboardFocus(
  rendererWebContentsId: number,
  browserPageId: string,
  focused: boolean
): void {
  if (focused) {
    focusedPageByRenderer.set(rendererWebContentsId, browserPageId)
  } else if (focusedPageByRenderer.get(rendererWebContentsId) === browserPageId) {
    focusedPageByRenderer.delete(rendererWebContentsId)
  }
}

export function clearOffscreenPageKeyboardFocus(rendererWebContentsId: number): void {
  focusedPageByRenderer.delete(rendererWebContentsId)
}

function focusedContext(rendererWebContentsId: number): GuestShortcutForwardContext | null {
  const pageId = focusedPageByRenderer.get(rendererWebContentsId)
  return pageId === undefined ? null : (contextByPageId.get(pageId) ?? null)
}

/** Returns true when the focused offscreen page claimed the key. */
export function routeOffscreenPageShortcut(
  rendererWebContentsId: number,
  event: Electron.Event,
  input: GuestShortcutInput & { type: string }
): boolean {
  const context = focusedContext(rendererWebContentsId)
  return context !== null && input.type === 'keyDown'
    ? forwardGuestShortcutInput(context, event, input)
    : false
}

/** Native zoom commands (menu or layout-specific chords) zoom the focused page, not Orca. */
export function routeOffscreenPageZoomCommand(
  rendererWebContentsId: number,
  event: Electron.Event,
  direction: BrowserPageZoomDirection
): boolean {
  const context = focusedContext(rendererWebContentsId)
  if (!context) {
    return false
  }
  context.forwardBrowserPageZoom(event, direction)
  return true
}

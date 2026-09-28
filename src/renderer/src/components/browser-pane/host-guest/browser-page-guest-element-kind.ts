export const OFFSCREEN_PAGE_TAG = 'orca-offscreen-page'

/** True for either browser page surface: a real <webview> or its offscreen stand-in. */
export function isBrowserPageGuestElement(
  element: { tagName?: string } | null | undefined
): boolean {
  const tagName = element?.tagName
  return tagName === 'WEBVIEW' || tagName === OFFSCREEN_PAGE_TAG.toUpperCase()
}

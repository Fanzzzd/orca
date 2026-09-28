// Why: an offscreen browser page lives in a hidden BrowserWindow, and Electron lists the newest
// window first, so "the first window" stops meaning Orca's window once a page is open.
const offscreenPageWindows = new WeakSet<object>()

export function markOffscreenPageWindow(window: object): void {
  offscreenPageWindows.add(window)
}

export function isOffscreenPageWindow(window: object): boolean {
  return offscreenPageWindows.has(window)
}

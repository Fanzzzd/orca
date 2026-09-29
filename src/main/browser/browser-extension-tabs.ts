import { BrowserWindow, type Session, type WebContents } from 'electron'

const NEW_TAB_TIMEOUT_MS = 15_000

/** What a session's extension support needs to know about Orca's browser tabs. */
export type BrowserExtensionTabs = {
  addTab(tab: WebContents, window: BrowserWindow): void
  selectTab(tab: WebContents): void
  removeTab(tab: WebContents): void
}

/** Opens a URL as an Orca browser tab beside a page; false when that page has no Orca tab. */
type TabOpener = (nextTo: WebContents, url: string) => boolean

let enableSession: (sess: Session) => void = () => {}
let openTab: TabOpener = () => false
let lastTab: WebContents | null = null
const tabsBySession = new WeakMap<Session, BrowserExtensionTabs>()
const waitingForTab: ((tab: WebContents) => void)[] = []

/**
 * Why a hook: the extension library cannot load under unit tests, so only the app entry imports
 * it, and it registers here for the browser code that must not import it.
 */
export function setBrowserExtensionSessionEnabler(enable: (sess: Session) => void): void {
  enableSession = enable
}

export function enableBrowserExtensionsForSession(sess: Session): void {
  enableSession(sess)
}

export function registerBrowserExtensionTabs(sess: Session, tabs: BrowserExtensionTabs): void {
  tabsBySession.set(sess, tabs)
}

/** Lets extensions open pages as Orca browser tabs; wired by the browser manager. */
export function setBrowserExtensionTabOpener(opener: TabOpener): void {
  openTab = opener
}

/** Makes a browser page an extension tab: chrome.tabs sees it and the toolbar acts on it. */
export function trackBrowserExtensionTab(tab: WebContents, renderer: WebContents): void {
  const tabs = tabsBySession.get(tab.session)
  const window = tabs && BrowserWindow.fromWebContents(renderer)
  if (!tabs || !window) {
    return
  }
  tabs.addTab(tab, window)
  const select = (): void => {
    lastTab = tab
    tabs.selectTab(tab)
  }
  tab.on('focus', select)
  select()
  waitingForTab.shift()?.(tab)
}

export function untrackBrowserExtensionTab(tab: WebContents): void {
  if (lastTab === tab) {
    lastTab = null
  }
  tabsBySession.get(tab.session)?.removeTab(tab)
}

/** An extension's chrome.tabs.create: a new Orca tab beside the page the user last used. */
export function openBrowserExtensionTab(
  url: string | undefined
): Promise<[WebContents, BrowserWindow]> {
  return new Promise((resolve, reject) => {
    const stopWaiting = (): void => {
      clearTimeout(timer)
      waitingForTab.splice(waitingForTab.indexOf(onTab), 1)
    }
    const timer = setTimeout(() => {
      stopWaiting()
      reject(new Error('Orca did not open the tab'))
    }, NEW_TAB_TIMEOUT_MS)
    const onTab = (tab: WebContents): void => {
      clearTimeout(timer)
      const window = BrowserWindow.fromWebContents(tab.hostWebContents ?? tab)
      if (window) {
        resolve([tab, window])
      } else {
        reject(new Error('The new tab has no window'))
      }
    }
    waitingForTab.push(onTab)
    if (!lastTab || lastTab.isDestroyed() || !openTab(lastTab, url ?? 'about:blank')) {
      stopWaiting()
      reject(new Error('No Orca browser tab to open the page next to'))
    }
  })
}

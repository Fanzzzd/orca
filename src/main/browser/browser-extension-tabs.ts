import { BrowserWindow, type Session, type WebContents } from 'electron'
import type { BrowserExtensionMenuItem } from '../../shared/browser-guest-events'
import {
  BROWSER_EXTENSION_ACTION_COMMANDS,
  findBrowserExtensionCommand
} from './browser-extension-commands'

const NEW_TAB_TIMEOUT_MS = 15_000

/** What a session's extension support needs to know about Orca's browser tabs. */
export type BrowserExtensionTabs = {
  addTab(tab: WebContents, window: BrowserWindow): void
  selectTab(tab: WebContents): void
  removeTab(tab: WebContents): void
  getContextMenuItems(tab: WebContents, params: Electron.ContextMenuParams): Electron.MenuItem[]
  sendCommand(extensionId: string, name: string, tab: WebContents): void
}

/** Opens a URL as an Orca browser tab beside a page; false when that page has no Orca tab. */
type TabOpener = (nextTo: WebContents, url: string) => boolean

let enableSession: (sess: Session) => void = () => {}
let openTab: TabOpener = () => false
let lastTab: WebContents | null = null
const tabsBySession = new WeakMap<Session, BrowserExtensionTabs>()
const trackedTabs = new WeakMap<WebContents, { window: BrowserWindow; untrack: () => void }>()
const menuItemsByTab = new WeakMap<WebContents, Electron.MenuItem[]>()
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

/**
 * Makes a browser page an extension tab: chrome.tabs sees it, the toolbar acts on it, and its
 * key presses run extension shortcuts. Call after Orca's own guest input listeners, and again
 * whenever the page moves to another renderer.
 */
export function trackBrowserExtensionTab(tab: WebContents, renderer: WebContents): void {
  const tabs = tabsBySession.get(tab.session)
  const window = tabs && BrowserWindow.fromWebContents(renderer)
  if (!tabs || !window) {
    return
  }
  const previous = trackedTabs.get(tab)
  previous?.untrack()
  if (previous && previous.window !== window) {
    tabs.removeTab(tab)
  }
  tabs.addTab(tab, window)
  const select = (): void => {
    lastTab = tab
    tabs.selectTab(tab)
  }
  const runCommand = (event: Electron.Event, input: Electron.Input): void => {
    // Why: an Orca shortcut on the same keys already claimed the press; Chrome also lets the browser win.
    if (event.defaultPrevented) {
      return
    }
    const extensions = tab.session.extensions.getAllExtensions()
    const command = findBrowserExtensionCommand(extensions, input, process.platform)
    if (!command) {
      return
    }
    event.preventDefault()
    if (BROWSER_EXTENSION_ACTION_COMMANDS.has(command.name)) {
      // The toolbar button anchors the popup, so the renderer that draws it opens it.
      renderer.send('browser:extension-action-requested', {
        tabId: tab.id,
        extensionId: command.extensionId
      })
    } else {
      tabs.sendCommand(command.extensionId, command.name, tab)
    }
  }
  tab.on('focus', select)
  tab.on('before-input-event', runCommand)
  trackedTabs.set(tab, {
    window,
    untrack: () => {
      tab.off('focus', select)
      tab.off('before-input-event', runCommand)
    }
  })
  select()
  if (!previous) {
    waitingForTab.shift()?.(tab)
  }
}

export function untrackBrowserExtensionTab(tab: WebContents): void {
  if (lastTab === tab) {
    lastTab = null
  }
  trackedTabs.get(tab)?.untrack()
  trackedTabs.delete(tab)
  tabsBySession.get(tab.session)?.removeTab(tab)
}

/** The page's chrome.contextMenus entries for this right-click, kept so a pick can run them. */
export function getBrowserExtensionMenuItems(
  tab: WebContents,
  params: Electron.ContextMenuParams
): BrowserExtensionMenuItem[] {
  const items = tabsBySession.get(tab.session)?.getContextMenuItems(tab, params) ?? []
  menuItemsByTab.set(tab, items)
  return items.flatMap((item, index) =>
    item.type === 'separator'
      ? []
      : [
          {
            index,
            label: item.label,
            enabled: item.enabled,
            hasSubmenu: item.submenu !== undefined,
            iconDataUrl: item.icon && typeof item.icon !== 'string' ? item.icon.toDataURL() : null
          }
        ]
  )
}

/** Runs a picked entry; one with children opens them as a native menu at the pointer. */
export function runBrowserExtensionMenuItem(
  tab: WebContents,
  index: number,
  window: BrowserWindow | null
): void {
  const item = menuItemsByTab.get(tab)?.[index]
  if (!item?.enabled) {
    return
  }
  if (item.submenu) {
    item.submenu.popup(window ? { window } : {})
  } else {
    item.click()
  }
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

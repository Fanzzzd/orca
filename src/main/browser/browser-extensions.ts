import { join } from 'node:path'
import { app, BrowserWindow, dialog, session, webContents, type Session } from 'electron'
import { ElectronChromeExtensions } from 'electron-chrome-extensions'
import { installChromeWebStore } from 'electron-chrome-web-store'
import { translateMain } from '../i18n/main-i18n'
import {
  openBrowserExtensionTab,
  registerBrowserExtensionTabs,
  setBrowserExtensionSessionEnabler
} from './browser-extension-tabs'

let firstSession = true

/**
 * Gives a browser session Chrome extensions: the chrome.* APIs Electron lacks, installs from the
 * Chrome Web Store (its "Add to Chrome" button works in Orca's browser), and the installed set.
 */
function enableBrowserExtensions(sess: Session): void {
  if (ElectronChromeExtensions.fromSession(sess)) {
    return
  }
  if (firstSession) {
    // The toolbar's extension icons load over crx:// in Orca's own window.
    ElectronChromeExtensions.handleCRXProtocol(session.defaultSession)
  }
  const extensions = new ElectronChromeExtensions({
    license: 'GPL-3.0',
    session: sess,
    createTab: (details) => openBrowserExtensionTab(details.url),
    createWindow: async (details) => {
      const window = new BrowserWindow({
        width: details.width ?? 800,
        height: details.height ?? 600,
        webPreferences: { session: sess }
      })
      const url = Array.isArray(details.url) ? details.url[0] : details.url
      if (url) {
        void window.loadURL(url)
      }
      return window
    }
  })
  registerBrowserExtensionTabs(sess, {
    addTab: (tab, window) => extensions.addTab(tab, window),
    selectTab: (tab) => extensions.selectTab(tab),
    removeTab: (tab) => extensions.removeTab(tab),
    getContextMenuItems: (tab, params) => extensions.getContextMenuItems(tab, params),
    sendCommand: (extensionId, name, tab) => sendCommand(extensions, extensionId, name, tab)
  })
  // Why after the library's preload: Electron gives extensions a native `browser` namespace
  // without the APIs the library adds to `chrome`, and extensions like 1Password use `browser`.
  for (const type of ['frame', 'service-worker'] as const) {
    sess.registerPreloadScript({
      id: `orca-browser-extension-namespace-${type}`,
      type,
      filePath: join(__dirname, 'browser-extension-namespace-preload.js')
    })
  }
  void installChromeWebStore({
    session: sess,
    extensionsPath: join(app.getPath('userData'), 'browser-extensions'),
    // Why once: every session shares one extensions folder, so only one updater may write it.
    autoUpdate: firstSession,
    beforeInstall: confirmInstall
  }).catch((error: unknown) => console.error('[browser-extensions] setup failed:', error))
  firstSession = false
}

/**
 * chrome.commands.onCommand. Why the library's internals: it reads manifest commands but never
 * dispatches them, and its event router is the only way into an extension's worker.
 */
function sendCommand(
  extensions: ElectronChromeExtensions,
  extensionId: string,
  name: string,
  tab: Electron.WebContents
): void {
  const router = Reflect.get(Reflect.get(extensions, 'ctx'), 'router')
  const tabs = Reflect.get(Reflect.get(extensions, 'api'), 'tabs')
  router.sendEvent(extensionId, 'commands.onCommand', name, tabs.getTabDetails(tab))
}

/** Asks before an "Add to Chrome" click installs, as Chrome does. */
async function confirmInstall(details: {
  localizedName: string
  icon: Electron.NativeImage
  frame: Electron.WebFrameMain
}): Promise<{ action: 'allow' | 'deny' }> {
  const guest = webContents.fromFrame(details.frame)
  const window = guest && BrowserWindow.fromWebContents(guest.hostWebContents ?? guest)
  const options: Electron.MessageBoxOptions = {
    type: 'question',
    icon: details.icon,
    message: translateMain('auto.main.browser.browserExtensions.installTitle', 'Add "{{name}}"?', {
      name: details.localizedName
    }),
    detail: translateMain(
      'auto.main.browser.browserExtensions.installDetail',
      "It can read and change your data on the sites you visit in Orca's browser."
    ),
    buttons: [
      translateMain('auto.main.browser.browserExtensions.installConfirm', 'Add extension'),
      translateMain('auto.main.browser.browserExtensions.installCancel', 'Cancel')
    ],
    defaultId: 0,
    cancelId: 1
  }
  const { response } = await (window
    ? dialog.showMessageBox(window, options)
    : dialog.showMessageBox(options))
  return { action: response === 0 ? 'allow' : 'deny' }
}

setBrowserExtensionSessionEnabler(enableBrowserExtensions)

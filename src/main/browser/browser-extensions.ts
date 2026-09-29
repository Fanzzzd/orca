import { join } from 'node:path'
import { app, BrowserWindow, dialog, session, webContents, type Session } from 'electron'
import { ElectronChromeExtensions } from 'electron-chrome-extensions'
import { installChromeWebStore } from 'electron-chrome-web-store'
import {
  openBrowserExtensionTab,
  registerBrowserExtensionTabs,
  setBrowserExtensionSessionEnabler
} from './browser-extension-tabs'

let autoUpdateStarted = false

/**
 * Gives a browser session Chrome extensions: the chrome.* APIs Electron lacks, installs from the
 * Chrome Web Store (its "Add to Chrome" button works in Orca's browser), and the installed set.
 */
function enableBrowserExtensions(sess: Session): void {
  if (ElectronChromeExtensions.fromSession(sess)) {
    return
  }
  // The toolbar's extension icons load over crx:// in Orca's own window.
  ElectronChromeExtensions.handleCRXProtocol(session.defaultSession)
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
  registerBrowserExtensionTabs(sess, extensions)
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
    autoUpdate: !autoUpdateStarted,
    beforeInstall: confirmInstall
  }).catch((error: unknown) => console.error('[browser-extensions] setup failed:', error))
  autoUpdateStarted = true
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
    message: `Add "${details.localizedName}"?`,
    detail: "It can read and change your data on the sites you visit in Orca's browser.",
    buttons: ['Add extension', 'Cancel'],
    defaultId: 0,
    cancelId: 1
  }
  const { response } = await (window
    ? dialog.showMessageBox(window, options)
    : dialog.showMessageBox(options))
  return { action: response === 0 ? 'allow' : 'deny' }
}

setBrowserExtensionSessionEnabler(enableBrowserExtensions)

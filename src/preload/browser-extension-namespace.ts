import type { ContextBridge } from 'electron'

// Why: raw require keeps the sandboxed preload standalone in the main-process CJS build.
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: require('electron') in a preload is Electron's renderer module, which has contextBridge.
const { contextBridge } = require('electron') as { contextBridge: ContextBridge }

// Only extension contexts have extension APIs to alias.
if (process.type === 'service-worker' || location.protocol === 'chrome-extension:') {
  // Why: Electron's native `browser` lacks what electron-chrome-extensions adds to `chrome`.
  contextBridge.executeInMainWorld({
    func: () => {
      Object.assign(globalThis, { browser: Reflect.get(globalThis, 'chrome') })
    }
  })
}

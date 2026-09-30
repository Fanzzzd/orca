/**
 * Chrome extensions on offscreen browser pages: keys reach an offscreen page over CDP, skipping
 * the before-input-event where webview pages run extension shortcuts, so the page's key routing
 * has to run them itself.
 */
import { test, expect } from './helpers/orca-app'
import {
  evalInPage,
  startHtmlServer,
  writeTestExtension
} from './helpers/browser-extension-fixture'
import { ensureTerminalVisible, getActiveWorktreeId, waitForActiveWorktree } from './helpers/store'

const WORKER = `
chrome.commands.onCommand.addListener((_name, tab) => {
  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => { document.title = 'from-shortcut' }
  })
})
`

test("an extension's shortcut runs on an offscreen page", async ({ orcaPage, electronApp }) => {
  const server = await startHtmlServer(() => '<!doctype html><title>Offscreen extension</title>')
  const url = `http://127.0.0.1:${server.port}/`
  try {
    const extensionDir = writeTestExtension(
      {
        name: 'Offscreen shortcut',
        permissions: ['scripting'],
        host_permissions: ['http://127.0.0.1/*'],
        background: { service_worker: 'worker.js' },
        commands: { fill: { suggested_key: { default: 'Alt+Shift+Y' }, description: 'Fill' } }
      },
      { 'worker.js': WORKER }
    )
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    const worktreeId = await getActiveWorktreeId(orcaPage)
    await orcaPage.evaluate(() =>
      window.__store?.getState().updateSettings({ experimentalOffscreenBrowserPages: true })
    )
    const pageId = await orcaPage.evaluate(
      ({ targetWorktreeId, targetUrl }) =>
        window.__store?.getState().createBrowserTab(targetWorktreeId, targetUrl, {
          title: 'Offscreen extension',
          activate: true
        })?.activePageId ?? null,
      { targetWorktreeId: worktreeId!, targetUrl: url }
    )
    expect(pageId).toBeTruthy()
    const page = orcaPage.locator(`orca-offscreen-page[data-browser-page-id="${pageId}"]`)
    await expect(page).toBeVisible({ timeout: 20_000 })
    await expect
      .poll(() => evalInPage(orcaPage, pageId!, 'document.title'), { timeout: 20_000 })
      .toBe('Offscreen extension')
    await electronApp.evaluate(
      async ({ webContents }, { pageUrl, dir }) => {
        const guest = webContents.getAllWebContents().find((wc) => wc.getURL() === pageUrl)
        if (!guest) {
          throw new Error('page not found')
        }
        await guest.session.extensions.loadExtension(dir)
      },
      { pageUrl: url, dir: extensionDir }
    )

    const box = await page.boundingBox()
    await orcaPage.mouse.click(box!.x + 20, box!.y + 20)
    // Why the window's own input: keys typed into an offscreen page arrive at Orca's window.
    await electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((each) => !each.isDestroyed())
      for (const type of ['keyDown', 'keyUp'] as const) {
        window?.webContents.sendInputEvent({ type, keyCode: 'Y', modifiers: ['alt', 'shift'] })
      }
    })
    await expect.poll(() => evalInPage(orcaPage, pageId!, 'document.title')).toBe('from-shortcut')
  } finally {
    await server.close()
  }
})

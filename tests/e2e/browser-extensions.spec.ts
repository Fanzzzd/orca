/**
 * Chrome extensions in Orca's browser: an extension's service worker gets the chrome.* APIs
 * Electron lacks, under both `chrome` and `browser`, its content scripts reach it, and its
 * toolbar button shows beside the page.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, getActiveWorktreeId, waitForActiveWorktree } from './helpers/store'

// Why `browser` and module type: 1Password's worker is a module and uses the `browser` namespace.
const SERVICE_WORKER = `
browser.runtime.onMessage.addListener((_message, _sender, reply) => {
  reply({
    windows: typeof browser.windows?.getAll,
    contextMenus: typeof browser.contextMenus?.create,
    sameNamespace: browser === chrome
  })
})
`

const CONTENT_SCRIPT = `
chrome.runtime.sendMessage({}, (answer) => {
  document.documentElement.dataset.extension = JSON.stringify(answer)
})
`

function writeTestExtension(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-e2e-extension-'))
  const manifest = {
    manifest_version: 3,
    name: 'Orca e2e extension',
    version: '1.0',
    permissions: ['contextMenus', 'tabs'],
    background: { service_worker: 'worker.js', type: 'module' },
    action: { default_title: 'Orca e2e extension', default_popup: 'popup.html' },
    content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['content.js'] }]
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
  writeFileSync(join(dir, 'worker.js'), SERVICE_WORKER)
  writeFileSync(join(dir, 'content.js'), CONTENT_SCRIPT)
  writeFileSync(join(dir, 'popup.html'), '<!doctype html><title>popup</title>')
  return dir
}

async function startServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end('<!doctype html><title>Extension probe</title>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('probe server has no port')
  }
  return { server, url: `http://127.0.0.1:${address.port}/` }
}

async function evalInPage(page: Page, pageId: string, expression: string): Promise<unknown> {
  const response = await page.evaluate(
    ({ targetPage, targetExpression }) =>
      window.api.runtime.call({
        method: 'browser.eval',
        params: { page: targetPage, expression: targetExpression }
      }),
    { targetPage: pageId, targetExpression: expression }
  )
  const result = Reflect.get(Object(response), 'result')
  return Reflect.get(Object(result), 'result')
}

test('an installed extension runs with the full chrome API and shows a toolbar button', async ({
  orcaPage,
  electronApp
}) => {
  const { server, url } = await startServer()
  try {
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    const worktreeId = await getActiveWorktreeId(orcaPage)
    const pageId = await orcaPage.evaluate(
      ({ targetWorktreeId, targetUrl }) =>
        window.__store?.getState().createBrowserTab(targetWorktreeId, targetUrl, {
          title: 'Extension probe',
          activate: true
        })?.activePageId ?? null,
      { targetWorktreeId: worktreeId!, targetUrl: url }
    )
    expect(pageId).toBeTruthy()
    await expect.poll(() => evalInPage(orcaPage, pageId!, 'document.title')).toBe('Extension probe')

    const extensionDir = writeTestExtension()
    await electronApp.evaluate(
      async ({ webContents }, { pageUrl, dir }) => {
        const guest = webContents.getAllWebContents().find((wc) => wc.getURL() === pageUrl)
        if (!guest) {
          throw new Error('probe page not found')
        }
        await guest.session.extensions.loadExtension(dir)
      },
      { pageUrl: url, dir: extensionDir }
    )
    // Content scripts inject on the next load.
    await evalInPage(orcaPage, pageId!, 'location.reload()')

    await expect
      .poll(() =>
        evalInPage(orcaPage, pageId!, 'document.documentElement.dataset.extension ?? null')
      )
      .toBe(JSON.stringify({ windows: 'function', contextMenus: 'function', sameNamespace: true }))
    await expect(orcaPage.locator('browser-action-list button').first()).toBeVisible()
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

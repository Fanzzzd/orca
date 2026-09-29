import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

const window = vi.hoisted(() => ({ id: 'window' }))

vi.mock('electron', () => ({ BrowserWindow: { fromWebContents: () => window } }))

import {
  openBrowserExtensionTab,
  registerBrowserExtensionTabs,
  setBrowserExtensionTabOpener,
  trackBrowserExtensionTab
} from './browser-extension-tabs'

function fakeTab(sess: object) {
  return Object.assign(new EventEmitter(), {
    session: sess,
    hostWebContents: null,
    isDestroyed: () => false
  })
}

function track(tab: ReturnType<typeof fakeTab>): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fakes implement every member tracking touches.
  trackBrowserExtensionTab(tab as never, tab as never)
}

describe('browser extension tabs', () => {
  it('opens an extension tab beside the last page and resolves with the new tab', async () => {
    const sess = {}
    const tabs = { addTab: vi.fn(), selectTab: vi.fn(), removeTab: vi.fn() }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: tracking only uses the session as a key.
    registerBrowserExtensionTabs(sess as never, tabs)
    const opened: string[] = []
    setBrowserExtensionTabOpener((_nextTo, url) => {
      opened.push(url)
      return true
    })
    const page = fakeTab(sess)
    track(page)
    expect(tabs.selectTab).toHaveBeenCalledWith(page)

    const created = openBrowserExtensionTab('chrome-extension://abc/welcome.html')
    const newTab = fakeTab(sess)
    track(newTab)

    await expect(created).resolves.toEqual([newTab, window])
    expect(opened).toEqual(['chrome-extension://abc/welcome.html'])
    expect(tabs.addTab.mock.calls.map(([tab]) => tab)).toEqual([page, newTab])
  })

  it('refuses when Orca cannot open a tab beside the page', async () => {
    setBrowserExtensionTabOpener(() => false)
    await expect(openBrowserExtensionTab('https://example.com')).rejects.toThrow()
  })

  it('ignores pages in sessions without extension support', () => {
    const page = fakeTab({})
    track(page)
    expect(page.listenerCount('focus')).toBe(0)
  })
})

import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

const window = vi.hoisted(() => ({ id: 'window' }))

vi.mock('electron', () => ({ BrowserWindow: { fromWebContents: () => window } }))

import {
  getBrowserExtensionMenuItems,
  openBrowserExtensionTab,
  registerBrowserExtensionTabs,
  runBrowserExtensionMenuItem,
  setBrowserExtensionTabOpener,
  trackBrowserExtensionTab
} from './browser-extension-tabs'

const onePassword = {
  id: 'onepassword',
  manifest: {
    commands: {
      _execute_action: { suggested_key: { default: 'Ctrl+Shift+X', mac: 'Command+Shift+X' } },
      lock: { suggested_key: { default: 'Ctrl+Shift+L', mac: 'Command+Shift+L' } }
    }
  }
}

function fakeSession() {
  return { extensions: { getAllExtensions: () => [onePassword] } }
}

function fakeTabs() {
  return {
    addTab: vi.fn(),
    selectTab: vi.fn(),
    removeTab: vi.fn(),
    getContextMenuItems: vi.fn(() => []),
    sendCommand: vi.fn()
  }
}

let nextId = 1
function fakeTab(sess: object) {
  return Object.assign(new EventEmitter(), {
    id: nextId++,
    session: sess,
    hostWebContents: null,
    isDestroyed: () => false,
    send: vi.fn()
  })
}

function register(sess: object, tabs: ReturnType<typeof fakeTabs>): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: tracking only uses the session as a key.
  registerBrowserExtensionTabs(sess as never, tabs)
}

function track(tab: ReturnType<typeof fakeTab>, renderer = tab): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fakes implement every member tracking touches.
  trackBrowserExtensionTab(tab as never, renderer as never)
}

function press(tab: ReturnType<typeof fakeTab>, code: string): boolean {
  let prevented = false
  const event = { defaultPrevented: false, preventDefault: () => (prevented = true) }
  const input = { type: 'keyDown', code, key: '', meta: true, shift: true, control: false }
  tab.emit('before-input-event', event, { ...input, alt: false, isAutoRepeat: false })
  return prevented
}

describe('browser extension tabs', () => {
  it('opens an extension tab beside the last page and resolves with the new tab', async () => {
    const sess = fakeSession()
    const tabs = fakeTabs()
    register(sess, tabs)
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

  it('keeps one set of listeners when a page registers again', () => {
    const sess = fakeSession()
    register(sess, fakeTabs())
    const page = fakeTab(sess)
    track(page)
    track(page)
    expect(page.listenerCount('focus')).toBe(1)
    expect(page.listenerCount('before-input-event')).toBe(1)
  })

  it('runs extension shortcuts unless Orca already claimed the keys', () => {
    const sess = fakeSession()
    const tabs = fakeTabs()
    register(sess, tabs)
    const page = fakeTab(sess)
    const renderer = fakeTab(sess)
    track(page, renderer)
    vi.stubGlobal('process', { ...process, platform: 'darwin' })
    try {
      expect(press(page, 'KeyL')).toBe(true)
      expect(tabs.sendCommand).toHaveBeenCalledWith('onepassword', 'lock', page)
      expect(press(page, 'KeyX')).toBe(true)
      expect(renderer.send).toHaveBeenCalledWith('browser:extension-action-requested', {
        tabId: page.id,
        extensionId: 'onepassword'
      })
      const claimed = { defaultPrevented: true, preventDefault: vi.fn() }
      page.emit('before-input-event', claimed, { type: 'keyDown', code: 'KeyL' })
      expect(claimed.preventDefault).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('runs the picked context-menu entry, or opens its children', () => {
    const sess = fakeSession()
    const tabs = fakeTabs()
    register(sess, tabs)
    const page = fakeTab(sess)
    const fill = { type: 'normal', label: 'Fill', enabled: true, click: vi.fn() }
    const popup = vi.fn()
    const group = { type: 'submenu', label: '1Password', enabled: true, submenu: { popup } }
    const separator = { type: 'separator', label: '', enabled: true }
    tabs.getContextMenuItems.mockReturnValue(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the menu code reads only these members.
      [fill, separator, group] as never
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: params are passed through untouched.
    const items = getBrowserExtensionMenuItems(page as never, {} as never)
    expect(items.map((item) => [item.index, item.label, item.hasSubmenu])).toEqual([
      [0, 'Fill', false],
      [2, '1Password', true]
    ])
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fakes implement every member running touches.
    runBrowserExtensionMenuItem(page as never, 0, window as never)
    expect(fill.click).toHaveBeenCalled()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
    runBrowserExtensionMenuItem(page as never, 2, window as never)
    expect(popup).toHaveBeenCalledWith({ window })
  })
})

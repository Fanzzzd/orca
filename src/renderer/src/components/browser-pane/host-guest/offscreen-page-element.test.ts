// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOffscreenPageGuestElement } from './offscreen-page-guest-element'

const calls: string[] = []
let nextWebContentsId = 1

function stubOffscreenPageApi(): void {
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push(`${name}:${String(args[0])}`)
    }
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    }
  )
  Object.assign(window, {
    api: {
      offscreenPage: {
        create: vi.fn((args: { browserPageId: string }) => {
          calls.push(`create:${args.browserPageId}`)
          return Promise.resolve(nextWebContentsId++)
        }),
        attach: record('attach'),
        detach: record('detach'),
        close: record('close'),
        setViewport: vi.fn(),
        input: vi.fn(),
        command: vi.fn(),
        focus: vi.fn(),
        setKeyboardFocus: vi.fn(),
        showSelectMenu: vi.fn(),
        readCaret: vi.fn(() => Promise.resolve(null)),
        refreshHover: vi.fn(),
        dropFiles: vi.fn()
      }
    }
  })
}

function mountPage(container: HTMLElement, partition: string): Electron.WebviewTag {
  const element = createOffscreenPageGuestElement('page-1')
  element.setAttribute('partition', partition)
  container.append(element)
  element.src = 'https://example.com/'
  return element
}

describe('OrcaOffscreenPageElement replacement', () => {
  beforeEach(() => {
    calls.length = 0
    stubOffscreenPageApi()
  })

  afterEach(async () => {
    document.body.replaceChildren()
    await new Promise((resolve) => setTimeout(resolve, 10))
    vi.unstubAllGlobals()
  })

  it('closes the old page before creating its replacement, and never after', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const first = mountPage(container, 'persist:orca-browser')
    await vi.waitFor(() => expect(calls).toContain('create:page-1'))
    calls.length = 0

    // A profile switch removes the element and mounts a new one for the same page in one task.
    first.remove()
    mountPage(container, 'persist:orca-browser-session-new')
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(calls).toEqual(['close:page-1', 'attach:page-1', 'create:page-1'])
  })

  it('still closes the page when its only element goes away', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const element = mountPage(container, 'persist:orca-browser')
    await vi.waitFor(() => expect(calls).toContain('create:page-1'))
    calls.length = 0

    element.remove()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(calls).toEqual(['close:page-1'])
  })

  it('keeps the page when the element only moves', async () => {
    const container = document.createElement('div')
    const other = document.createElement('div')
    document.body.append(container, other)
    const element = mountPage(container, 'persist:orca-browser')
    await vi.waitFor(() => expect(calls).toContain('create:page-1'))
    calls.length = 0

    other.append(element)
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(calls).toEqual([])
  })
})

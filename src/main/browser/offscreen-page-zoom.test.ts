import { describe, expect, it, vi } from 'vitest'
import type { OffscreenPageCdpSession } from './offscreen-page-cdp-session'
import { readBlinkZoom, trackOffscreenPageZoom } from './offscreen-page-zoom'

type Listener = (method: string, params: Record<string, unknown>, sessionId?: string) => void

function fakeSession(zooms: number[]) {
  const listeners = new Set<Listener>()
  const pending: (() => void)[] = []
  const send = vi.fn(
    () =>
      new Promise<unknown>((resolve) => {
        const zoom = zooms.shift()
        pending.push(() => resolve({ cssVisualViewport: { zoom } }))
      })
  )
  const session: OffscreenPageCdpSession = {
    send,
    onMessage: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose() {}
  }
  const emit = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
    for (const listener of listeners) {
      listener(method, params, sessionId)
    }
  }
  return { session, send, emit, listeners, answer: (index: number) => pending[index]!() }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the tracker reads only getZoomFactor.
const contents = (zoom: number) => ({ getZoomFactor: () => zoom }) as never

describe('trackOffscreenPageZoom', () => {
  it("takes Blink's zoom over Electron's, as for a full-page PDF", async () => {
    const page = fakeSession([1])
    const zoom = trackOffscreenPageZoom(contents(0.48), page.session)
    expect(zoom.factor()).toBe(0.48)
    page.answer(0)
    await flush()
    expect(zoom.factor()).toBe(1)
  })

  it('re-reads on a main-frame resize or navigation, not on child frames', () => {
    const page = fakeSession([1, 1.2, 1, 1])
    trackOffscreenPageZoom(contents(1), page.session)
    page.emit('Page.frameResized')
    page.emit('Page.frameNavigated', { frame: { id: 'main' } })
    page.emit('Page.frameNavigated', { frame: { id: 'child', parentId: 'main' } })
    page.emit('Page.frameResized', {}, 'iframe-session')
    expect(page.send).toHaveBeenCalledTimes(3)
  })

  it('keeps the newest answer when answers arrive out of order', async () => {
    const page = fakeSession([1, 1.2, 1.44])
    const zoom = trackOffscreenPageZoom(contents(1), page.session)
    page.emit('Page.frameResized')
    page.emit('Page.frameResized')
    page.answer(2)
    page.answer(1)
    await flush()
    expect(zoom.factor()).toBe(1.44)
  })

  it('stops listening once disposed', () => {
    const page = fakeSession([1])
    trackOffscreenPageZoom(contents(1), page.session).dispose()
    expect(page.listeners.size).toBe(0)
  })
})

describe('readBlinkZoom', () => {
  it('reads the visual viewport zoom and rejects anything else', () => {
    expect(readBlinkZoom({ cssVisualViewport: { zoom: 1.2 } })).toBe(1.2)
    expect(readBlinkZoom({ cssVisualViewport: { zoom: 0 } })).toBeNull()
    expect(readBlinkZoom(undefined)).toBeNull()
  })
})

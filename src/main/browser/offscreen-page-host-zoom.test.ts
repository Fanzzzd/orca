import { describe, expect, it } from 'vitest'
import type { OffscreenPageUserInput } from '../../shared/offscreen-page-protocol'
import type { WebContents } from 'electron'
import { appliedPageZoomFactor, hostZoomFactor, inputInPageDips } from './offscreen-page-host-zoom'

const wheel: OffscreenPageUserInput = {
  kind: 'wheel',
  x: 10,
  y: 20,
  deltaX: 0,
  deltaY: -3,
  modifiers: []
}

describe('host zoom conversions', () => {
  it('treats a page with no synced host zoom as unzoomed', () => {
    expect(hostZoomFactor(null)).toBe(1)
    expect(inputInPageDips(wheel, null)).toEqual(wheel)
  })

  it('moves pointer positions into page DIPs and leaves other input alone', () => {
    expect(inputInPageDips(wheel, { level: 1, factor: 1.5 })).toEqual({ ...wheel, x: 15, y: 30 })
    const commit: OffscreenPageUserInput = { kind: 'commit', text: 'a' }
    expect(inputInPageDips(commit, { level: 1, factor: 1.5 })).toBe(commit)
  })
})

describe('appliedPageZoomFactor', () => {
  const contents = (origins: string[]): WebContents =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: appliedPageZoomFactor reads only these two members.
    ({
      getZoomFactor: () => 0.9,
      mainFrame: { frames: origins.map((origin) => ({ origin })) }
    }) as unknown as WebContents

  it("is the page's zoom for an ordinary page", () => {
    expect(appliedPageZoomFactor(contents(['https://example.test']))).toBe(0.9)
  })

  it('is 1 for a full-page PDF, whose viewer reports its fit zoom but draws at 100%', () => {
    expect(
      appliedPageZoomFactor(contents(['chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai']))
    ).toBe(1)
  })
})

// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  applyTabStripSelect,
  resolveTabStripSelectMode,
  useTabStripSelection
} from './tab-strip-selection'

const ORDER = ['a', 'b', 'c', 'd', 'e']
const NO_KEYS = { shiftKey: false, metaKey: false, ctrlKey: false }

describe('resolveTabStripSelectMode', () => {
  it('maps Shift to range and the platform toggle key to toggle', () => {
    expect(resolveTabStripSelectMode({ ...NO_KEYS, shiftKey: true }, true)).toBe('range')
    expect(resolveTabStripSelectMode({ ...NO_KEYS, metaKey: true }, true)).toBe('toggle')
    expect(resolveTabStripSelectMode({ ...NO_KEYS, ctrlKey: true }, false)).toBe('toggle')
  })

  it('leaves Ctrl on macOS and Meta elsewhere to the platform', () => {
    expect(resolveTabStripSelectMode({ ...NO_KEYS, ctrlKey: true }, true)).toBeNull()
    expect(resolveTabStripSelectMode({ ...NO_KEYS, metaKey: true }, false)).toBeNull()
    expect(resolveTabStripSelectMode(NO_KEYS, true)).toBeNull()
  })
})

describe('applyTabStripSelect', () => {
  const base = { orderedIds: ORDER, selectedIds: [], anchorId: null, activeId: 'b' }

  it('selects the range from the active tab when there is no anchor', () => {
    expect(applyTabStripSelect({ ...base, targetId: 'd', mode: 'range' })).toEqual({
      selectedIds: ['b', 'c', 'd'],
      anchorId: 'b'
    })
    expect(applyTabStripSelect({ ...base, targetId: 'a', mode: 'range' }).selectedIds).toEqual([
      'a',
      'b'
    ])
  })

  it('keeps the anchor so a second Shift-click replaces the range', () => {
    const result = applyTabStripSelect({
      ...base,
      selectedIds: ['b', 'c', 'd'],
      anchorId: 'b',
      targetId: 'a',
      mode: 'range'
    })
    expect(result).toEqual({ selectedIds: ['a', 'b'], anchorId: 'b' })
  })

  it('starts a toggle from the active tab and keeps strip order', () => {
    expect(applyTabStripSelect({ ...base, targetId: 'e', mode: 'toggle' })).toEqual({
      selectedIds: ['b', 'e'],
      anchorId: 'e'
    })
    expect(
      applyTabStripSelect({ ...base, selectedIds: ['b', 'e'], targetId: 'a', mode: 'toggle' })
        .selectedIds
    ).toEqual(['a', 'b', 'e'])
  })

  it('drops back to no selection when one tab is left', () => {
    expect(
      applyTabStripSelect({ ...base, selectedIds: ['b', 'e'], targetId: 'e', mode: 'toggle' })
        .selectedIds
    ).toEqual([])
    expect(applyTabStripSelect({ ...base, targetId: 'b', mode: 'range' }).selectedIds).toEqual([])
  })
})

describe('useTabStripSelection', () => {
  it('prunes closed tabs and clears on Escape or a new active tab', () => {
    const { result, rerender } = renderHook(
      ({ orderedIds, activeId }: { orderedIds: string[]; activeId: string }) =>
        useTabStripSelection({ orderedIds, activeId }),
      { initialProps: { orderedIds: ORDER, activeId: 'b' } }
    )
    act(() => result.current.select('d', 'range'))
    expect([...result.current.selectedIds]).toEqual(['b', 'c', 'd'])

    rerender({ orderedIds: ['a', 'b', 'd', 'e'], activeId: 'b' })
    expect([...result.current.selectedIds]).toEqual(['b', 'd'])

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(result.current.selectedIds.size).toBe(0)

    act(() => result.current.select('e', 'toggle'))
    expect(result.current.selectedIds.size).toBe(2)
    rerender({ orderedIds: ['a', 'b', 'd', 'e'], activeId: 'a' })
    expect(result.current.selectedIds.size).toBe(0)
  })
})

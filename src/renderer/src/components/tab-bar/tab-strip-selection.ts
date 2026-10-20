import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

export type TabStripSelectMode = 'range' | 'toggle'

/** What one tab needs to draw and act on the strip's multi-selection. */
export type TabStripSelection = {
  isSelected: boolean
  onSelect: (mode: TabStripSelectMode) => void
  onCloseSelected: () => void
}

type ModifierState = Pick<PointerEvent, 'shiftKey' | 'metaKey' | 'ctrlKey'>

export function resolveTabStripSelectMode(
  event: ModifierState,
  isMac: boolean = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')
): TabStripSelectMode | null {
  if (event.shiftKey) {
    return 'range'
  }
  // Why: Ctrl-click on macOS is a secondary click, so only Cmd toggles there.
  if (isMac ? event.metaKey : event.ctrlKey) {
    return 'toggle'
  }
  return null
}

export function applyTabStripSelect({
  orderedIds,
  selectedIds,
  anchorId,
  activeId,
  targetId,
  mode
}: {
  orderedIds: readonly string[]
  selectedIds: readonly string[]
  anchorId: string | null
  activeId: string | null
  targetId: string
  mode: TabStripSelectMode
}): { selectedIds: string[]; anchorId: string | null } {
  if (mode === 'toggle') {
    // Why: the first toggle starts from the active tab, as in Chrome and VS Code.
    const base = new Set(selectedIds.length > 0 ? selectedIds : activeId ? [activeId] : [])
    if (base.has(targetId)) {
      base.delete(targetId)
    } else {
      base.add(targetId)
    }
    const next = orderedIds.filter((id) => base.has(id))
    return { selectedIds: next.length > 1 ? next : [], anchorId: targetId }
  }
  const from = orderedIds.indexOf(anchorId ?? activeId ?? targetId)
  const to = orderedIds.indexOf(targetId)
  if (from === -1 || to === -1) {
    return { selectedIds: [], anchorId: targetId }
  }
  const next = orderedIds.slice(Math.min(from, to), Math.max(from, to) + 1)
  return { selectedIds: next.length > 1 ? next : [], anchorId: anchorId ?? activeId }
}

export function useTabStripSelection({
  orderedIds,
  activeId
}: {
  orderedIds: readonly string[]
  activeId: string | null
}): {
  selectedIds: ReadonlySet<string>
  select: (targetId: string, mode: TabStripSelectMode) => void
  clear: () => void
} {
  // Why keyed by the active tab: switching tabs by any route (keyboard, sidebar, agent) ends
  // the selection without an effect-driven state write.
  const [raw, setRaw] = useState<{
    ids: readonly string[]
    anchorId: string | null
    activeId: string | null
  }>({ ids: [], anchorId: null, activeId })
  const current = raw.activeId === activeId ? raw : null
  // A closed or moved-away tab drops out without a state write.
  const selectedIds = useMemo(() => {
    const present = new Set(orderedIds)
    const kept = (current?.ids ?? []).filter((id) => present.has(id))
    return new Set(kept.length > 1 ? kept : [])
  }, [orderedIds, current])
  const latest = useRef({ orderedIds, activeId, selectedIds, anchorId: current?.anchorId ?? null })
  latest.current = { orderedIds, activeId, selectedIds, anchorId: current?.anchorId ?? null }

  const clear = useCallback(() => {
    setRaw((previous) =>
      previous.ids.length === 0 ? previous : { ids: [], anchorId: null, activeId: null }
    )
  }, [])

  const select = useCallback((targetId: string, mode: TabStripSelectMode) => {
    const { orderedIds: ids, activeId: active, selectedIds: selected, anchorId } = latest.current
    const result = applyTabStripSelect({
      orderedIds: ids,
      selectedIds: [...selected],
      anchorId,
      activeId: active,
      targetId,
      mode
    })
    setRaw({ ids: result.selectedIds, anchorId: result.anchorId, activeId: active })
  }, [])

  const hasSelection = selectedIds.size > 0
  useEffect(() => {
    if (!hasSelection) {
      return undefined
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        clear()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [clear, hasSelection])

  return { selectedIds, select, clear }
}

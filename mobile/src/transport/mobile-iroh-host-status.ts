// Compact per-host iroh diagnostic for connection UI (home card / session header).

export type IrohHostStatusPhase = 'idle' | 'skipped' | 'attempting' | 'connected' | 'failed'

export type IrohHostStatus = {
  phase: IrohHostStatusPhase
  detail: string
  updatedAt: number
}

const byHost = new Map<string, IrohHostStatus>()
const listeners = new Set<() => void>()

export function setIrohHostStatus(
  hostId: string,
  phase: IrohHostStatusPhase,
  detail = '',
  nowMs = Date.now()
): void {
  byHost.set(hostId, { phase, detail, updatedAt: nowMs })
  for (const listener of listeners) {
    listener()
  }
}

export function getIrohHostStatus(hostId: string): IrohHostStatus | null {
  return byHost.get(hostId) ?? null
}

export function clearIrohHostStatus(hostId: string): void {
  byHost.delete(hostId)
  for (const listener of listeners) {
    listener()
  }
}

export function subscribeIrohHostStatus(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Compact line for status meta, e.g. "Iroh attempting" / "Iroh failed: flag_off". */
export function irohStatusDisplayLabel(status: IrohHostStatus | null | undefined): string | null {
  if (!status || status.phase === 'idle') {
    return null
  }
  if (status.phase === 'skipped') {
    return status.detail ? `Iroh skipped (${status.detail})` : 'Iroh skipped'
  }
  if (status.phase === 'attempting') {
    return 'Iroh attempting…'
  }
  if (status.phase === 'connected') {
    return status.detail ? `Iroh · ${status.detail}` : 'Iroh connected'
  }
  // failed
  return status.detail ? `Iroh failed: ${status.detail}` : 'Iroh failed'
}

/** Test-only. */
export function resetIrohHostStatusForTests(): void {
  byHost.clear()
  listeners.clear()
}

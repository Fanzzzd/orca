/** Presence-based path role for iroh (desktop "Iroh" pairing option). */
export type IrohPathMode = 'off' | 'fallback' | 'primary-off-lan'

const IROH_ENDPOINT_ID = /^[0-9a-f]{64}$/

export function hostHasIrohEndpointId(host: { iroh?: { endpointId?: string } | null }): boolean {
  return typeof host.iroh?.endpointId === 'string' && IROH_ENDPOINT_ID.test(host.iroh.endpointId)
}

/**
 * When offer has iroh.endpointId and no relay block, iroh is the primary off-LAN path.
 * With both iroh + relay, iroh is still a candidate but not sole off-LAN primary.
 */
export function inferIrohPathMode(host: {
  iroh?: { endpointId?: string } | null
  relay?: unknown
}): IrohPathMode {
  if (!hostHasIrohEndpointId(host)) {
    return 'off'
  }
  return host.relay ? 'fallback' : 'primary-off-lan'
}

import type { MobileEndpointSupervisorDependencies } from './mobile-endpoint-supervisor-contract'
import type { RelayReconnectController } from './mobile-relay-reconnect-controller'
import type { RelayLeaseRotationTimer } from './mobile-relay-lease-rotation-timer'
import type { MobileEndpointHysteresis } from './mobile-endpoint-hysteresis'
import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { HostProfile } from './types'
import {
  encodeBase64Url,
  isDirectorResolutionFailure,
  persistRelayHost,
  toError
} from './mobile-endpoint-supervisor-support'
import { applyResumeConfirmation } from './mobile-relay-credential-rotation'

export type RelayRecoveryContext = {
  logical: StableLogicalRpcClient
  // Why: getters so director re-resolve can update host/bundle mid-recovery.
  getHost: () => HostProfile
  getBundle: () => MobileRelayCredentialBundle
  dependencies: MobileEndpointSupervisorDependencies
  relayReconnect: RelayReconnectController
  leaseRotation: RelayLeaseRotationTimer
  hysteresis: MobileEndpointHysteresis
  stopped: () => boolean
  foreground: () => boolean
  setHost: (host: HostProfile) => void
  setBundle: (bundle: MobileRelayCredentialBundle) => void
  clearRelayRotationPending: () => void
  scheduleDirectProbe: () => void
}

export async function recoverRelayWithCredentials(
  ctx: RelayRecoveryContext,
  forceReplacement: boolean
): Promise<boolean> {
  let lastError: Error | null = null
  const bundle = ctx.getBundle()
  const credentials = ctx.relayReconnect.eligibleCredentials(bundle.current, bundle.grace)
  for (const credential of credentials) {
    const result = await tryRelayCredential(ctx, credential)
    if (result.ok) {
      return true
    }
    lastError = result.error
    if (ctx.relayReconnect.shouldTryGraceAfterRelayFailure(result.error)) {
      ctx.relayReconnect.recordRejectedCredential(credential.version)
    } else {
      break
    }
  }
  if (credentials.length > 0) {
    const scheduleRetry = !forceReplacement && ctx.foreground() && !ctx.stopped()
    ctx.relayReconnect.registerFailure(lastError, scheduleRetry)
  }
  return false
}

async function tryRelayCredential(
  ctx: RelayRecoveryContext,
  credential: { token: string; version: number }
): Promise<{ ok: true } | { ok: false; error: Error }> {
  const first = await openAndMigrateRelay(ctx, credential)
  if (first.ok) {
    return first
  }
  const host = ctx.getHost()
  if (!isDirectorResolutionFailure(first.error) || !host.relay) {
    return first
  }
  try {
    const resolved = await ctx.dependencies.resolveRelay({
      relay: host.relay,
      resumeToken: credential.token
    })
    ctx.setHost(await persistRelayHost(host, resolved, ctx.dependencies.saveHost))
    return await openAndMigrateRelay(ctx, credential)
  } catch (error) {
    return { ok: false, error: toError(error) }
  }
}

async function openAndMigrateRelay(
  ctx: RelayRecoveryContext,
  credential: { token: string; version: number }
): Promise<{ ok: true } | { ok: false; error: Error }> {
  const host = ctx.getHost()
  if (ctx.stopped() || !ctx.foreground() || !host.relay) {
    return { ok: false, error: new Error('relay state missing') }
  }
  const session = ctx.dependencies.openRelay(
    host.relay,
    credential,
    `confirm-${encodeBase64Url(ctx.dependencies.randomBytes(16))}`
  )
  try {
    await ctx.logical.migrateTo(session, 'relay')
    ctx.relayReconnect.setActiveSession(session)
    if (!ctx.foreground()) {
      ctx.relayReconnect.suspendActiveRelay(ctx.logical)
    }
    ctx.clearRelayRotationPending()
    ctx.hysteresis.recordMigration(ctx.dependencies.now())
    const confirmation = session.getResumeConfirmation()
    if (confirmation) {
      const next = applyResumeConfirmation(ctx.getBundle(), credential.version, confirmation)
      ctx.setBundle(next)
      await ctx.dependencies.writeBundle(next).catch(() => {})
    }
    ctx.leaseRotation.scheduleFromLease(
      ctx.stopped() || !ctx.foreground() ? null : session.getLeaseExpiresAt()
    )
    ctx.scheduleDirectProbe()
    return { ok: true }
  } catch (error) {
    return { ok: false, error: session.getFailure() ?? toError(error) }
  }
}

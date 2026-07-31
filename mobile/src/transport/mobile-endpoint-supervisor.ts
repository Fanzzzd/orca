import { openAuthenticatedDirectEndpoint } from './mobile-direct-endpoint-probe'
import type { MobileEndpointSupervisorDependencies } from './mobile-endpoint-supervisor-contract'
import { RelayReconnectController } from './mobile-relay-reconnect-controller'
import { RelayLeaseRotationTimer } from './mobile-relay-lease-rotation-timer'
import { MobileEndpointHysteresis } from './mobile-endpoint-hysteresis'
import { persistRelayHost } from './mobile-endpoint-supervisor-support'
import {
  mobileRelayCredentialNeedsRotation,
  rotateMobileRelayCredential
} from './mobile-relay-credential-rotation'
import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import { recoverRelayWithCredentials } from './mobile-endpoint-relay-recovery'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { HostProfile } from './types'

export type { MobileEndpointSupervisorDependencies } from './mobile-endpoint-supervisor-contract'

const DIRECT_PROBE_INTERVAL_MS = 15_000
const DIRECT_OBSERVATION_MS = 30_000
const MINIMUM_DWELL_MS = 60_000
const FAILURE_COOLDOWN_MS = 60_000

export class MobileEndpointSupervisor {
  private bundle: MobileRelayCredentialBundle | null = null
  private stopped = false
  private foreground = true
  private operationInFlight = false
  private credentialRotationInFlight = false
  private relayRotationPending = false
  private probeTimer: ReturnType<typeof setTimeout> | null = null
  private unsubscribeState: (() => void) | null = null
  private readonly hysteresis: MobileEndpointHysteresis
  private readonly relayReconnect: RelayReconnectController
  private readonly leaseRotation: RelayLeaseRotationTimer

  constructor(
    private readonly logical: StableLogicalRpcClient,
    private host: HostProfile,
    private readonly dependencies: MobileEndpointSupervisorDependencies
  ) {
    this.hysteresis = new MobileEndpointHysteresis(dependencies.now(), {
      directSuccessesRequired: 3,
      directObservationMs: DIRECT_OBSERVATION_MS,
      failureCooldownMs: FAILURE_COOLDOWN_MS,
      minimumDwellMs: MINIMUM_DWELL_MS
    })
    this.relayReconnect = new RelayReconnectController(
      dependencies,
      this.recoverFallback.bind(this)
    )
    this.leaseRotation = new RelayLeaseRotationTimer(dependencies, () => {
      this.relayRotationPending = true
      void this.recoverFallback(true)
    })
  }

  async start(): Promise<void> {
    this.bundle = await this.dependencies.readBundle(this.host.id).catch(() => null)
    if (this.stopped || !this.hasRelay()) {
      return
    }
    this.unsubscribeState = this.logical.onStateChange((state) => {
      if (state === 'connected') {
        if (this.logical.getActivePath() !== 'relay') {
          void this.rotateCredentialIfNeeded(this.relayReconnect.resetForDirectConnection())
        }
        this.scheduleDirectProbe()
      } else {
        this.relayReconnect.handleStateFailure(this.logical, state)
      }
    })
    if (this.relayReconnect.needsRecovery(this.logical.getState())) {
      await this.recoverFallback()
    } else {
      this.scheduleDirectProbe()
    }
  }

  setForeground(foreground: boolean): void {
    const wasForeground = this.foreground
    this.foreground = foreground
    if (foreground) {
      this.relayReconnect.handleForeground(this.logical, wasForeground)
      this.scheduleDirectProbe(0)
    } else {
      // Why: background phones must not hold billed relay data splices.
      this.relayReconnect.suspendActiveRelay(this.logical)
      this.clearDirectProbeTimer()
      this.relayReconnect.clear()
      this.leaseRotation.clear()
    }
  }

  stop(): void {
    this.stopped = true
    this.unsubscribeState?.()
    this.unsubscribeState = null
    this.clearDirectProbeTimer()
    this.relayReconnect.clear()
    this.leaseRotation.clear()
  }

  private hasRelay(): boolean {
    return Boolean(this.bundle && this.host.relay)
  }

  /** Fallback on LAN failure: relay with stored credentials. */
  private async recoverFallback(forceReplacement = false): Promise<void> {
    if (
      this.stopped ||
      !this.foreground ||
      this.operationInFlight ||
      (!forceReplacement && !this.relayReconnect.needsRecovery(this.logical.getState()))
    ) {
      return
    }
    if (this.relayReconnect.shouldDefer()) {
      return
    }
    this.operationInFlight = true
    let retryAfterOperation = false
    try {
      if (this.hasRelay() && this.bundle) {
        const recovered = await recoverRelayWithCredentials(
          this.relayCtx(this.bundle),
          forceReplacement
        )
        retryAfterOperation = recovered && this.logical.getState() !== 'connected'
      }
    } finally {
      this.operationInFlight = false
      if (forceReplacement && this.relayRotationPending && !this.stopped && this.foreground) {
        this.leaseRotation.armRetry(this.relayReconnect.retryDelayMs(5000))
      }
      if (retryAfterOperation && !this.stopped && this.foreground) {
        void this.recoverFallback()
      }
    }
  }

  private scheduleDirectProbe(delayMs = DIRECT_PROBE_INTERVAL_MS): void {
    // Why: upgrade from relay back to LAN when the desk is on-network.
    if (
      this.stopped ||
      !this.foreground ||
      this.logical.getActivePath() !== 'relay' ||
      this.probeTimer
    ) {
      return
    }
    this.probeTimer = this.dependencies.setTimer(() => {
      this.probeTimer = null
      void this.probeDirect()
    }, delayMs)
  }

  private async probeDirect(): Promise<void> {
    if (
      this.stopped ||
      !this.foreground ||
      this.operationInFlight ||
      !this.hysteresis.canProbe(this.dependencies.now())
    ) {
      this.scheduleDirectProbe()
      return
    }
    this.operationInFlight = true
    let successful: Awaited<ReturnType<typeof openAuthenticatedDirectEndpoint>> = null
    try {
      successful = await openAuthenticatedDirectEndpoint(
        this.host,
        this.dependencies.openDirect,
        12_000
      )
      if (!successful) {
        this.hysteresis.recordDirectFailure(this.dependencies.now())
        return
      }
      if (!this.hysteresis.recordDirectSuccess(this.dependencies.now())) {
        successful.client.close()
        return
      }
      await this.logical.migrateTo(successful.client, successful.path)
      successful = null
      this.hysteresis.recordMigration(this.dependencies.now())
      this.leaseRotation.clear()
      this.relayRotationPending = false
      await this.rotateCredentialIfNeeded(this.relayReconnect.resetForDirectConnection())
    } finally {
      successful?.client.close()
      this.operationInFlight = false
      if (this.relayRotationPending || this.logical.getState() !== 'connected') {
        void this.recoverFallback(this.relayRotationPending)
      }
      this.scheduleDirectProbe()
    }
  }

  private async rotateCredentialIfNeeded(force = false): Promise<void> {
    if (
      this.stopped ||
      this.credentialRotationInFlight ||
      !this.bundle ||
      this.logical.getActivePath() === 'relay' ||
      (!force && !mobileRelayCredentialNeedsRotation(this.bundle, this.dependencies.now()))
    ) {
      return
    }
    this.credentialRotationInFlight = true
    let credentialRefreshed = false
    try {
      const result = await rotateMobileRelayCredential({
        client: this.logical,
        bundle: this.bundle,
        writeBundle: this.dependencies.writeBundle,
        randomBytes: this.dependencies.randomBytes
      })
      this.bundle = result.bundle
      credentialRefreshed = true
      this.host = await persistRelayHost(this.host, result.relay, this.dependencies.saveHost)
    } catch {
      // Why: pending material remains durable for the next authenticated path.
    } finally {
      if (credentialRefreshed) {
        this.relayReconnect.completeCredentialRefresh()
      }
      this.credentialRotationInFlight = false
      if (
        credentialRefreshed &&
        !this.stopped &&
        this.foreground &&
        this.relayReconnect.needsRecovery(this.logical.getState())
      ) {
        void this.recoverFallback()
      }
    }
  }

  private clearDirectProbeTimer(): void {
    if (this.probeTimer) {
      this.dependencies.clearTimer(this.probeTimer)
      this.probeTimer = null
    }
  }

  private relayCtx(_bundle: MobileRelayCredentialBundle) {
    return {
      logical: this.logical,
      getHost: () => this.host,
      getBundle: () => this.bundle!,
      dependencies: this.dependencies,
      relayReconnect: this.relayReconnect,
      leaseRotation: this.leaseRotation,
      hysteresis: this.hysteresis,
      stopped: () => this.stopped,
      foreground: () => this.foreground,
      setHost: (host: HostProfile) => {
        this.host = host
      },
      setBundle: (next: MobileRelayCredentialBundle) => {
        this.bundle = next
      },
      clearRelayRotationPending: () => {
        this.relayRotationPending = false
      },
      scheduleDirectProbe: () => this.scheduleDirectProbe()
    }
  }
}

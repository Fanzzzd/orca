import { describe, expect, it, vi } from 'vitest'

const events: string[] = []
const breadcrumbData = new Map<string, unknown>()

vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: () => '/tmp/orca-test' }
}))
vi.mock('../observability', () => ({
  initObservability: () => events.push('observability')
}))
vi.mock('../crash-reporting/durable-crash-breadcrumb', () => ({
  recordDurableCrashBreadcrumb: (name: string, data?: unknown) => {
    events.push(name)
    breadcrumbData.set(name, data)
  }
}))
vi.mock('../agent-awake-service', () => ({
  AgentAwakeService: class {
    setMode(): void {}
    setStatuses(): void {}
  }
}))
vi.mock('../system-resume-broadcast', () => ({
  registerSystemResumeBroadcast: () => () => {}
}))
vi.mock('../agent-hooks/server', () => ({
  agentHookServer: {
    subscribeStatusChanges: () => () => {},
    subscribeStatusFreshness: () => () => {},
    subscribeEnrichedStatus: () => () => {},
    subscribePaneStatusClear: () => () => {}
  }
}))
vi.mock('../agent-hooks/hook-status-session-tabs-republish', () => ({
  installHookStatusSessionTabsRepublish: () => () => {}
}))
vi.mock('../telemetry/client', () => ({
  initTelemetry: () => {},
  track: () => {}
}))
vi.mock('../codex/codex-trust-grant-telemetry', () => ({
  setCodexTrustGrantTelemetry: () => {}
}))
vi.mock('../skills/skill-transaction-startup-recovery', () => ({
  recoverPendingSkillTransactions: () => new Promise(() => {})
}))
vi.mock('../telemetry/cohort-classifier', () => ({
  initCohortClassifier: () => {}
}))
vi.mock('../telemetry/onboarding-cohort-classifier', () => ({
  initOnboardingCohortClassifier: () => {}
}))
vi.mock('../stats/collector', () => ({ StatsCollector: class {} }))
vi.mock('../stats/agent-session-transition-recorder', () => ({
  AgentSessionTransitionRecorder: class {}
}))
vi.mock('../claude-usage/store', () => ({ ClaudeUsageStore: class {} }))
vi.mock('../codex-usage/store', () => ({ CodexUsageStore: class {} }))
vi.mock('../opencode-usage/store', () => ({ OpenCodeUsageStore: class {} }))
vi.mock('../muse-usage/store', () => ({ MuseUsageStore: class {} }))
vi.mock('../repo-maintenance-idle-gate', () => ({
  installRepoMaintenanceIdleGate: () => () => {}
}))

const { mainProcessState } = await import('./main-process-state')
const { initializeMainProcessObservers } = await import('./main-process-observers')

describe('main thread hang breadcrumb', () => {
  it('is recorded after the trace sink exists, so the trace keeps it', () => {
    Object.assign(mainProcessState, {
      store: { getSettings: () => ({}) },
      hangDetection: {
        detectedAt: 1,
        parentPid: 9536,
        unresponsiveMs: 103_000,
        selfRecovered: true
      }
    })

    initializeMainProcessObservers()

    expect(events).toEqual([
      'observability',
      'main_process_lifecycle_started',
      'main_thread_hang_detected'
    ])
    expect(breadcrumbData.get('main_thread_hang_detected')).toEqual({
      unresponsiveMs: 103_000,
      previousPid: 9536,
      selfRecovered: true
    })
  })
})

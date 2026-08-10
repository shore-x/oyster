import { createRoot } from 'solid-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AvailableSessionSummary,
  DiscoveryApi,
  DiscoverySnapshot,
  SessionCatalogSnapshot
} from '../src/shared/discovery'
import type {
  KnowledgeMaintenanceResult,
  KnowledgeProcessingApi,
  KnowledgeProcessingSnapshot,
  RunKnowledgeMaintenanceInput
} from '../src/shared/knowledge-processing'
import { completedAgentRun } from './agent-run-fixture'
import { createKnowledgeProcessingController } from '../src/renderer/src/knowledge-processing-controller'

vi.mock('solid-js', async () => vi.importActual('solid-js/dist/solid.js'))

const SESSION: AvailableSessionSummary = {
  sourceRecordId: 'source-record-1',
  sourceId: 'source-1',
  agentType: 'codex',
  sourceDisplayName: 'Codex',
  externalId: 'session-1',
  title: 'Session one',
  sizeBytes: 120,
  revision: 'a'.repeat(64)
}

const SNAPSHOT: KnowledgeProcessingSnapshot = {
  stages: [],
  connections: [],
  runningStageIds: [],
  debugTraces: []
}

function discoverySnapshot(): DiscoverySnapshot {
  return {
    sources: [],
    runs: []
  }
}

function sessionCatalog(sessions = [SESSION]): SessionCatalogSnapshot {
  return { sessions, state: 'idle', refreshedAt: '2026-08-09T00:00:00.000Z' }
}

function maintenanceResult(): KnowledgeMaintenanceResult {
  const completedAt = '2026-07-26T00:00:01.000Z'
  return {
    stageId: 'knowledge_maintenance_agent',
    sourceRef: 'raw:source-record-1@sha256:test',
    activitySegmentCount: 1,
    run: {
      id: 'workspace-1',
      repositoryPath: '/tmp/oyster-repository',
      runPath: '/tmp/oyster-repository/runs/workspace-1',
      workPath: '/tmp/oyster-repository/runs/workspace-1/WORK.md',
      branchName: 'processing/workspace-1',
      targetBranch: 'main',
      baseRevision: 'b'.repeat(40)
    },
    previousRevision: 'b'.repeat(40),
    revision: 'c'.repeat(40),
    changedPaths: ['knowledge/raw-evidence.md'],
    agentRunId: 'maintenance-run-1',
    durationMs: 20,
    completedAt,
    execution: {
      connectionId: 'model:fixture',
      connectionName: 'Fixture',
      backendKind: 'api',
      providerId: 'openai_compatible',
      model: 'fixture-model',
      runtime: 'pi_agent_core',
      modelCallCount: 1,
      toolCalls: ['read_activity']
    }
  }
}

function installApis(
  overrides: Partial<KnowledgeProcessingApi> = {},
  discoveryOverrides: Partial<DiscoveryApi> = {}
) {
  const runKnowledgeMaintenance = vi.fn(async (_input: RunKnowledgeMaintenanceInput) => ({
    status: 'completed' as const,
    result: maintenanceResult()
  }))
  const knowledgeProcessing: KnowledgeProcessingApi = {
    getSnapshot: async () => SNAPSHOT,
    saveStage: async () => SNAPSHOT,
    saveDefaultInstructions: async () => SNAPSHOT,
    runKnowledgeMaintenance,
    runFullChain: async () => ({
      status: 'session_rejected',
      reason: 'unavailable',
      message: 'Session unavailable'
    }),
    listFullChainRuns: async () => [],
    readFullChainRun: async () => undefined,
    cancelFullChain: async () => undefined,
    cancelRun: async () => undefined,
    subscribe: () => () => undefined,
    ...overrides
  }
  const discovery: DiscoveryApi = {
    getSnapshot: async () => discoverySnapshot(),
    getSessionCatalog: async () => sessionCatalog(),
    refreshSessionCatalog: async () => sessionCatalog(),
    detectAgents: async () => discoverySnapshot(),
    scanSource: async () => discoverySnapshot(),
    cancelRun: async () => discoverySnapshot(),
    chooseSourceRoot: async () => discoverySnapshot(),
    subscribe: () => () => undefined,
    subscribeSessionCatalog: () => () => undefined,
    ...discoveryOverrides
  }
  vi.stubGlobal('window', { oyster: { knowledgeProcessing, discovery } })
  return { runKnowledgeMaintenance }
}

afterEach(() => vi.unstubAllGlobals())

describe('knowledge processing controller', () => {
  it('runs Maintainer directly from an immutable Session revision', async () => {
    const { runKnowledgeMaintenance } = installApis()
    await createRoot(async (dispose) => {
      try {
        const controller = createKnowledgeProcessingController()
        await vi.waitFor(() => expect(controller.sessionsLoading()).toBe(false))
        await controller.runKnowledgeMaintenance({
          sourceRecordId: SESSION.sourceRecordId,
          expectedRevision: SESSION.revision,
          attention: 'Inspect Skill activations.'
        })

        expect(runKnowledgeMaintenance).toHaveBeenCalledWith({
          sourceRecordId: SESSION.sourceRecordId,
          expectedRevision: SESSION.revision,
          attention: 'Inspect Skill activations.'
        })
        expect(controller.maintenanceResult()?.activitySegmentCount).toBe(1)
        expect(controller.maintenanceResult()?.revision).toBe('c'.repeat(40))
        controller.invalidateInputResults()
        expect(controller.maintenanceResult()).toBeUndefined()
      } finally {
        dispose()
      }
    })
  })

  it('keeps stage pending state local until the API call settles', async () => {
    let resolve!: (value: KnowledgeMaintenanceResult) => void
    const pending = new Promise<{
      status: 'completed'
      result: KnowledgeMaintenanceResult
    }>((done) => { resolve = (result) => done({ status: 'completed', result }) })
    installApis({ runKnowledgeMaintenance: async () => pending })
    await createRoot(async (dispose) => {
      try {
        const controller = createKnowledgeProcessingController()
        const run = controller.runKnowledgeMaintenance({
          sourceRecordId: SESSION.sourceRecordId,
          expectedRevision: SESSION.revision
        })
        expect(controller.isRunning('knowledge_maintenance_agent')).toBe(true)
        resolve(maintenanceResult())
        await run
        expect(controller.isRunning('knowledge_maintenance_agent')).toBe(false)
      } finally {
        dispose()
      }
    })
  })

  it('refreshes the authoritative Session catalog through one discovery operation', async () => {
    const refreshedSession = { ...SESSION, title: 'Refreshed Session' }
    const refreshSessionCatalog = vi.fn(async () => sessionCatalog([refreshedSession]))
    installApis({}, { refreshSessionCatalog })
    await createRoot(async (dispose) => {
      try {
        const controller = createKnowledgeProcessingController()
        await vi.waitFor(() => expect(controller.sessionsLoading()).toBe(false))

        await expect(controller.refreshAvailableSessions()).resolves.toBe(true)

        expect(refreshSessionCatalog).toHaveBeenCalledOnce()
        expect(controller.availableSessions()).toEqual([refreshedSession])
      } finally {
        dispose()
      }
    })
  })

  it('shows a structured Session rejection without exposing an IPC exception', async () => {
    installApis({
      runKnowledgeMaintenance: async () => ({
        status: 'session_rejected',
        reason: 'changed',
        message: '所选 Session 已更新，请重新选择'
      })
    })
    await createRoot(async (dispose) => {
      try {
        const controller = createKnowledgeProcessingController()
        await controller.runKnowledgeMaintenance({
          sourceRecordId: SESSION.sourceRecordId,
          expectedRevision: SESSION.revision
        })

        expect(controller.error()).toBe('所选 Session 已更新，请重新选择')
        expect(controller.maintenanceResult()).toBeUndefined()
      } finally {
        dispose()
      }
    })
  })
})

import { createRoot } from 'solid-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AvailableSessionSummary,
  DiscoveryApi,
  DiscoverySnapshot
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
    runs: [],
    sessionCatalogVersion: 1
  }
}

function maintenanceResult(): KnowledgeMaintenanceResult {
  const completedAt = '2026-07-26T00:00:01.000Z'
  return {
    stageId: 'knowledge_maintenance_agent',
    sourceRef: 'raw:source-record-1@sha256:test',
    activitySegmentCount: 1,
    workspace: {
      id: 'workspace-1',
      worktreePath: '/tmp/oyster-worktree',
      branchName: 'collaboration/workspace-1',
      targetBranch: 'main',
      baseRevision: 'a'.repeat(40),
      workOrderRevision: 'b'.repeat(40)
    },
    previousRevision: 'b'.repeat(40),
    revision: 'c'.repeat(40),
    changedPaths: ['.oyster/WORK.md', 'knowledge/raw-evidence.md'],
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

function installApis(overrides: Partial<KnowledgeProcessingApi> = {}) {
  const runKnowledgeMaintenance = vi.fn(async (_input: RunKnowledgeMaintenanceInput) => maintenanceResult())
  const knowledgeProcessing: KnowledgeProcessingApi = {
    getSnapshot: async () => SNAPSHOT,
    saveStage: async () => SNAPSHOT,
    saveDefaultInstructions: async () => SNAPSHOT,
    runKnowledgeMaintenance,
    runFullChain: async () => undefined,
    listFullChainRuns: async () => [],
    readFullChainRun: async () => undefined,
    cancelFullChain: async () => undefined,
    cancelRun: async () => undefined,
    subscribe: () => () => undefined,
    ...overrides
  }
  const discovery: DiscoveryApi = {
    getSnapshot: async () => discoverySnapshot(),
    listAvailableSessions: async () => [SESSION],
    detectAgents: async () => discoverySnapshot(),
    scanSource: async () => discoverySnapshot(),
    cancelRun: async () => discoverySnapshot(),
    chooseSourceRoot: async () => discoverySnapshot(),
    subscribe: () => () => undefined
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
    const pending = new Promise<KnowledgeMaintenanceResult>((done) => { resolve = done })
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
})

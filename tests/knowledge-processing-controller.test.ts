import { createRoot } from 'solid-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  DiscoveryApi,
  DiscoveryStateView,
  SourceConversationCatalogView,
  SourceConversationSummary
} from '../src/shared/discovery'
import type {
  KnowledgeMaintenanceResult,
  KnowledgeProcessingApi,
  KnowledgeProcessingStateView,
  StartKnowledgeAgentPreviewInput
} from '../src/shared/knowledge-processing'
import { createKnowledgeProcessingController } from '../src/renderer/src/knowledge-processing-controller'

vi.mock('solid-js', async () => vi.importActual('solid-js/dist/solid.js'))

const SOURCE_CONVERSATION: SourceConversationSummary = {
  sourceConversationId: 'source-conversation-1',
  sourceId: 'source-1',
  agentType: 'codex',
  sourceDisplayName: 'Codex',
  providerConversationId: 'conversation-1',
  title: 'Conversation one',
  sizeBytes: 120,
  sourceRevision: 'a'.repeat(64)
}

const STATE: KnowledgeProcessingStateView = {
  agents: [],
  connections: [],
  activeAgentIds: [],
  liveInvocations: []
}

function discoveryState(): DiscoveryStateView {
  return { sources: [], scans: [] }
}

function sourceConversationCatalog(
  conversations = [SOURCE_CONVERSATION]
): SourceConversationCatalogView {
  return {
    conversations,
    status: 'idle',
    refreshedAt: '2026-08-09T00:00:00.000Z'
  }
}

function maintenanceResult(): KnowledgeMaintenanceResult {
  const completedAt = '2026-07-26T00:00:01.000Z'
  return {
    agentId: 'knowledge_maintainer',
    sourceRef: 'raw:source-conversation-1@sha256:test',
    activitySegmentCount: 1,
    workspace: {
      taskId: 'task-1',
      repositoryPath: '/tmp/oyster-repository',
      workspacePath: '/tmp/oyster-repository/tasks/task-1',
      briefPath: '/tmp/oyster-repository/tasks/task-1/BRIEF.md',
      progressPath: '/tmp/oyster-repository/tasks/task-1/PROGRESS.md',
      inputPath: '/tmp/oyster-repository/tasks/task-1/inputs',
      workspaceRevision: 'd'.repeat(40),
      branchName: 'knowledge-task/task-1',
      targetBranch: 'main',
      baseRepositoryRevision: 'b'.repeat(40)
    },
    previousRepositoryRevision: 'b'.repeat(40),
    candidateRepositoryRevision: 'c'.repeat(40),
    changedPaths: ['knowledge/raw-evidence.md'],
    agentInvocationId: 'maintenance-invocation-1',
    durationMs: 20,
    completedAt,
    invocation: {
      connectionId: 'model:fixture',
      connectionName: 'Fixture',
      backendKind: 'api',
      providerId: 'openai_compatible',
      model: 'fixture-model',
      runtime: 'pi_coding_agent',
      modelCallCount: 1,
      toolCalls: ['read']
    }
  }
}

function installApis(
  overrides: Partial<KnowledgeProcessingApi> = {},
  discoveryOverrides: Partial<DiscoveryApi> = {}
) {
  const previewKnowledgeMaintainer = vi.fn(async (_input: StartKnowledgeAgentPreviewInput) => ({
    status: 'completed' as const,
    result: maintenanceResult()
  }))
  const knowledgeProcessing: KnowledgeProcessingApi = {
    getState: async () => STATE,
    saveAgent: async () => STATE,
    saveAgentDefaultInstructions: async () => STATE,
    previewKnowledgeMaintainer,
    startKnowledgeTask: async () => ({
      status: 'source_snapshot_rejected',
      reason: 'unavailable',
      message: 'Source Snapshot unavailable'
    }),
    listKnowledgeTasks: async () => [],
    readKnowledgeTask: async () => undefined,
    cancelKnowledgeTask: async () => undefined,
    cancelAgentPreview: async () => undefined,
    subscribe: () => () => undefined,
    ...overrides
  }
  const discovery: DiscoveryApi = {
    getState: async () => discoveryState(),
    getSourceConversationCatalog: async () => sourceConversationCatalog(),
    refreshSourceConversationCatalog: async () => sourceConversationCatalog(),
    detectAgents: async () => discoveryState(),
    scanSource: async () => discoveryState(),
    cancelScan: async () => discoveryState(),
    chooseSourceRoot: async () => discoveryState(),
    subscribe: () => () => undefined,
    subscribeSourceConversationCatalog: () => () => undefined,
    ...discoveryOverrides
  }
  vi.stubGlobal('window', { oyster: { knowledgeProcessing, discovery } })
  return { previewKnowledgeMaintainer }
}

afterEach(() => vi.unstubAllGlobals())

describe('knowledge processing controller', () => {
  it('previews Maintainer from an immutable Source Snapshot', async () => {
    const { previewKnowledgeMaintainer } = installApis()
    await createRoot(async (dispose) => {
      try {
        const controller = createKnowledgeProcessingController()
        await vi.waitFor(() => expect(controller.sourceConversationsLoading()).toBe(false))
        await controller.previewKnowledgeMaintainer({
          sourceConversationId: SOURCE_CONVERSATION.sourceConversationId,
          sourceRevision: SOURCE_CONVERSATION.sourceRevision,
          attention: 'Inspect Skill activations.'
        })

        expect(previewKnowledgeMaintainer).toHaveBeenCalledWith({
          sourceConversationId: SOURCE_CONVERSATION.sourceConversationId,
          sourceRevision: SOURCE_CONVERSATION.sourceRevision,
          attention: 'Inspect Skill activations.'
        })
        expect(controller.maintenanceResult()?.activitySegmentCount).toBe(1)
        expect(controller.maintenanceResult()?.candidateRepositoryRevision).toBe('c'.repeat(40))
        controller.invalidatePreviewResult()
        expect(controller.maintenanceResult()).toBeUndefined()
      } finally {
        dispose()
      }
    })
  })

  it('keeps the pending Invocation state local until the API call settles', async () => {
    let resolve!: (value: KnowledgeMaintenanceResult) => void
    const pending = new Promise<{
      status: 'completed'
      result: KnowledgeMaintenanceResult
    }>((done) => { resolve = (result) => done({ status: 'completed', result }) })
    installApis({ previewKnowledgeMaintainer: async () => pending })
    await createRoot(async (dispose) => {
      try {
        const controller = createKnowledgeProcessingController()
        const preview = controller.previewKnowledgeMaintainer({
          sourceConversationId: SOURCE_CONVERSATION.sourceConversationId,
          sourceRevision: SOURCE_CONVERSATION.sourceRevision
        })
        expect(controller.hasActiveInvocation('knowledge_maintainer')).toBe(true)
        resolve(maintenanceResult())
        await preview
        expect(controller.hasActiveInvocation('knowledge_maintainer')).toBe(false)
      } finally {
        dispose()
      }
    })
  })

  it('refreshes the authoritative Source Conversation catalog', async () => {
    const refreshed = { ...SOURCE_CONVERSATION, title: 'Refreshed Conversation' }
    const refreshSourceConversationCatalog = vi.fn(async () => (
      sourceConversationCatalog([refreshed])
    ))
    installApis({}, { refreshSourceConversationCatalog })
    await createRoot(async (dispose) => {
      try {
        const controller = createKnowledgeProcessingController()
        await vi.waitFor(() => expect(controller.sourceConversationsLoading()).toBe(false))

        await expect(controller.refreshSourceConversations()).resolves.toBe(true)

        expect(refreshSourceConversationCatalog).toHaveBeenCalledOnce()
        expect(controller.sourceConversations()).toEqual([refreshed])
      } finally {
        dispose()
      }
    })
  })

  it('shows a structured Source Snapshot rejection without exposing an IPC exception', async () => {
    installApis({
      previewKnowledgeMaintainer: async () => ({
        status: 'source_snapshot_rejected',
        reason: 'changed',
        message: '所选 Source Snapshot 已更新，请重新选择'
      })
    })
    await createRoot(async (dispose) => {
      try {
        const controller = createKnowledgeProcessingController()
        await controller.previewKnowledgeMaintainer({
          sourceConversationId: SOURCE_CONVERSATION.sourceConversationId,
          sourceRevision: SOURCE_CONVERSATION.sourceRevision
        })

        expect(controller.error()).toBe('所选 Source Snapshot 已更新，请重新选择')
        expect(controller.maintenanceResult()).toBeUndefined()
      } finally {
        dispose()
      }
    })
  })
})

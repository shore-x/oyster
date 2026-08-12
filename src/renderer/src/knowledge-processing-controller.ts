import { createSignal, onCleanup } from 'solid-js'
import type { SourceConversationCatalogView } from '../../shared/discovery'
import type {
  AgentInvocationOrigin,
  KnowledgeAgentId,
  KnowledgeMaintenanceResult,
  KnowledgeProcessingStateView,
  KnowledgeTaskDetail,
  KnowledgeTaskResult,
  KnowledgeTaskSummary,
  LiveAgentInvocationView,
  SaveKnowledgeAgentInput,
  StartKnowledgeAgentPreviewInput,
  StartKnowledgeTaskInput
} from '../../shared/knowledge-processing'

const EMPTY_STATE: KnowledgeProcessingStateView = {
  agents: [],
  connections: [],
  activeAgentIds: [],
  liveInvocations: []
}

const EMPTY_SOURCE_CONVERSATION_CATALOG: SourceConversationCatalogView = {
  conversations: [],
  status: 'idle'
}

export function createKnowledgeProcessingController() {
  const [state, setState] = createSignal(EMPTY_STATE)
  const [pendingAgentIds, setPendingAgentIds] = createSignal<KnowledgeAgentId[]>([])
  const [savingAgentIds, setSavingAgentIds] = createSignal<KnowledgeAgentId[]>([])
  const [error, setError] = createSignal<string>()
  const [maintenanceResult, setMaintenanceResult] = createSignal<KnowledgeMaintenanceResult>()
  const [sourceConversationCatalog, setSourceConversationCatalog] = createSignal(
    EMPTY_SOURCE_CONVERSATION_CATALOG
  )
  const [sourceConversationCatalogLoading, setSourceConversationCatalogLoading] = createSignal(true)
  const [sourceConversationCatalogRefreshing, setSourceConversationCatalogRefreshing] = createSignal(false)
  const [knowledgeTaskPending, setKnowledgeTaskPending] = createSignal(false)
  const [knowledgeTaskResult, setKnowledgeTaskResult] = createSignal<KnowledgeTaskResult>()
  const [knowledgeTasks, setKnowledgeTasks] = createSignal<KnowledgeTaskSummary[]>([])
  const [knowledgeTasksLoading, setKnowledgeTasksLoading] = createSignal(true)
  const [selectedKnowledgeTask, setSelectedKnowledgeTask] = createSignal<KnowledgeTaskDetail>()
  const [loadingKnowledgeTaskId, setLoadingKnowledgeTaskId] = createSignal<string>()
  const [hiddenPreviewInvocationId, setHiddenPreviewInvocationId] = createSignal<string>()
  let taskReadGeneration = 0

  function errorMessage(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause)
  }

  function markPending(agentId: KnowledgeAgentId, pending: boolean): void {
    setPendingAgentIds((current) => pending
      ? current.includes(agentId) ? current : [...current, agentId]
      : current.filter((candidate) => candidate !== agentId))
  }

  function markSaving(agentId: KnowledgeAgentId, saving: boolean): void {
    setSavingAgentIds((current) => {
      if (saving) return current.includes(agentId) ? current : [...current, agentId]
      return current.filter((candidate) => candidate !== agentId)
    })
  }

  function hasActiveInvocation(agentId: KnowledgeAgentId): boolean {
    return pendingAgentIds().includes(agentId) || state().activeAgentIds.includes(agentId)
  }

  function invalidatePreviewResult(): void {
    const previewInvocations = state().liveInvocations.filter(
      (view) => view.origin === 'agent_preview'
    )
    setHiddenPreviewInvocationId(previewInvocations.at(-1)?.invocation.invocationId)
    setMaintenanceResult(undefined)
  }

  function resetKnowledgeTaskResult(): void {
    setKnowledgeTaskResult(undefined)
  }

  function liveInvocations(origin: AgentInvocationOrigin): LiveAgentInvocationView[] {
    return state().liveInvocations.filter((view) => (
      view.origin === origin
      && !(
        origin === 'agent_preview'
        && view.invocation.invocationId === hiddenPreviewInvocationId()
        && view.invocation.status !== 'in_progress'
      )
    ))
  }

  function latestInvocation(origin: AgentInvocationOrigin): LiveAgentInvocationView | undefined {
    return liveInvocations(origin).at(-1)
  }

  let receivedState = false
  const unsubscribe = window.oyster.knowledgeProcessing.subscribe((nextState) => {
    receivedState = true
    setState(nextState)
  })
  void window.oyster.knowledgeProcessing.getState()
    .then((initialState) => {
      if (!receivedState) setState(initialState)
    })
    .catch((cause) => setError(errorMessage(cause)))

  let receivedCatalog = false
  const unsubscribeSourceConversationCatalog = window.oyster.discovery
    .subscribeSourceConversationCatalog((catalog) => {
      receivedCatalog = true
      setSourceConversationCatalog(catalog)
      setSourceConversationCatalogLoading(false)
    })
  void loadKnowledgeTasks()
  void window.oyster.discovery.getSourceConversationCatalog()
    .then((catalog) => {
      if (!receivedCatalog) setSourceConversationCatalog(catalog)
    })
    .catch((cause) => setError(errorMessage(cause)))
    .finally(() => setSourceConversationCatalogLoading(false))

  onCleanup(() => {
    unsubscribe()
    unsubscribeSourceConversationCatalog()
  })

  async function refreshSourceConversations(): Promise<boolean> {
    try {
      setSourceConversationCatalogRefreshing(true)
      setError(undefined)
      setSourceConversationCatalog(
        await window.oyster.discovery.refreshSourceConversationCatalog()
      )
      return true
    } catch (cause) {
      setError(errorMessage(cause))
      return false
    } finally {
      setSourceConversationCatalogRefreshing(false)
    }
  }

  async function loadKnowledgeTasks(): Promise<void> {
    try {
      setKnowledgeTasksLoading(true)
      setError(undefined)
      setKnowledgeTasks(await window.oyster.knowledgeProcessing.listKnowledgeTasks())
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setKnowledgeTasksLoading(false)
    }
  }

  async function readKnowledgeTask(taskId: string): Promise<KnowledgeTaskDetail | undefined> {
    const generation = ++taskReadGeneration
    try {
      setLoadingKnowledgeTaskId(taskId)
      setError(undefined)
      const record = await window.oyster.knowledgeProcessing.readKnowledgeTask(taskId)
      if (generation !== taskReadGeneration) return undefined
      setSelectedKnowledgeTask(record)
      return record
    } catch (cause) {
      if (generation === taskReadGeneration) setError(errorMessage(cause))
      return undefined
    } finally {
      if (generation === taskReadGeneration) setLoadingKnowledgeTaskId(undefined)
    }
  }

  async function saveAgent(input: SaveKnowledgeAgentInput): Promise<boolean> {
    try {
      markSaving(input.agentId, true)
      setError(undefined)
      setState(await window.oyster.knowledgeProcessing.saveAgent(input))
      return true
    } catch (cause) {
      setError(errorMessage(cause))
      return false
    } finally {
      markSaving(input.agentId, false)
    }
  }

  async function previewKnowledgeMaintainer(
    input: StartKnowledgeAgentPreviewInput
  ): Promise<void> {
    const agentId = 'knowledge_maintainer' as const
    try {
      markPending(agentId, true)
      setError(undefined)
      const response = await window.oyster.knowledgeProcessing.previewKnowledgeMaintainer(input)
      if (response.status === 'source_snapshot_rejected') setError(response.message)
      else setMaintenanceResult(response.result)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      markPending(agentId, false)
    }
  }

  async function cancelAgentPreview(agentId: KnowledgeAgentId): Promise<void> {
    try {
      setError(undefined)
      await window.oyster.knowledgeProcessing.cancelAgentPreview(agentId)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  async function startKnowledgeTask(input: StartKnowledgeTaskInput): Promise<void> {
    try {
      setKnowledgeTaskPending(true)
      setError(undefined)
      const response = await window.oyster.knowledgeProcessing.startKnowledgeTask(input)
      if (response.status === 'source_snapshot_rejected') {
        setError(response.message)
      } else {
        setKnowledgeTaskResult(response.result)
        await loadKnowledgeTasks()
      }
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setKnowledgeTaskPending(false)
    }
  }

  async function cancelKnowledgeTask(): Promise<void> {
    try {
      setError(undefined)
      await window.oyster.knowledgeProcessing.cancelKnowledgeTask()
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  return {
    state,
    isSaving: (agentId: KnowledgeAgentId) => savingAgentIds().includes(agentId),
    error,
    maintenanceResult,
    sourceConversations: () => sourceConversationCatalog().conversations,
    sourceConversationsLoading: () => (
      sourceConversationCatalogLoading()
      || sourceConversationCatalogRefreshing()
      || sourceConversationCatalog().status === 'refreshing'
    ),
    sourceConversationCatalogError: () => sourceConversationCatalog().errorMessage,
    knowledgeTaskResult,
    knowledgeTasks,
    knowledgeTasksLoading,
    selectedKnowledgeTask,
    liveInvocations,
    latestInvocation,
    isKnowledgeTaskActive: knowledgeTaskPending,
    isLoadingKnowledgeTask: (taskId: string) => loadingKnowledgeTaskId() === taskId,
    invalidatePreviewResult,
    resetKnowledgeTaskResult,
    hasActiveInvocation,
    saveAgent,
    previewKnowledgeMaintainer,
    cancelAgentPreview,
    refreshSourceConversations,
    loadKnowledgeTasks,
    readKnowledgeTask,
    startKnowledgeTask,
    cancelKnowledgeTask
  }
}

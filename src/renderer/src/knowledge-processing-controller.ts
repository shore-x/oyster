import { createSignal, onCleanup } from 'solid-js'
import type { SessionCatalogSnapshot } from '../../shared/discovery'
import type {
  KnowledgeFullChainResult,
  KnowledgeFullChainRunRecord,
  KnowledgeFullChainRunSummary,
  KnowledgeMaintenanceResult,
  KnowledgeProcessingDebugTrace,
  KnowledgeProcessingSnapshot,
  ProcessingDebugTraceOrigin,
  ProcessingStageId,
  RunKnowledgeFullChainInput,
  RunKnowledgeMaintenanceInput,
  SaveProcessingStageInput
} from '../../shared/knowledge-processing'

const EMPTY_SNAPSHOT: KnowledgeProcessingSnapshot = {
  stages: [],
  connections: [],
  runningStageIds: [],
  debugTraces: []
}

const EMPTY_SESSION_CATALOG: SessionCatalogSnapshot = {
  sessions: [],
  state: 'idle'
}

export function createKnowledgeProcessingController() {
  const [snapshot, setSnapshot] = createSignal(EMPTY_SNAPSHOT)
  const [pendingStageIds, setPendingStageIds] = createSignal<ProcessingStageId[]>([])
  const [savingStageIds, setSavingStageIds] = createSignal<ProcessingStageId[]>([])
  const [error, setError] = createSignal<string>()
  const [maintenanceResult, setMaintenanceResult] = createSignal<KnowledgeMaintenanceResult>()
  const [sessionCatalog, setSessionCatalog] = createSignal(EMPTY_SESSION_CATALOG)
  const [sessionCatalogLoading, setSessionCatalogLoading] = createSignal(true)
  const [sessionCatalogRefreshing, setSessionCatalogRefreshing] = createSignal(false)
  const [fullChainPending, setFullChainPending] = createSignal(false)
  const [fullChainResult, setFullChainResult] = createSignal<KnowledgeFullChainResult>()
  const [fullChainRuns, setFullChainRuns] = createSignal<KnowledgeFullChainRunSummary[]>([])
  const [fullChainRunsLoading, setFullChainRunsLoading] = createSignal(true)
  const [selectedFullChainRun, setSelectedFullChainRun] = createSignal<KnowledgeFullChainRunRecord>()
  const [loadingFullChainRunId, setLoadingFullChainRunId] = createSignal<string>()
  const [hiddenStageDebugTraceId, setHiddenStageDebugTraceId] = createSignal<string>()
  let fullChainRunReadGeneration = 0

  function errorMessage(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause)
  }

  function markPending(stageId: ProcessingStageId, pending: boolean): void {
    setPendingStageIds((current) => pending
      ? current.includes(stageId) ? current : [...current, stageId]
      : current.filter((candidate) => candidate !== stageId))
  }

  function markSaving(stageId: ProcessingStageId, saving: boolean): void {
    setSavingStageIds((current) => {
      if (saving) return [...current, stageId]
      const index = current.indexOf(stageId)
      return index < 0 ? current : [...current.slice(0, index), ...current.slice(index + 1)]
    })
  }

  function isRunning(stageId: ProcessingStageId): boolean {
    return pendingStageIds().includes(stageId) || snapshot().runningStageIds.includes(stageId)
  }

  function invalidateInputResults(): void {
    const stageTraces = snapshot().debugTraces.filter((trace) => trace.origin === 'stage_debug')
    const currentTrace = stageTraces[stageTraces.length - 1]
    setHiddenStageDebugTraceId(currentTrace?.run.id)
    setMaintenanceResult(undefined)
  }

  function resetFullChainResult(): void {
    setFullChainResult(undefined)
  }

  function debugTraces(origin: ProcessingDebugTraceOrigin): KnowledgeProcessingDebugTrace[] {
    return snapshot().debugTraces.filter((trace) => (
      trace.origin === origin
      && !(
        origin === 'stage_debug'
        && trace.run.id === hiddenStageDebugTraceId()
        && trace.run.status !== 'running'
      )
    ))
  }

  function debugTrace(origin: ProcessingDebugTraceOrigin): KnowledgeProcessingDebugTrace | undefined {
    const traces = debugTraces(origin)
    return traces[traces.length - 1]
  }

  let receivedSubscriptionSnapshot = false
  const unsubscribe = window.oyster.knowledgeProcessing.subscribe((nextSnapshot) => {
    receivedSubscriptionSnapshot = true
    setSnapshot(nextSnapshot)
  })
  void window.oyster.knowledgeProcessing.getSnapshot()
    .then((initialSnapshot) => {
      if (!receivedSubscriptionSnapshot) setSnapshot(initialSnapshot)
    })
    .catch((cause) => setError(errorMessage(cause)))

  let receivedSessionCatalog = false
  const unsubscribeSessionCatalog = window.oyster.discovery.subscribeSessionCatalog((nextCatalog) => {
    receivedSessionCatalog = true
    setSessionCatalog(nextCatalog)
    setSessionCatalogLoading(false)
  })
  void loadFullChainRuns()
  void window.oyster.discovery.getSessionCatalog()
    .then((initialCatalog) => {
      if (!receivedSessionCatalog) setSessionCatalog(initialCatalog)
    })
    .catch((cause) => setError(errorMessage(cause)))
    .finally(() => setSessionCatalogLoading(false))

  onCleanup(() => {
    unsubscribe()
    unsubscribeSessionCatalog()
  })

  async function refreshAvailableSessions(): Promise<boolean> {
    try {
      setSessionCatalogRefreshing(true)
      setError(undefined)
      setSessionCatalog(await window.oyster.discovery.refreshSessionCatalog())
      return true
    } catch (cause) {
      setError(errorMessage(cause))
      return false
    } finally {
      setSessionCatalogRefreshing(false)
    }
  }

  async function loadFullChainRuns(): Promise<void> {
    try {
      setFullChainRunsLoading(true)
      setError(undefined)
      setFullChainRuns(await window.oyster.knowledgeProcessing.listFullChainRuns())
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setFullChainRunsLoading(false)
    }
  }

  async function readFullChainRun(runId: string): Promise<KnowledgeFullChainRunRecord | undefined> {
    const generation = ++fullChainRunReadGeneration
    try {
      setLoadingFullChainRunId(runId)
      setError(undefined)
      const record = await window.oyster.knowledgeProcessing.readFullChainRun(runId)
      if (generation !== fullChainRunReadGeneration) return undefined
      setSelectedFullChainRun(record)
      return record
    } catch (cause) {
      if (generation === fullChainRunReadGeneration) setError(errorMessage(cause))
      return undefined
    } finally {
      if (generation === fullChainRunReadGeneration) setLoadingFullChainRunId(undefined)
    }
  }

  async function saveStage(input: SaveProcessingStageInput): Promise<boolean> {
    try {
      markSaving(input.stageId, true)
      setError(undefined)
      setSnapshot(await window.oyster.knowledgeProcessing.saveStage(input))
      return true
    } catch (cause) {
      setError(errorMessage(cause))
      return false
    } finally {
      markSaving(input.stageId, false)
    }
  }

  async function runKnowledgeMaintenance(input: RunKnowledgeMaintenanceInput): Promise<void> {
    const stageId = 'knowledge_maintenance_agent' as const
    try {
      markPending(stageId, true)
      setError(undefined)
      const response = await window.oyster.knowledgeProcessing.runKnowledgeMaintenance(input)
      if (response.status === 'session_rejected') setError(response.message)
      else setMaintenanceResult(response.result)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      markPending(stageId, false)
    }
  }

  async function cancelRun(stageId: ProcessingStageId): Promise<void> {
    try {
      setError(undefined)
      await window.oyster.knowledgeProcessing.cancelRun(stageId)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  async function runFullChain(input: RunKnowledgeFullChainInput): Promise<void> {
    try {
      setFullChainPending(true)
      setError(undefined)
      const response = await window.oyster.knowledgeProcessing.runFullChain(input)
      if (response.status === 'session_rejected') {
        setError(response.message)
      } else {
        setFullChainResult(response.result)
        await loadFullChainRuns()
      }
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setFullChainPending(false)
    }
  }

  async function cancelFullChain(): Promise<void> {
    try {
      setError(undefined)
      await window.oyster.knowledgeProcessing.cancelFullChain()
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  return {
    snapshot,
    isSaving: (stageId: ProcessingStageId) => savingStageIds().includes(stageId),
    error,
    maintenanceResult,
    availableSessions: () => sessionCatalog().sessions,
    sessionsLoading: () => (
      sessionCatalogLoading()
      || sessionCatalogRefreshing()
      || sessionCatalog().state === 'refreshing'
    ),
    sessionCatalogError: () => sessionCatalog().errorMessage,
    fullChainResult,
    fullChainRuns,
    fullChainRunsLoading,
    selectedFullChainRun,
    debugTraces,
    debugTrace,
    isFullChainRunning: fullChainPending,
    isLoadingFullChainRun: (runId: string) => loadingFullChainRunId() === runId,
    invalidateInputResults,
    resetFullChainResult,
    isRunning,
    saveStage,
    runKnowledgeMaintenance,
    cancelRun,
    refreshAvailableSessions,
    loadFullChainRuns,
    readFullChainRun,
    runFullChain,
    cancelFullChain
  }
}

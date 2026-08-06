import { createSignal, onCleanup } from 'solid-js'
import type { AvailableSessionSummary, DiscoverySnapshot } from '../../shared/discovery'
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

function sessionCatalogRevision(snapshot: DiscoverySnapshot): string {
  const sources = [...snapshot.sources]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((source) => [
      source.id,
      source.rootPath,
      source.discoveryState,
      source.sessionCount,
      source.lastScannedAt
    ])
  return JSON.stringify([snapshot.sessionCatalogVersion, sources])
}

export function createKnowledgeProcessingController() {
  const [snapshot, setSnapshot] = createSignal(EMPTY_SNAPSHOT)
  const [pendingStageIds, setPendingStageIds] = createSignal<ProcessingStageId[]>([])
  const [savingStageIds, setSavingStageIds] = createSignal<ProcessingStageId[]>([])
  const [error, setError] = createSignal<string>()
  const [maintenanceResult, setMaintenanceResult] = createSignal<KnowledgeMaintenanceResult>()
  const [availableSessions, setAvailableSessions] = createSignal<AvailableSessionSummary[]>([])
  const [sessionsLoading, setSessionsLoading] = createSignal(true)
  const [fullChainPending, setFullChainPending] = createSignal(false)
  const [fullChainResult, setFullChainResult] = createSignal<KnowledgeFullChainResult>()
  const [fullChainRuns, setFullChainRuns] = createSignal<KnowledgeFullChainRunSummary[]>([])
  const [fullChainRunsLoading, setFullChainRunsLoading] = createSignal(true)
  const [selectedFullChainRun, setSelectedFullChainRun] = createSignal<KnowledgeFullChainRunRecord>()
  const [loadingFullChainRunId, setLoadingFullChainRunId] = createSignal<string>()
  const [hiddenStageDebugTraceId, setHiddenStageDebugTraceId] = createSignal<string>()
  let sessionLoadRevision = 0
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
    const currentTrace = snapshot().debugTraces.find((trace) => trace.origin === 'stage_debug')
    setHiddenStageDebugTraceId(currentTrace?.run.id)
    setMaintenanceResult(undefined)
  }

  function resetFullChainResult(): void {
    setFullChainResult(undefined)
  }

  function debugTrace(origin: ProcessingDebugTraceOrigin): KnowledgeProcessingDebugTrace | undefined {
    const trace = snapshot().debugTraces.find((candidate) => candidate.origin === origin)
    if (
      origin === 'stage_debug'
      && trace
      && trace.run.id === hiddenStageDebugTraceId()
      && trace.run.status !== 'running'
    ) {
      return undefined
    }
    return trace
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

  let receivedDiscoverySnapshot = false
  let catalogRevision: string | undefined
  const updateAvailableSessions = (discoverySnapshot: DiscoverySnapshot): void => {
    const nextRevision = sessionCatalogRevision(discoverySnapshot)
    if (nextRevision === catalogRevision) return
    catalogRevision = nextRevision
    void loadAvailableSessions()
  }
  const unsubscribeDiscovery = window.oyster.discovery.subscribe((discoverySnapshot) => {
    receivedDiscoverySnapshot = true
    updateAvailableSessions(discoverySnapshot)
  })
  void loadAvailableSessions()
  void loadFullChainRuns()
  void window.oyster.discovery.getSnapshot()
    .then((discoverySnapshot) => {
      if (!receivedDiscoverySnapshot) updateAvailableSessions(discoverySnapshot)
    })
    .catch((cause) => setError(errorMessage(cause)))

  onCleanup(() => {
    unsubscribe()
    unsubscribeDiscovery()
  })

  async function loadAvailableSessions(): Promise<void> {
    const revision = ++sessionLoadRevision
    try {
      setSessionsLoading(true)
      const sessions = await window.oyster.discovery.listAvailableSessions()
      if (revision === sessionLoadRevision) setAvailableSessions(sessions)
    } catch (cause) {
      if (revision === sessionLoadRevision) setError(errorMessage(cause))
    } finally {
      if (revision === sessionLoadRevision) setSessionsLoading(false)
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
      const result = await window.oyster.knowledgeProcessing.runKnowledgeMaintenance(input)
      if (result) setMaintenanceResult(result)
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
      const result = await window.oyster.knowledgeProcessing.runFullChain(input)
      if (result) {
        setFullChainResult(result)
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
    availableSessions,
    sessionsLoading,
    fullChainResult,
    fullChainRuns,
    fullChainRunsLoading,
    selectedFullChainRun,
    debugTrace,
    isFullChainRunning: fullChainPending,
    isLoadingFullChainRun: (runId: string) => loadingFullChainRunId() === runId,
    invalidateInputResults,
    resetFullChainResult,
    isRunning,
    saveStage,
    runKnowledgeMaintenance,
    cancelRun,
    loadAvailableSessions,
    loadFullChainRuns,
    readFullChainRun,
    runFullChain,
    cancelFullChain
  }
}

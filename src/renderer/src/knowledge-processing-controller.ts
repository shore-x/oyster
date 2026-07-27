import { createSignal, onCleanup } from 'solid-js'
import type { AvailableSessionSummary, DiscoverySnapshot } from '../../shared/discovery'
import type {
  KnowledgeFullChainResult,
  KnowledgeMaintenanceResult,
  KnowledgeProcessingDebugTrace,
  KnowledgeProcessingSnapshot,
  ObservationPreprocessingResult,
  ProcessingDebugTraceOrigin,
  ProcessingStageId,
  RunKnowledgeFullChainInput,
  RunSessionPreprocessorInput,
  RunKnowledgeMaintenanceInput,
  RunObservationPreprocessorInput,
  SaveProcessingStageInput
} from '../../shared/knowledge-processing'

const EMPTY_SNAPSHOT: KnowledgeProcessingSnapshot = {
  stages: [],
  connections: [],
  runningStageIds: [],
  debugTraces: []
}

function sessionCatalogRevision(snapshot: DiscoverySnapshot): string {
  return JSON.stringify([...snapshot.sources]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((source) => [
      source.id,
      source.rootPath,
      source.discoveryState,
      source.sessionCount,
      source.lastScannedAt
    ]))
}

export function createKnowledgeProcessingController() {
  const [snapshot, setSnapshot] = createSignal(EMPTY_SNAPSHOT)
  const [pendingStageIds, setPendingStageIds] = createSignal<ProcessingStageId[]>([])
  const [savingStageIds, setSavingStageIds] = createSignal<ProcessingStageId[]>([])
  const [error, setError] = createSignal<string>()
  const [preprocessingResult, setPreprocessingResult] = createSignal<ObservationPreprocessingResult>()
  const [maintenanceResult, setMaintenanceResult] = createSignal<KnowledgeMaintenanceResult>()
  const [availableSessions, setAvailableSessions] = createSignal<AvailableSessionSummary[]>([])
  const [sessionsLoading, setSessionsLoading] = createSignal(true)
  const [inspectingSessionIds, setInspectingSessionIds] = createSignal<string[]>([])
  const [sessionInspectionErrors, setSessionInspectionErrors] = createSignal<Record<string, string>>({})
  const [fullChainPending, setFullChainPending] = createSignal(false)
  const [fullChainResult, setFullChainResult] = createSignal<KnowledgeFullChainResult>()
  const [discardingSandboxId, setDiscardingSandboxId] = createSignal<string>()
  const [hiddenStageDebugTraceId, setHiddenStageDebugTraceId] = createSignal<string>()
  const sessionInspectionTasks = new Map<string, Promise<void>>()
  let sessionLoadRevision = 0

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
    setHiddenStageDebugTraceId(currentTrace?.id)
    setPreprocessingResult(undefined)
    setMaintenanceResult(undefined)
  }

  function debugTrace(origin: ProcessingDebugTraceOrigin): KnowledgeProcessingDebugTrace | undefined {
    const trace = snapshot().debugTraces.find((candidate) => candidate.origin === origin)
    if (
      origin === 'stage_debug'
      && trace
      && trace.id === hiddenStageDebugTraceId()
      && trace.status !== 'running'
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

  function inspectAvailableSession(session: AvailableSessionSummary): Promise<void> {
    const knownSession = availableSessions().find((candidate) => (
      candidate.artifactId === session.artifactId && candidate.revision === session.revision
    ))
    if ((knownSession ?? session).messageCount !== undefined) return Promise.resolve()
    const key = `${session.artifactId}:${session.revision}`
    const currentTask = sessionInspectionTasks.get(key)
    if (currentTask) return currentTask

    const task = (async () => {
      try {
        setInspectingSessionIds((current) => current.includes(session.artifactId)
          ? current
          : [...current, session.artifactId])
        setSessionInspectionErrors((current) => {
          const next = { ...current }
          delete next[session.artifactId]
          return next
        })
        const inspected = await window.oyster.discovery.inspectAvailableSession({
          artifactId: session.artifactId,
          expectedRevision: session.revision
        })
        setAvailableSessions((current) => current.map((candidate) => (
          candidate.artifactId === inspected.artifactId
          && candidate.revision === inspected.revision
            ? inspected
            : candidate
        )))
      } catch (cause) {
        setSessionInspectionErrors((current) => ({
          ...current,
          [session.artifactId]: errorMessage(cause)
        }))
      } finally {
        sessionInspectionTasks.delete(key)
        setInspectingSessionIds((current) => current.filter(
          (artifactId) => artifactId !== session.artifactId
        ))
      }
    })()
    sessionInspectionTasks.set(key, task)
    return task
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

  async function runPreprocessor(
    run: () => Promise<ObservationPreprocessingResult | undefined>
  ): Promise<void> {
    const stageId = 'observation_preprocessor' as const
    try {
      markPending(stageId, true)
      setError(undefined)
      const result = await run()
      if (result) {
        setPreprocessingResult(result)
        setMaintenanceResult(undefined)
      }
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      markPending(stageId, false)
    }
  }

  async function runObservationPreprocessor(input: RunObservationPreprocessorInput): Promise<void> {
    await runPreprocessor(
      () => window.oyster.knowledgeProcessing.runObservationPreprocessor(input)
    )
  }

  async function runSessionPreprocessor(
    input: RunSessionPreprocessorInput
  ): Promise<void> {
    await runPreprocessor(
      () => window.oyster.knowledgeProcessing.runSessionPreprocessor(input)
    )
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
      if (result) setFullChainResult(result)
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

  async function discardSandbox(sandboxId: string): Promise<void> {
    try {
      setDiscardingSandboxId(sandboxId)
      setError(undefined)
      await window.oyster.knowledgeProcessing.discardSandbox(sandboxId)
      setFullChainResult((current) => current?.sandbox.id === sandboxId ? undefined : current)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setDiscardingSandboxId(undefined)
    }
  }

  return {
    snapshot,
    isSaving: (stageId: ProcessingStageId) => savingStageIds().includes(stageId),
    error,
    preprocessingResult,
    maintenanceResult,
    availableSessions,
    sessionsLoading,
    isInspectingSession: (artifactId: string) => inspectingSessionIds().includes(artifactId),
    sessionInspectionError: (artifactId: string) => sessionInspectionErrors()[artifactId],
    fullChainResult,
    debugTrace,
    isFullChainRunning: fullChainPending,
    isDiscardingSandbox: (sandboxId: string) => discardingSandboxId() === sandboxId,
    invalidateInputResults,
    isRunning,
    saveStage,
    runObservationPreprocessor,
    runSessionPreprocessor,
    runKnowledgeMaintenance,
    cancelRun,
    loadAvailableSessions,
    inspectAvailableSession,
    runFullChain,
    cancelFullChain,
    discardSandbox
  }
}

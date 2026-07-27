import { createSignal, onCleanup, onMount } from 'solid-js'
import type { AvailableSessionSummary } from '../../shared/discovery'
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

export function createKnowledgeProcessingController() {
  const [snapshot, setSnapshot] = createSignal(EMPTY_SNAPSHOT)
  const [pendingStageIds, setPendingStageIds] = createSignal<ProcessingStageId[]>([])
  const [savingStageIds, setSavingStageIds] = createSignal<ProcessingStageId[]>([])
  const [error, setError] = createSignal<string>()
  const [preprocessingResult, setPreprocessingResult] = createSignal<ObservationPreprocessingResult>()
  const [maintenanceResult, setMaintenanceResult] = createSignal<KnowledgeMaintenanceResult>()
  const [availableSessions, setAvailableSessions] = createSignal<AvailableSessionSummary[]>([])
  const [sessionsLoading, setSessionsLoading] = createSignal(true)
  const [fullChainPending, setFullChainPending] = createSignal(false)
  const [fullChainResult, setFullChainResult] = createSignal<KnowledgeFullChainResult>()
  const [discardingSandboxId, setDiscardingSandboxId] = createSignal<string>()
  const [hiddenStageDebugTraceId, setHiddenStageDebugTraceId] = createSignal<string>()

  function errorMessage(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause)
  }

  function markPending(stageId: ProcessingStageId, pending: boolean): void {
    setPendingStageIds((current) => pending
      ? current.includes(stageId) ? current : [...current, stageId]
      : current.filter((candidate) => candidate !== stageId))
  }

  function markSaving(stageId: ProcessingStageId, saving: boolean): void {
    setSavingStageIds((current) => saving
      ? current.includes(stageId) ? current : [...current, stageId]
      : current.filter((candidate) => candidate !== stageId))
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

  onMount(() => {
    const unsubscribe = window.oyster.knowledgeProcessing.subscribe(setSnapshot)
    void window.oyster.knowledgeProcessing.getSnapshot()
      .then(setSnapshot)
      .catch((cause) => setError(errorMessage(cause)))
    void loadAvailableSessions()
    onCleanup(unsubscribe)
  })

  async function loadAvailableSessions(): Promise<void> {
    try {
      setSessionsLoading(true)
      setAvailableSessions(await window.oyster.discovery.listAvailableSessions())
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSessionsLoading(false)
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
    runFullChain,
    cancelFullChain,
    discardSandbox
  }
}

import { createSignal, onCleanup } from 'solid-js'
import type {
  KnowledgeProcessingSnapshot,
  ProcessingStageId
} from '../../shared/knowledge-processing'

const EMPTY_SNAPSHOT: KnowledgeProcessingSnapshot = {
  stages: [],
  connections: [],
  runningStageIds: [],
  debugTraces: []
}

export function createAgentConfigurationController() {
  const [snapshot, setSnapshot] = createSignal<KnowledgeProcessingSnapshot>(EMPTY_SNAPSHOT)
  const [loading, setLoading] = createSignal(true)
  const [savingStageId, setSavingStageId] = createSignal<ProcessingStageId>()
  const [savedStageId, setSavedStageId] = createSignal<ProcessingStageId>()
  const [error, setError] = createSignal<string>()

  const errorMessage = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause)
  const unsubscribe = window.oyster.knowledgeProcessing.subscribe((next) => setSnapshot(next))
  onCleanup(unsubscribe)

  void window.oyster.knowledgeProcessing.getSnapshot()
    .then(setSnapshot)
    .catch((cause) => setError(errorMessage(cause)))
    .finally(() => setLoading(false))

  async function saveDefaultInstructions(
    stageId: ProcessingStageId,
    instructionsOverride: string | null
  ): Promise<boolean> {
    try {
      setSavingStageId(stageId)
      setSavedStageId(undefined)
      setError(undefined)
      setSnapshot(await window.oyster.knowledgeProcessing.saveDefaultInstructions({
        stageId,
        instructionsOverride
      }))
      setSavedStageId(stageId)
      return true
    } catch (cause) {
      setError(errorMessage(cause))
      return false
    } finally {
      setSavingStageId(undefined)
    }
  }

  return {
    snapshot,
    loading,
    error,
    isSaving: (stageId: ProcessingStageId) => savingStageId() === stageId,
    wasSaved: (stageId: ProcessingStageId) => savedStageId() === stageId,
    saveDefaultInstructions
  }
}

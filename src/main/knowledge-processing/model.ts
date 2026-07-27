import type { ModelGenerationRequest, ModelRuntime } from '../ai-backends/model'
import type { AiBackendSnapshot } from '../../shared/ai-backends'
import type { ReasoningEffort } from '../../shared/ai-backends'
import type { KnowledgeContributionDraft } from '../../shared/knowledge'
import type {
  KnowledgeProcessingSnapshot,
  ProcessingStageId
} from '../../shared/knowledge-processing'

export interface StoredProcessingStage {
  stageId: ProcessingStageId
  connectionId?: string
  modelId?: string
  reasoningEffort?: ReasoningEffort
  instructionsOverride?: string
}

export interface KnowledgeProcessingStateData {
  stages: StoredProcessingStage[]
}

export interface KnowledgeProcessingRepository {
  load(): Promise<KnowledgeProcessingStateData>
  save(state: KnowledgeProcessingStateData): Promise<void>
}

export interface AiBackendPort {
  snapshot(): AiBackendSnapshot
  subscribe(listener: (snapshot: AiBackendSnapshot) => void): () => void
  generateWithModel(
    connectionId: string,
    modelId: string,
    request: ModelGenerationRequest
  ): Promise<{ text: string }>
  withModelRuntime<T>(
    connectionId: string,
    modelId: string,
    operation: (runtime: ModelRuntime) => Promise<T>,
    options?: { trackHealth?: boolean }
  ): Promise<T>
}

export interface KnowledgeStatementRecord {
  id: string
  title: string
  content: string
}

export interface KnowledgeReader {
  search(query: string, limit: number, signal?: AbortSignal): Promise<KnowledgeStatementRecord[]>
  read(statementId: string, signal?: AbortSignal): Promise<KnowledgeStatementRecord | undefined>
}

export interface KnowledgeAgentRunInput {
  runtime: ModelRuntime
  systemPrompt: string
  evidenceMap: string
  observationLines: string[]
  sourceRef: string
  contributionRunRef: string
  attention?: string
  reasoningEffort?: ReasoningEffort
  signal: AbortSignal
}

export interface KnowledgeAgentRunResult {
  contribution: KnowledgeContributionDraft
  modelCallCount: number
  toolCalls: string[]
}

export interface KnowledgeAgentRuntime {
  run(input: KnowledgeAgentRunInput): Promise<KnowledgeAgentRunResult>
}

export interface PreprocessingWorkspace {
  runId: string
  sourceRef: string
  observationLines: string[]
  evidenceMap: string
  attention?: string
  createdAt: number
}

export type ProcessingSnapshotListener = (snapshot: KnowledgeProcessingSnapshot) => void

export class EmptyKnowledgeReader implements KnowledgeReader {
  async search(_query: string, _limit: number, signal?: AbortSignal): Promise<KnowledgeStatementRecord[]> {
    signal?.throwIfAborted()
    return []
  }

  async read(_statementId: string, signal?: AbortSignal): Promise<undefined> {
    signal?.throwIfAborted()
    return undefined
  }
}

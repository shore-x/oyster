import type { ModelGenerationRequest, ModelRuntime } from '../ai-backends/model'
import type { AiBackendSnapshot } from '../../shared/ai-backends'
import type { ReasoningEffort } from '../../shared/ai-backends'
import type {
  KnowledgeProcessingSnapshot,
  ProcessingStageId
} from '../../shared/knowledge-processing'
import type { AgentRunRecord } from '../../shared/agent-runtime'
import type { ProcessingRun } from './processing-repository'

export interface StoredProcessingStage {
  stageId: ProcessingStageId
  defaultInstructionsOverride?: string
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

export interface RepositoryAgentRunResult {
  run: AgentRunRecord
  modelCallCount: number
  toolCalls: string[]
}

interface RepositoryAgentRunInput {
  runtime: ModelRuntime
  systemPrompt: string
  run: ProcessingRun
  reasoningEffort?: ReasoningEffort
  runId: string
  onRunUpdate?: (run: AgentRunRecord) => void
  signal: AbortSignal
}

export interface KnowledgeMaintainerRunInput extends RepositoryAgentRunInput {
  previousRevision: string
}

export interface KnowledgeReviewerRunInput extends RepositoryAgentRunInput {
  reviewedRevision: string
}

export interface KnowledgeMaintainerRuntime {
  run(input: KnowledgeMaintainerRunInput): Promise<RepositoryAgentRunResult>
}

export interface KnowledgeReviewerRuntime {
  run(input: KnowledgeReviewerRunInput): Promise<RepositoryAgentRunResult>
}

export type ProcessingSnapshotListener = (snapshot: KnowledgeProcessingSnapshot) => void

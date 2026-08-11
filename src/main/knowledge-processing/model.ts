import type { ModelGenerationRequest, SelectedModelStream } from '../ai-backends/model'
import type { AiBackendSnapshot, ReasoningEffort } from '../../shared/ai-backends'
import type {
  KnowledgeAgentId,
  KnowledgeProcessingStateView
} from '../../shared/knowledge-processing'
import type {
  AgentInvocationDebugRecord,
  AgentInvocationRecord
} from '../../shared/agent-runtime'
import type { KnowledgeTaskWorkspace } from './knowledge-task-workspace-repository'

export interface StoredKnowledgeAgent {
  agentId: KnowledgeAgentId
  defaultInstructionsOverride?: string
  instructionsOverride?: string
}

export interface KnowledgeProcessingConfigurationData {
  agents: StoredKnowledgeAgent[]
}

export interface KnowledgeProcessingConfigurationRepository {
  load(): Promise<KnowledgeProcessingConfigurationData>
  save(state: KnowledgeProcessingConfigurationData): Promise<void>
}

export interface AiBackendPort {
  snapshot(): AiBackendSnapshot
  subscribe(listener: (snapshot: AiBackendSnapshot) => void): () => void
  generateWithModel(
    connectionId: string,
    modelId: string,
    request: ModelGenerationRequest
  ): Promise<{ text: string }>
  withModelStream<T>(
    connectionId: string,
    modelId: string,
    operation: (modelStream: SelectedModelStream) => Promise<T>,
    options?: { trackHealth?: boolean }
  ): Promise<T>
}

export interface RepositoryAgentInvocationResult {
  invocation: AgentInvocationRecord
  modelCallCount: number
  toolCalls: string[]
}

interface RepositoryAgentInvocationInput {
  modelStream: SelectedModelStream
  systemPrompt: string
  workspace: KnowledgeTaskWorkspace
  reasoningEffort?: ReasoningEffort
  invocationId: string
  onInvocationUpdate?: (record: AgentInvocationDebugRecord) => void
  signal: AbortSignal
}

export interface KnowledgeMaintainerInvocationInput extends RepositoryAgentInvocationInput {
  previousRepositoryRevision: string
}

export interface KnowledgeReviewerInvocationInput extends RepositoryAgentInvocationInput {
  reviewedRepositoryRevision: string
}

export interface KnowledgeMaintainerRuntime {
  invoke(input: KnowledgeMaintainerInvocationInput): Promise<RepositoryAgentInvocationResult>
}

export interface KnowledgeReviewerRuntime {
  invoke(input: KnowledgeReviewerInvocationInput): Promise<RepositoryAgentInvocationResult>
}

export type KnowledgeProcessingStateListener = (state: KnowledgeProcessingStateView) => void

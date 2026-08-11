import type {
  AiBackendKind,
  AiConnectionStatus,
  AiProviderId,
  AvailableModel,
  LlmBinding,
  ModelProtocol,
  ReasoningEffort
} from './ai-backends'
import type {
  SourceConversationSummary,
  SourceSnapshotRef
} from './discovery'
import type { KnowledgeStatement } from './knowledge'
import type {
  AgentInvocationDebugRecord,
  AgentInvocationRecord,
  SerializableJsonValue
} from './agent-runtime'

export const KNOWLEDGE_AGENT_IDS = [
  'knowledge_maintainer',
  'knowledge_reviewer'
] as const
export type KnowledgeAgentId = (typeof KNOWLEDGE_AGENT_IDS)[number]
export type KnowledgeAgentRuntimeKind = 'pi_coding_agent'

export interface AgentToolDefinitionView {
  name: string
  label: string
  description: string
  parameters: { [key: string]: SerializableJsonValue }
}

export interface AiConnectionView {
  id: string
  displayName: string
  backendKind: AiBackendKind
  providerId: AiProviderId
  destination: string
  protocol?: ModelProtocol
  accountLabel?: string
  planType?: string
  status: AiConnectionStatus
  models: AvailableModel[]
  defaultModelId?: string
}

export interface KnowledgeAgentDefinitionView {
  id: KnowledgeAgentId
  displayName: string
  description: string
  inputDescription: string
  outputDescription: string
  runtime: KnowledgeAgentRuntimeKind
  capabilities: string[]
  tools: AgentToolDefinitionView[]
  builtInInstructions: string
  defaultInstructions: string
  effectiveInstructions: string
  isDefaultCustomized: boolean
  isCustomized: boolean
}

export interface KnowledgeProcessingStateView {
  agents: KnowledgeAgentDefinitionView[]
  connections: AiConnectionView[]
  defaultLlm?: LlmBinding
  activeAgentIds: KnowledgeAgentId[]
  liveInvocations: LiveAgentInvocationView[]
  configurationError?: string
}

export type AgentInvocationOrigin = 'agent_preview' | 'knowledge_task'

export interface LiveAgentInvocationView {
  origin: AgentInvocationOrigin
  invocation: AgentInvocationDebugRecord
}

export interface SaveKnowledgeAgentInput {
  agentId: KnowledgeAgentId
  instructionsOverride: string | null
}

export interface SaveKnowledgeAgentDefaultInstructionsInput {
  agentId: KnowledgeAgentId
  instructionsOverride: string | null
}

export interface StartKnowledgeAgentPreviewInput extends SourceSnapshotRef {
  attention?: string
}

export type StartKnowledgeTaskInput = StartKnowledgeAgentPreviewInput

export type SourceSnapshotSelectionFailureReason = 'unavailable' | 'changed' | 'unreadable'

export interface SourceSnapshotRejected {
  status: 'source_snapshot_rejected'
  reason: SourceSnapshotSelectionFailureReason
  message: string
}

export interface SourceSnapshotOperationCompleted<Result> {
  status: 'completed'
  result: Result
}

export type SourceSnapshotOperationResult<Result> =
  | SourceSnapshotOperationCompleted<Result>
  | SourceSnapshotRejected

export interface AgentInvocationSummary {
  connectionId: string
  connectionName: string
  backendKind: AiBackendKind
  providerId: AiProviderId
  model: string
  runtime: KnowledgeAgentRuntimeKind
  modelCallCount: number
  toolCalls: string[]
  reasoningEffort?: ReasoningEffort
}

export interface KnowledgeTaskWorktreeView {
  taskId: string
  /** User-owned main checkout. */
  repositoryPath: string
  /** Task-owned linked checkout used as the Agent cwd. */
  worktreePath: string
  /** Runtime-only Pi state outside Git. */
  runtimePath: string
  taskPath: string
  briefPath: string
  progressPath: string
  inputPath: string
  branchName: string
  targetBranch: string
  baseRepositoryRevision: string
  taskStartRepositoryRevision: string
}

export interface KnowledgeMaintenanceResult {
  agentId: 'knowledge_maintainer'
  sourceRef: string
  activitySegmentCount: number
  worktree: KnowledgeTaskWorktreeView
  previousRepositoryRevision: string
  candidateRepositoryRevision: string
  changedPaths: string[]
  agentInvocationId: string
  durationMs: number
  completedAt: string
  invocation: AgentInvocationSummary
}

export interface KnowledgeReviewResult {
  agentId: 'knowledge_reviewer'
  decision: 'changes_requested' | 'approved'
  reviewedRepositoryRevision: string
  candidateRepositoryRevision: string
  changedPaths: string[]
  markerPaths: string[]
  agentInvocationId: string
  durationMs: number
  completedAt: string
  invocation: AgentInvocationSummary
}

export interface KnowledgeTaskRound {
  roundId: string
  sequence: number
  maintenance: KnowledgeMaintenanceResult
  review: KnowledgeReviewResult
}

export interface KnowledgeTaskResult {
  taskId: string
  sourceConversation: SourceConversationSummary
  sourceSnapshot: SourceSnapshotRef
  sourceRef: string
  worktree: KnowledgeTaskWorktreeView
  rounds: KnowledgeTaskRound[]
  approvedRepositoryRevision: string
  changedPaths: string[]
  knowledge: KnowledgeStatement[]
  artifactPaths: string[]
  durationMs: number
  completedAt: string
}

export interface KnowledgeAgentBinding {
  connectionId: string
  modelId: string
  instructions: string
  reasoningEffort?: ReasoningEffort
}

export interface KnowledgeTaskRecord {
  formatVersion: 2
  taskId: string
  status: 'open' | 'completed' | 'abandoned'
  startedAt: string
  updatedAt: string
  completedAt?: string
  durationMs: number
  input: StartKnowledgeTaskInput
  sourceConversation?: SourceConversationSummary
  configuration: {
    maintainer: KnowledgeAgentBinding
    reviewer: KnowledgeAgentBinding
  }
  agentInvocations: AgentInvocationRecord[]
  result?: KnowledgeTaskResult
  lastError?: string
}

/** Read model that joins a small Task record with separately stored debug data. */
export interface KnowledgeTaskDetail extends KnowledgeTaskRecord {
  invocationDebugRecords: AgentInvocationDebugRecord[]
}

export interface KnowledgeTaskSummary {
  taskId: string
  status: KnowledgeTaskRecord['status']
  updatedAt: string
  durationMs: number
  sourceConversationTitle?: string
  sourceDisplayName?: string
  projectPath?: string
  statementCount: number
  maintainerModel: string
  agentInvocationCount: number
  modelCallCount: number
  error?: string
}

export interface KnowledgeProcessingApi {
  getState(): Promise<KnowledgeProcessingStateView>
  saveAgent(input: SaveKnowledgeAgentInput): Promise<KnowledgeProcessingStateView>
  saveAgentDefaultInstructions(
    input: SaveKnowledgeAgentDefaultInstructionsInput
  ): Promise<KnowledgeProcessingStateView>
  previewKnowledgeMaintainer(
    input: StartKnowledgeAgentPreviewInput
  ): Promise<SourceSnapshotOperationResult<KnowledgeMaintenanceResult>>
  startKnowledgeTask(
    input: StartKnowledgeTaskInput
  ): Promise<SourceSnapshotOperationResult<KnowledgeTaskResult>>
  listKnowledgeTasks(): Promise<KnowledgeTaskSummary[]>
  readKnowledgeTask(taskId: string): Promise<KnowledgeTaskDetail | undefined>
  cancelKnowledgeTask(): Promise<void>
  cancelAgentPreview(agentId: KnowledgeAgentId): Promise<void>
  subscribe(listener: (state: KnowledgeProcessingStateView) => void): () => void
}

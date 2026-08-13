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
  SourceConversationSelection,
  SourceConversationSummary
} from './discovery'
import type {
  AgentInvocationDebugRecord,
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
  agentId: KnowledgeAgentId
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

export interface StartKnowledgeAgentPreviewInput extends SourceConversationSelection {
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
  inputPath: string
  branchName: string
  targetBranch: string
  /** Revision first presented to an Agent; for a Task, the immutable Host-created Task-start commit. */
  baseRepositoryRevision: string
}

export interface KnowledgeMaintenanceResult {
  agentId: 'knowledge_maintainer'
  sourceRef: string
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
  integratedRepositoryRevision?: string
  agentInvocationId: string
  durationMs: number
  completedAt: string
  invocation: AgentInvocationSummary
}

export interface KnowledgeTaskResult {
  taskId: string
  sourceConversation: SourceConversationSummary
  sourceRef: string
  worktree: KnowledgeTaskWorktreeView
  approvedRepositoryRevision: string
  integratedRepositoryRevision: string
  changedPaths: string[]
  durationMs: number
  completedAt: string
}

export interface KnowledgeAgentBinding {
  connectionId: string
  modelId: string
  instructions: string
  reasoningEffort?: ReasoningEffort
}

export type KnowledgeAgentBindingSummary = Omit<KnowledgeAgentBinding, 'instructions'>

/** Immutable Task definition tracked with the Task's repository changes. */
export interface KnowledgeTaskDefinition {
  formatVersion: 3
  taskId: string
  startedAt: string
  input: StartKnowledgeTaskInput
  sourceConversation?: SourceConversationSummary
  sourceRef: string
  configuration: {
    maintainer: KnowledgeAgentBindingSummary
    reviewer: KnowledgeAgentBindingSummary
  }
}

/** Read model derived from task.json and the Git commit graph. */
export interface KnowledgeTaskRecord {
  formatVersion: 3
  taskId: string
  status: 'open' | 'completed'
  startedAt: string
  updatedAt: string
  completedAt?: string
  durationMs: number
  input: StartKnowledgeTaskInput
  sourceConversation?: SourceConversationSummary
  sourceRef: string
  configuration: {
    maintainer: KnowledgeAgentBindingSummary
    reviewer: KnowledgeAgentBindingSummary
  }
  result?: KnowledgeTaskResult
}

export type KnowledgeTaskDetail = KnowledgeTaskRecord

export interface KnowledgeTaskSummary {
  taskId: string
  status: KnowledgeTaskRecord['status']
  updatedAt: string
  durationMs: number
  sourceConversationTitle?: string
  sourceDisplayName?: string
  projectPath?: string
  changedPathCount: number
  maintainerModel: string
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

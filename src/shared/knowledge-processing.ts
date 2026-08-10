import type {
  AiBackendKind,
  AiConnectionStatus,
  AiProviderId,
  AvailableModel,
  LlmBinding,
  ModelProtocol,
  ReasoningEffort
} from './ai-backends'
import type { AvailableSessionSummary } from './discovery'
import type { KnowledgeStatement } from './knowledge'
import type {
  AgentRunRecord,
  SerializableJsonValue
} from './agent-runtime'

export const PROCESSING_STAGE_IDS = [
  'knowledge_maintenance_agent',
  'knowledge_reviewer_agent'
] as const
export type ProcessingStageId = (typeof PROCESSING_STAGE_IDS)[number]
export type ProcessingRuntime = 'pi_agent_core'

export interface ProcessingToolView {
  name: string
  label: string
  description: string
  /** JSON-safe projection of the exact parameter schema supplied to the model. */
  parameters: { [key: string]: SerializableJsonValue }
}

export interface ProcessingConnectionView {
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

export interface ProcessingStageView {
  id: ProcessingStageId
  displayName: string
  description: string
  inputDescription: string
  outputDescription: string
  runtime: ProcessingRuntime
  capabilities: string[]
  tools: ProcessingToolView[]
  builtInInstructions: string
  defaultInstructions: string
  effectiveInstructions: string
  isDefaultCustomized: boolean
  isCustomized: boolean
}

export interface KnowledgeProcessingSnapshot {
  stages: ProcessingStageView[]
  connections: ProcessingConnectionView[]
  defaultLlm?: LlmBinding
  runningStageIds: ProcessingStageId[]
  debugTraces: KnowledgeProcessingDebugTrace[]
  configurationError?: string
}

export type ProcessingDebugTraceOrigin = 'stage_debug' | 'full_chain'

export interface KnowledgeProcessingDebugTrace {
  origin: ProcessingDebugTraceOrigin
  run: AgentRunRecord
}

export interface SaveProcessingStageInput {
  stageId: ProcessingStageId
  instructionsOverride: string | null
}

export interface SaveProcessingDefaultInstructionsInput {
  stageId: ProcessingStageId
  instructionsOverride: string | null
}

/** Selects one immutable external Session revision for a Maintainer run. */
export interface RunKnowledgeMaintenanceInput {
  sourceRecordId: string
  expectedRevision: string
  attention?: string
}

export type RunKnowledgeFullChainInput = RunKnowledgeMaintenanceInput

export type SessionSelectionFailureReason = 'unavailable' | 'changed' | 'unreadable'

export interface SessionRunRejected {
  status: 'session_rejected'
  reason: SessionSelectionFailureReason
  message: string
}

export interface SessionRunCompleted<Result> {
  status: 'completed'
  result: Result
}

export type SessionRunResponse<Result> = SessionRunCompleted<Result> | SessionRunRejected

export interface ProcessingExecutionSummary {
  connectionId: string
  connectionName: string
  backendKind: AiBackendKind
  providerId: AiProviderId
  model: string
  runtime: ProcessingRuntime
  modelCallCount: number
  toolCalls: string[]
  reasoningEffort?: ReasoningEffort
}

export interface ProcessingRunView {
  id: string
  repositoryPath: string
  runPath: string
  taskPath: string
  workPath: string
  inputPath: string
  workspaceRevision: string
  branchName: string
  targetBranch: string
  baseRevision: string
}

export interface KnowledgeMaintenanceResult {
  stageId: 'knowledge_maintenance_agent'
  sourceRef: string
  activitySegmentCount: number
  run: ProcessingRunView
  previousRevision: string
  revision: string
  changedPaths: string[]
  agentRunId: string
  durationMs: number
  completedAt: string
  execution: ProcessingExecutionSummary
}

export interface KnowledgeReviewResult {
  stageId: 'knowledge_reviewer_agent'
  outcome: 'changes_requested' | 'approved'
  reviewedRevision: string
  revision: string
  changedPaths: string[]
  markerPaths: string[]
  agentRunId: string
  durationMs: number
  completedAt: string
  execution: ProcessingExecutionSummary
}

export interface KnowledgeFullChainResult {
  runId: string
  session: AvailableSessionSummary
  sourceRef: string
  run: ProcessingRunView
  maintenanceRuns: KnowledgeMaintenanceResult[]
  reviewRuns: KnowledgeReviewResult[]
  approvedRevision: string
  changedPaths: string[]
  knowledge: KnowledgeStatement[]
  artifactPaths: string[]
  durationMs: number
  completedAt: string
}

export interface KnowledgeFullChainStageSnapshot {
  connectionId: string
  modelId: string
  instructions: string
  reasoningEffort?: ReasoningEffort
}

export interface KnowledgeFullChainRunRecord {
  formatVersion: 8
  runId: string
  status: Exclude<AgentRunRecord['status'], 'running'>
  startedAt: string
  completedAt: string
  durationMs: number
  input: RunKnowledgeFullChainInput
  /** Available after the selected external Session revision has been resolved. */
  session?: AvailableSessionSummary
  configuration: {
    maintainer: KnowledgeFullChainStageSnapshot
    reviewer: KnowledgeFullChainStageSnapshot
  }
  agentRuns: AgentRunRecord[]
  result?: KnowledgeFullChainResult
  error?: string
}

export interface KnowledgeFullChainRunSummary {
  runId: string
  status: KnowledgeFullChainRunRecord['status']
  completedAt: string
  durationMs: number
  sessionTitle?: string
  sourceDisplayName?: string
  projectPath?: string
  statementCount: number
  maintainerModel: string
  agentRunCount: number
  modelCallCount: number
  error?: string
}

export interface KnowledgeProcessingApi {
  getSnapshot(): Promise<KnowledgeProcessingSnapshot>
  saveStage(input: SaveProcessingStageInput): Promise<KnowledgeProcessingSnapshot>
  saveDefaultInstructions(
    input: SaveProcessingDefaultInstructionsInput
  ): Promise<KnowledgeProcessingSnapshot>
  runKnowledgeMaintenance(
    input: RunKnowledgeMaintenanceInput
  ): Promise<SessionRunResponse<KnowledgeMaintenanceResult>>
  runFullChain(
    input: RunKnowledgeFullChainInput
  ): Promise<SessionRunResponse<KnowledgeFullChainResult>>
  listFullChainRuns(): Promise<KnowledgeFullChainRunSummary[]>
  readFullChainRun(runId: string): Promise<KnowledgeFullChainRunRecord | undefined>
  cancelFullChain(): Promise<void>
  cancelRun(stageId: ProcessingStageId): Promise<void>
  subscribe(listener: (snapshot: KnowledgeProcessingSnapshot) => void): () => void
}

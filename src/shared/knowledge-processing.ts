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
import type {
  KnowledgeCommitResult,
  KnowledgeContributionDraft,
  KnowledgeStatement
} from './knowledge'
import type {
  AgentRunRecord,
  AgentTodo,
  AgentTodoCounts,
  SerializableJsonValue
} from './agent-runtime'

export const PROCESSING_STAGE_IDS = ['knowledge_maintenance_agent'] as const
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

export interface KnowledgeMaintenanceWorkspaceStatus {
  todos: AgentTodoCounts
  draftStatementCount: number
}

/** Processing-specific placement of a generic Agent run and its separate workspace state. */
export interface KnowledgeProcessingDebugTrace {
  origin: ProcessingDebugTraceOrigin
  run: AgentRunRecord
  workspace?: KnowledgeMaintenanceWorkspaceStatus
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

export interface KnowledgeMaintenanceResult {
  stageId: 'knowledge_maintenance_agent'
  sourceRef: string
  evidenceSegmentCount: number
  contribution: KnowledgeContributionDraft
  todos: AgentTodo[]
  /** References the generic Runtime observation without embedding it in the business result. */
  agentRunId: string
  durationMs: number
  completedAt: string
  execution: ProcessingExecutionSummary
}

export interface KnowledgeSandboxView {
  id: string
  baselineCreatedAt: string
}

export interface KnowledgeFullChainResult {
  runId: string
  session: AvailableSessionSummary
  sandbox: KnowledgeSandboxView
  sourceRef: string
  maintenance: KnowledgeMaintenanceResult
  commit: KnowledgeCommitResult
  knowledge: {
    writtenStatementTitles: string[]
    statements: KnowledgeStatement[]
  }
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
  formatVersion: 5
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
  ): Promise<KnowledgeMaintenanceResult | undefined>
  runFullChain(input: RunKnowledgeFullChainInput): Promise<KnowledgeFullChainResult | undefined>
  listFullChainRuns(): Promise<KnowledgeFullChainRunSummary[]>
  readFullChainRun(runId: string): Promise<KnowledgeFullChainRunRecord | undefined>
  importFullChainRun(runId: string): Promise<KnowledgeCommitResult>
  cancelFullChain(): Promise<void>
  discardSandbox(sandboxId: string): Promise<void>
  cancelRun(stageId: ProcessingStageId): Promise<void>
  subscribe(listener: (snapshot: KnowledgeProcessingSnapshot) => void): () => void
}

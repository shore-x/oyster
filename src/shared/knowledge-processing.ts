import type {
  AiBackendKind,
  AiConnectionStatus,
  AiProviderId,
  AvailableModel,
  ModelProtocol,
  ReasoningEffort
} from './ai-backends'
import type { AvailableSessionSummary } from './discovery'
import type {
  KnowledgeCommitResult,
  KnowledgeContributionDraft,
  KnowledgeStatement
} from './knowledge'

export const PROCESSING_STAGE_IDS = [
  'observation_preprocessor',
  'knowledge_maintenance_agent'
] as const

export type ProcessingStageId = (typeof PROCESSING_STAGE_IDS)[number]
export type ProcessingRuntime = 'direct_model_call' | 'pi_agent_core'

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
  connectionId?: string
  modelId?: string
  reasoningEffort?: ReasoningEffort
  defaultInstructions: string
  effectiveInstructions: string
  isCustomized: boolean
}

export interface KnowledgeProcessingSnapshot {
  stages: ProcessingStageView[]
  connections: ProcessingConnectionView[]
  runningStageIds: ProcessingStageId[]
  preprocessingProgress?: ObservationPreprocessingProgress
  debugTraces: KnowledgeProcessingDebugTrace[]
  configurationError?: string
}

export interface ObservationPreprocessingProgress {
  phase: 'preparing' | 'discovering'
  completedSegments: number
  totalSegments?: number
}

export type ProcessingDebugTraceOrigin = 'stage_debug' | 'full_chain'
export type ProcessingDebugStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export interface PreprocessingModelCallTrace {
  id: string
  sequence: number
  kind: 'candidate_discovery'
  status: ProcessingDebugStatus
  /** Exact, sorted and coalesced raw source ranges represented by this call. */
  selectors: string[]
  /** First host-derived raw position represented by this call. */
  readLocation: { line: number; offset: number }
  startedAt: string
  completedAt?: string
  durationMs?: number
  output?: string
  outputTruncated?: boolean
  error?: string
}

export interface ObservationPreprocessingDebugTrace {
  phase: 'preparing' | 'discovering' | 'completed'
  completedSegments: number
  totalSegments?: number
  view?: {
    formatVersion: string
    sourceLineCount: number
    sourceBytes: number
    selectedLineCount: number
    selectedUnitCount: number
    selectedSourceBytes: number
    modelMaterialBytes: number
  }
  calls: PreprocessingModelCallTrace[]
}

export interface KnowledgeMaintenanceTraceEvent {
  id: string
  sequence: number
  kind: 'model_call' | 'tool_call'
  label: string
  status: ProcessingDebugStatus
  startedAt: string
  completedAt?: string
  durationMs?: number
  detail?: string
}

export interface KnowledgeMaintenanceDebugTrace {
  modelCallCount: number
  toolCallCount: number
  workspace?: KnowledgeMaintenanceWorkspaceStatus
  events: KnowledgeMaintenanceTraceEvent[]
}

export interface StatementCandidateLocation {
  line: number
  offset: number
}

export interface StatementCandidateSeed {
  expression: string
  question: string
  locations: StatementCandidateLocation[]
}

export interface StatementCandidateView {
  ref: string
  expression: string
  question: string
  evidenceLocations: string[]
  status: 'open' | 'resolved'
  resolution?: string
}

export interface StatementCandidateCounts {
  total: number
  open: number
  resolved: number
}

export interface KnowledgeMaintenanceWorkspaceStatus {
  candidates: StatementCandidateCounts
  draftStatementCount: number
}

/** Bounded, in-memory diagnostics for the latest confirmed run in each UI origin. */
export interface KnowledgeProcessingDebugTrace {
  id: string
  origin: ProcessingDebugTraceOrigin
  status: ProcessingDebugStatus
  currentStageId: ProcessingStageId
  startedAt: string
  completedAt?: string
  error?: string
  preprocessing?: ObservationPreprocessingDebugTrace
  maintenance?: KnowledgeMaintenanceDebugTrace
}

export interface SaveProcessingStageInput {
  stageId: ProcessingStageId
  connectionId: string | null
  modelId: string | null
  instructionsOverride: string | null
  /** undefined preserves the current value; null uses the model/provider default. */
  reasoningEffort?: ReasoningEffort | null
}

export interface RunObservationPreprocessorInput {
  observation: string
  attention?: string
}

/** Selects one discovered Session revision without exposing its path or raw content to the renderer. */
export interface RunSessionPreprocessorInput {
  artifactId: string
  expectedRevision: string
  attention?: string
}

export interface RunKnowledgeMaintenanceInput {
  preprocessingRunId: string
  attention?: string
}

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

export interface ObservationPreprocessingResult {
  stageId: 'observation_preprocessor'
  runId: string
  statementCandidates: StatementCandidateSeed[]
  sourceRef: string
  segmentCount: number
  debugTrace: KnowledgeProcessingDebugTrace
  durationMs: number
  completedAt: string
  execution: ProcessingExecutionSummary
}

export interface KnowledgeMaintenanceResult {
  stageId: 'knowledge_maintenance_agent'
  preprocessingRunId: string
  contribution: KnowledgeContributionDraft
  statementCandidates: StatementCandidateView[]
  debugTrace: KnowledgeProcessingDebugTrace
  durationMs: number
  completedAt: string
  execution: ProcessingExecutionSummary
}

export interface RunKnowledgeFullChainInput {
  artifactId: string
  expectedRevision: string
  attention?: string
}

export interface KnowledgeSandboxView {
  id: string
  baselineCreatedAt: string
}

export interface ClearKnowledgeResult {
  deletedStatementCount: number
  deletedContributionCount: number
}

export interface KnowledgeFullChainResult {
  runId: string
  session: AvailableSessionSummary
  sandbox: KnowledgeSandboxView
  sourceRef: string
  preprocessing: ObservationPreprocessingResult
  maintenance: KnowledgeMaintenanceResult
  commit: KnowledgeCommitResult
  knowledge: {
    writtenStatementTitles: string[]
    statements: KnowledgeStatement[]
  }
  durationMs: number
  completedAt: string
}

export interface KnowledgeProcessingApi {
  getSnapshot(): Promise<KnowledgeProcessingSnapshot>
  saveStage(input: SaveProcessingStageInput): Promise<KnowledgeProcessingSnapshot>
  runObservationPreprocessor(
    input: RunObservationPreprocessorInput
  ): Promise<ObservationPreprocessingResult | undefined>
  runSessionPreprocessor(
    input: RunSessionPreprocessorInput
  ): Promise<ObservationPreprocessingResult | undefined>
  runKnowledgeMaintenance(
    input: RunKnowledgeMaintenanceInput
  ): Promise<KnowledgeMaintenanceResult | undefined>
  runFullChain(input: RunKnowledgeFullChainInput): Promise<KnowledgeFullChainResult | undefined>
  cancelFullChain(): Promise<void>
  clearKnowledge(): Promise<ClearKnowledgeResult>
  discardSandbox(sandboxId: string): Promise<void>
  cancelRun(stageId: ProcessingStageId): Promise<void>
  subscribe(listener: (snapshot: KnowledgeProcessingSnapshot) => void): () => void
}

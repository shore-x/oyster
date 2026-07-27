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
  KnowledgeStatementDetails
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
  configurationError?: string
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
  evidenceMap: string
  sourceRef: string
  durationMs: number
  completedAt: string
  execution: ProcessingExecutionSummary
}

export interface KnowledgeMaintenanceResult {
  stageId: 'knowledge_maintenance_agent'
  preprocessingRunId: string
  contribution: KnowledgeContributionDraft
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

export interface KnowledgeFullChainResult {
  runId: string
  session: AvailableSessionSummary
  sandbox: KnowledgeSandboxView
  sourceRef: string
  preprocessing: ObservationPreprocessingResult
  maintenance: KnowledgeMaintenanceResult
  commit: KnowledgeCommitResult
  knowledge: {
    createdStatementIds: string[]
    statements: KnowledgeStatementDetails[]
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
  discardSandbox(sandboxId: string): Promise<void>
  cancelRun(stageId: ProcessingStageId): Promise<void>
  subscribe(listener: (snapshot: KnowledgeProcessingSnapshot) => void): () => void
}

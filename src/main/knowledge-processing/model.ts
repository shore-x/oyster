import type { ModelGenerationRequest, ModelRuntime } from '../ai-backends/model'
import type { AiBackendSnapshot } from '../../shared/ai-backends'
import type { ReasoningEffort } from '../../shared/ai-backends'
import type {
  KnowledgeContributionDraft,
  KnowledgeStatement
} from '../../shared/knowledge'
import type {
  KnowledgeProcessingSnapshot,
  ProcessingStageId
} from '../../shared/knowledge-processing'
import type { StatementCandidate as DiscoveredStatementCandidate } from './statement-candidate-batch'
import type { StatementCandidate as AgendaStatementCandidate } from './statement-candidate-agenda'

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
  title: string
  content: string
}

export interface KnowledgeReader {
  /** Discover current Statements by text and return bounded candidates. */
  search(
    query: string,
    limit: number,
    offset?: number,
    signal?: AbortSignal
  ): Promise<KnowledgeStatementRecord[]>
  /** Resolve one current Statement by its exact canonical title. */
  read(title: string, signal?: AbortSignal): Promise<KnowledgeStatement | undefined>
}

export interface KnowledgeAgentRunInput {
  runtime: ModelRuntime
  systemPrompt: string
  statementCandidates: DiscoveredStatementCandidate[]
  observationLines: readonly string[]
  observationFormatVersion: string
  sourceRef: string
  contributionRunRef: string
  attention?: string
  reasoningEffort?: ReasoningEffort
  onTrace?: (event: KnowledgeAgentTraceEvent) => void
  signal: AbortSignal
}

export type KnowledgeAgentTraceEvent =
  | {
      type: 'model_started'
      callNumber: number
      purpose?: 'agent' | 'context_compaction'
    }
  | {
      type: 'model_completed'
      callNumber: number
      status: 'completed' | 'failed' | 'cancelled'
      detail?: string
      output?: string
    }
  | { type: 'tool_started'; toolCallId: string; toolName: string; input?: string }
  | {
      type: 'tool_completed'
      toolCallId: string
      toolName: string
      status: 'completed' | 'failed' | 'cancelled'
      detail?: string
      output?: string
    }
  | {
      type: 'workspace_status'
      candidates: { total: number; open: number; resolved: number }
      draftStatementCount: number
    }

export interface KnowledgeAgentRunResult {
  contribution: KnowledgeContributionDraft
  statementCandidates: AgendaStatementCandidate[]
  modelCallCount: number
  toolCalls: string[]
}

export interface KnowledgeAgentRuntime {
  run(input: KnowledgeAgentRunInput): Promise<KnowledgeAgentRunResult>
}

export interface PreprocessingWorkspace {
  runId: string
  sourceRef: string
  observationLines: readonly string[]
  observationFormatVersion: string
  statementCandidates: DiscoveredStatementCandidate[]
  attention?: string
  createdAt: number
}

export type ProcessingSnapshotListener = (snapshot: KnowledgeProcessingSnapshot) => void

export class EmptyKnowledgeReader implements KnowledgeReader {
  async search(
    _query: string,
    _limit: number,
    _offset?: number,
    signal?: AbortSignal
  ): Promise<KnowledgeStatementRecord[]> {
    signal?.throwIfAborted()
    return []
  }

  async read(_title: string, signal?: AbortSignal): Promise<undefined> {
    signal?.throwIfAborted()
    return undefined
  }
}

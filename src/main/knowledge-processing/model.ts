import type { ModelGenerationRequest, ModelRuntime } from '../ai-backends/model'
import type { AiBackendSnapshot } from '../../shared/ai-backends'
import type { ReasoningEffort } from '../../shared/ai-backends'
import type {
  KnowledgeContributionDraft,
  KnowledgeStatementDetails
} from '../../shared/knowledge'
import type { EvidenceLocation, ObservationCharacterWindow } from '../observation/model'
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
  /** Discover current Statements; historical versions remain reachable by stable ID and relations. */
  search(
    query: string,
    limit: number,
    offset?: number,
    signal?: AbortSignal
  ): Promise<KnowledgeStatementRecord[]>
  /** Read one exact immutable Statement together with its direct provenance and relation context. */
  read(statementId: string, signal?: AbortSignal): Promise<KnowledgeStatementDetails | undefined>
}

export interface KnowledgeAgentRunInput {
  runtime: ModelRuntime
  systemPrompt: string
  evidenceMap: string
  evidenceMapSections: EvidenceMapSection[]
  observationLines: string[]
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
    }
  | { type: 'tool_started'; toolCallId: string; toolName: string }
  | {
      type: 'tool_completed'
      toolCallId: string
      toolName: string
      status: 'completed' | 'failed' | 'cancelled'
      detail?: string
    }

export interface EvidenceMapSection {
  id: string
  /** Exact, sorted and coalesced raw source ranges represented by this section. */
  selectors: string[]
  /** First host-derived position for this section; can be passed directly to read_evidence. */
  readLocation: EvidenceLocation
  content: string
  /** Immediate child sections for progressive disclosure; descendants are never flattened. */
  children?: string[]
  /** Internal navigation for a fragment of one unusually long raw Observation line. */
  characterWindow?: ObservationCharacterWindow
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
  observationFormatVersion: string
  evidenceMap: string
  evidenceMapSections: EvidenceMapSection[]
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

  async read(_statementId: string, signal?: AbortSignal): Promise<undefined> {
    signal?.throwIfAborted()
    return undefined
  }
}

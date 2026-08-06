import type { Session } from '@earendil-works/pi-agent-core'
import type { AiBackendSnapshot } from '../../shared/ai-backends'
import type {
  ChatEvent,
  ChatSessionBinding,
  ChatSessionDetail,
  ChatSessionSummary
} from '../../shared/chat'
import type { KnowledgeCommitResult, KnowledgeContributionDraft, KnowledgeStatement } from '../../shared/knowledge'
import type { ModelRuntime } from '../ai-backends/model'
import type { KnowledgeStatementRecord } from '../knowledge-processing/model'
import type { AgentRunRecord } from '../../shared/agent-runtime'

export interface ChatConfigurationStateData {
  defaultInstructionsOverride?: string
}

export interface ChatConfigurationRepository {
  load(): Promise<ChatConfigurationStateData>
  save(state: ChatConfigurationStateData): Promise<void>
}

export interface PersistedChatSession {
  session: Session
  binding: ChatSessionBinding
}

export interface ChatSessionRepository {
  create(binding: ChatSessionBinding, title?: string): Promise<PersistedChatSession>
  open(sessionId: string): Promise<PersistedChatSession>
  list(): Promise<ChatSessionSummary[]>
  detail(sessionId: string, running?: boolean): Promise<ChatSessionDetail>
  delete(sessionId: string): Promise<void>
}

export interface ChatKnowledgeStore {
  search(
    query: string,
    limit: number,
    offset?: number,
    signal?: AbortSignal
  ): Promise<KnowledgeStatementRecord[]>
  read(title: string, signal?: AbortSignal): Promise<KnowledgeStatement | undefined>
  commit(draft: KnowledgeContributionDraft): KnowledgeCommitResult
}

export interface ChatAiBackendPort {
  snapshot(): AiBackendSnapshot
  withModelRuntime<T>(
    connectionId: string,
    modelId: string,
    operation: (runtime: ModelRuntime) => Promise<T>,
    options?: { trackHealth?: boolean }
  ): Promise<T>
}

export interface PiChatAgentRunInput {
  sessionId: string
  session: Session
  binding: ChatSessionBinding
  runtime: ModelRuntime
  text: string
  /** Host-owned initial work items bound to this Agent run, not transcript messages. */
  initialTodos?: readonly string[]
  signal: AbortSignal
  onRunUpdate?: (run: AgentRunRecord) => void
  onEvent?: (event: Exclude<ChatEvent, { type: 'snapshot_changed' | 'run_state_changed' }>) => void
}

export interface ChatAgentRuntime {
  run(input: PiChatAgentRunInput): Promise<void>
}

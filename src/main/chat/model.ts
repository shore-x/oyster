import type { SessionManager } from '@earendil-works/pi-coding-agent'
import type { AiBackendSnapshot } from '../../shared/ai-backends'
import type {
  ChatEvent,
  ChatConversationBinding,
  ChatConversationDetail,
  ChatConversationSummary
} from '../../shared/chat'
import type { SelectedModelStream } from '../ai-backends/model'
import type {
  AgentInvocationDebugRecord,
  AgentInvocationRecord
} from '../../shared/agent-runtime'

export interface ChatConfigurationStateData {
  defaultInstructionsOverride?: string
}

export interface ChatConfigurationRepository {
  load(): Promise<ChatConfigurationStateData>
  save(state: ChatConfigurationStateData): Promise<void>
}

export interface PersistedChatConversation {
  conversationId: string
  piSessionManager: SessionManager
  binding: ChatConversationBinding
}

export interface ChatConversationRepository {
  create(binding: ChatConversationBinding, title?: string): Promise<PersistedChatConversation>
  open(conversationId: string): Promise<PersistedChatConversation>
  list(): Promise<ChatConversationSummary[]>
  detail(conversationId: string, hasActiveInvocation?: boolean): Promise<ChatConversationDetail>
  setTitle(conversationId: string, title: string): Promise<void>
  appendInvocation(conversationId: string, record: AgentInvocationDebugRecord): Promise<void>
}

export interface ChatAiBackendPort {
  snapshot(): AiBackendSnapshot
  withModelStream<T>(
    connectionId: string,
    modelId: string,
    operation: (modelStream: SelectedModelStream) => Promise<T>,
    options?: { trackHealth?: boolean }
  ): Promise<T>
}

export interface PiChatAgentInvocationInput {
  conversationId: string
  rootInvocationId: string
  piSessionManager: SessionManager
  binding: ChatConversationBinding
  modelStream: SelectedModelStream
  text: string
  /** Host-owned initial work items bound to this Agent Invocation, not transcript messages. */
  initialTodos?: readonly string[]
  signal: AbortSignal
  onInvocationUpdate?: (record: AgentInvocationDebugRecord) => void
  onEvent?: (event: Extract<ChatEvent, { type: 'message_appended' }>) => void
}

export interface ChatAgentRuntime {
  invoke(input: PiChatAgentInvocationInput): Promise<void>
}

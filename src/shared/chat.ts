import type { LlmBinding } from './ai-backends'
import type {
  AgentInvocationDebugRecord,
  AgentInvocationRecord,
  SerializableJsonValue
} from './agent-runtime'
import type { AgentToolDefinitionView } from './knowledge-processing'

export const CHAT_AGENT_ID = 'chat_agent' as const

export interface ChatConversationModelBinding extends LlmBinding {}

/** Immutable execution binding captured when a Chat Conversation is created. */
export interface ChatConversationBinding extends ChatConversationModelBinding {
  systemPrompt: string
}

export interface ConversationEntry {
  id: string
  createdAt: string
  message: ChatMessageView
}

export interface ChatToolCallView {
  id: string
  name: string
  input: SerializableJsonValue
}

export type ChatMessageView =
  | {
      role: 'user'
      text: string
      timestamp: number
    }
  | {
      role: 'assistant'
      text: string
      toolCalls: ChatToolCallView[]
      model: string
      stopReason: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted'
      error?: string
      timestamp: number
    }
  | {
      role: 'tool'
      toolCallId: string
      toolName: string
      text: string
      isError: boolean
      details?: SerializableJsonValue
      timestamp: number
    }

export interface ChatConversationSummary {
  conversationId: string
  title?: string
  createdAt: string
  updatedAt: string
  messageCount: number
  binding: ChatConversationModelBinding
  hasActiveInvocation: boolean
}

export interface ChatConversationDetail extends ChatConversationSummary {
  messages: ConversationEntry[]
  /** Debug projections loaded from the local Debug Store for inspection. */
  invocations: AgentInvocationDebugRecord[]
}

export interface ChatAgentConfigurationView {
  agentId: typeof CHAT_AGENT_ID
  displayName: string
  description: string
  runtime: 'pi_coding_agent'
  tools: AgentToolDefinitionView[]
  builtInInstructions: string
  defaultInstructions: string
  isDefaultCustomized: boolean
}

export interface ChatStateView {
  agent: ChatAgentConfigurationView
  conversations: ChatConversationSummary[]
  configurationError?: string
}

export interface CreateChatConversationInput {
  title?: string
}

export interface SendChatMessageInput {
  conversationId: string
  text: string
}

export interface CancelChatInvocationInput {
  conversationId: string
}

export interface SaveChatDefaultInstructionsInput {
  /** null restores the source-code default. */
  instructionsOverride: string | null
}

export type ChatEvent =
  | { type: 'state_changed'; state: ChatStateView }
  | {
      type: 'invocation_state_changed'
      conversationId: string
      invocationId: string
      status: AgentInvocationRecord['status']
      error?: string
    }
  | {
      type: 'message_appended'
      conversationId: string
      entry: ConversationEntry
    }
  | {
      type: 'invocation_updated'
      conversationId: string
      invocation: AgentInvocationDebugRecord
    }

export interface ChatApi {
  getState(): Promise<ChatStateView>
  createConversation(input: CreateChatConversationInput): Promise<ChatConversationDetail>
  readConversation(conversationId: string): Promise<ChatConversationDetail>
  sendMessage(input: SendChatMessageInput): Promise<ChatConversationDetail>
  cancelInvocation(input: CancelChatInvocationInput): Promise<void>
  saveDefaultInstructions(input: SaveChatDefaultInstructionsInput): Promise<ChatStateView>
  subscribe(listener: (event: ChatEvent) => void): () => void
}

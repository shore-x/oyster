import type { LlmBinding } from './ai-backends'
import type { ProcessingToolView, SerializableJsonValue } from './knowledge-processing'

export const CHAT_AGENT_ID = 'chat_agent' as const

export interface ChatSessionModelBinding extends LlmBinding {}

/** Immutable execution binding captured when a conversation is created. */
export interface ChatSessionBinding extends ChatSessionModelBinding {
  systemPrompt: string
}

export interface ChatTranscriptEntry {
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

export interface ChatSessionSummary {
  id: string
  title?: string
  createdAt: string
  updatedAt: string
  messageCount: number
  /** Renderer-visible model selection; the frozen System Prompt remains in session storage. */
  binding: ChatSessionModelBinding
  isRunning: boolean
}

export interface ChatSessionDetail extends ChatSessionSummary {
  messages: ChatTranscriptEntry[]
}

export interface ChatAgentConfigurationView {
  id: typeof CHAT_AGENT_ID
  displayName: string
  description: string
  runtime: 'pi_agent_core'
  tools: ProcessingToolView[]
  builtInInstructions: string
  defaultInstructions: string
  isDefaultCustomized: boolean
}

export interface ChatSnapshot {
  agent: ChatAgentConfigurationView
  sessions: ChatSessionSummary[]
  configurationError?: string
}

export interface CreateChatSessionInput {
  title?: string
}

export interface SendChatMessageInput {
  sessionId: string
  text: string
}

export interface DeleteChatSessionInput {
  sessionId: string
}

export interface CancelChatRunInput {
  sessionId: string
}

export interface SaveChatDefaultInstructionsInput {
  /** null restores the source-code default. */
  instructionsOverride: string | null
}

export type ChatEvent =
  | { type: 'snapshot_changed'; snapshot: ChatSnapshot }
  | {
      type: 'run_state_changed'
      sessionId: string
      status: 'running' | 'completed' | 'failed' | 'cancelled'
      error?: string
    }
  | {
      type: 'message_updated'
      sessionId: string
      message: ChatMessageView
    }
  | {
      type: 'message_appended'
      sessionId: string
      entry: ChatTranscriptEntry
    }
  | {
      type: 'tool_started'
      sessionId: string
      toolCallId: string
      toolName: string
      input: SerializableJsonValue
    }
  | {
      type: 'tool_completed'
      sessionId: string
      toolCallId: string
      toolName: string
      result: SerializableJsonValue
      isError: boolean
    }

export interface ChatApi {
  getSnapshot(): Promise<ChatSnapshot>
  createSession(input: CreateChatSessionInput): Promise<ChatSessionDetail>
  readSession(sessionId: string): Promise<ChatSessionDetail>
  deleteSession(input: DeleteChatSessionInput): Promise<ChatSnapshot>
  sendMessage(input: SendChatMessageInput): Promise<ChatSessionDetail>
  cancelRun(input: CancelChatRunInput): Promise<void>
  saveDefaultInstructions(input: SaveChatDefaultInstructionsInput): Promise<ChatSnapshot>
  subscribe(listener: (event: ChatEvent) => void): () => void
}

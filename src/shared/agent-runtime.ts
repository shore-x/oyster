export type AgentTodoStatus = 'pending' | 'completed'

/** Host-owned work item for one Agent run. It is not a domain record. */
export interface AgentTodo {
  id: string
  content: string
  status: AgentTodoStatus
}

export interface AgentTodoCounts {
  total: number
  pending: number
  completed: number
}

export type SerializableJsonValue =
  | string
  | number
  | boolean
  | null
  | SerializableJsonValue[]
  | { [key: string]: SerializableJsonValue }

export type AgentRunStatus = 'running' | 'completed' | 'failed' | 'cancelled'
export type AgentActivityStatus = AgentRunStatus
export type AgentModelCallPurpose = 'agent' | 'context_compaction'
export const AGENT_RUN_FORMAT_VERSION = 1 as const

export interface AgentTurnRecord {
  id: string
  sequence: number
  status: AgentActivityStatus
  startedAt: string
  completedAt?: string
  durationMs?: number
  messageIds: string[]
  toolCallIds: string[]
}

/** JSON-safe copy of one Pi message emitted by the Agent event stream. */
export interface AgentMessageRecord {
  id: string
  sequence: number
  turnId?: string
  status: 'streaming' | 'completed'
  role: 'user' | 'assistant' | 'tool' | 'runtime'
  message: SerializableJsonValue
}

export interface AgentToolCallRecord {
  id: string
  sequence: number
  turnId?: string
  assistantMessageId?: string
  name: string
  status: AgentActivityStatus
  startedAt: string
  completedAt?: string
  durationMs?: number
  input: SerializableJsonValue
  result?: SerializableJsonValue
  isError?: boolean
}

export interface AgentModelView {
  id: string
  name: string
  provider: string
  api: string
  reasoning: boolean
  contextWindow: number
  maxTokens: number
}

export interface AgentModelCallContext {
  systemPrompt?: string
  messages: SerializableJsonValue[]
  tools?: SerializableJsonValue[]
}

/**
 * One call at the Pi StreamFn boundary. This is the post-transform Pi context,
 * not a provider-specific HTTP payload.
 */
export interface AgentModelCallRecord {
  id: string
  sequence: number
  turnId?: string
  outputMessageId?: string
  purpose: AgentModelCallPurpose
  status: AgentActivityStatus
  startedAt: string
  completedAt?: string
  durationMs?: number
  model: AgentModelView
  context: AgentModelCallContext
  /** Safe generation controls only; credentials, headers, signals, and callbacks are omitted. */
  options?: { [key: string]: SerializableJsonValue }
  output?: SerializableJsonValue
  error?: string
}

/** Generic, renderer-safe observation of one Pi Agent prompt run. */
export interface AgentRunRecord {
  formatVersion: typeof AGENT_RUN_FORMAT_VERSION
  id: string
  /** Stable logical Agent definition, independent from this run instance and its business owner. */
  agentId: string
  parentRunId?: string
  status: AgentRunStatus
  startedAt: string
  completedAt?: string
  durationMs?: number
  error?: string
  turns: AgentTurnRecord[]
  messages: AgentMessageRecord[]
  toolCalls: AgentToolCallRecord[]
  modelCalls: AgentModelCallRecord[]
}

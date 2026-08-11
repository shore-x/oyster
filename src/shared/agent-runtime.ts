export type AgentTodoStatus = 'pending' | 'completed'

/** Host-owned checklist item for one Agent Invocation. It is not a domain Task. */
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

export type AgentInvocationStatus = 'in_progress' | 'completed' | 'failed' | 'cancelled'
export type AgentInvocationActivityStatus = AgentInvocationStatus
export type AgentModelCallPurpose = 'agent' | 'context_compaction'

export const AGENT_INVOCATION_FORMAT_VERSION = 3 as const
export const AGENT_INVOCATION_DEBUG_FORMAT_VERSION = 1 as const

/**
 * The Pi Session range owned by one Invocation. `startEntryId` is the leaf that
 * existed before the Invocation; `endEntryId` is the final leaf after it.
 */
export interface AgentInvocationSessionRef {
  sessionId: string
  sessionFile?: string
  startEntryId?: string
  endEntryId?: string
}

/**
 * Durable business envelope for one accepted Agent execution request.
 * Messages and internal calls deliberately live in Pi Session and Debug Store.
 */
export interface AgentInvocationRecord {
  formatVersion: typeof AGENT_INVOCATION_FORMAT_VERSION
  id: string
  agentId: string
  parentInvocationId?: string
  status: AgentInvocationStatus
  startedAt: string
  completedAt?: string
  durationMs?: number
  error?: string
  session?: AgentInvocationSessionRef
  debugRecordId: string
  modelCallCount: number
  toolCallCount: number
}

export interface AgentTurnRecord {
  id: string
  sequence: number
  status: AgentInvocationActivityStatus
  startedAt: string
  completedAt?: string
  durationMs?: number
  messageIds: string[]
  toolCallIds: string[]
}

/** JSON-safe copy of one Pi message emitted by the Agent event stream. */
export interface AgentInvocationMessageRecord {
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
  status: AgentInvocationActivityStatus
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

export interface AgentProviderRequestDebug {
  /** Final payload after Pi Extension `before_provider_request` hooks. */
  payload: SerializableJsonValue
  /** Final request headers with credential-bearing values redacted. */
  headers?: { [key: string]: SerializableJsonValue }
}

export interface AgentProviderResponseDebug {
  status: number
  headers: { [key: string]: SerializableJsonValue }
}

/** One call at the Pi StreamFn boundary, stored only in the local Debug Store. */
export interface AgentModelCallRecord {
  id: string
  sequence: number
  turnId?: string
  outputMessageId?: string
  purpose: AgentModelCallPurpose
  status: AgentInvocationActivityStatus
  startedAt: string
  completedAt?: string
  durationMs?: number
  model: AgentModelView
  context: AgentModelCallContext
  /** Safe generation controls only; credentials, callbacks, and signals are omitted. */
  options?: { [key: string]: SerializableJsonValue }
  providerRequest?: AgentProviderRequestDebug
  providerResponse?: AgentProviderResponseDebug
  output?: SerializableJsonValue
  error?: string
}

/**
 * Lossless local inspection record. This is a debug projection, not a second
 * conversation history or a telemetry Trace.
 */
export interface AgentInvocationDebugRecord {
  /** Version of the debug-only fields; `formatVersion` remains the Invocation version. */
  debugFormatVersion: typeof AGENT_INVOCATION_DEBUG_FORMAT_VERSION
  formatVersion: typeof AGENT_INVOCATION_FORMAT_VERSION
  id: string
  agentId: string
  parentInvocationId?: string
  status: AgentInvocationStatus
  startedAt: string
  completedAt?: string
  durationMs?: number
  error?: string
  session?: AgentInvocationSessionRef
  debugRecordId: string
  modelCallCount: number
  toolCallCount: number
  turns: AgentTurnRecord[]
  messages: AgentInvocationMessageRecord[]
  toolCalls: AgentToolCallRecord[]
  modelCalls: AgentModelCallRecord[]
}

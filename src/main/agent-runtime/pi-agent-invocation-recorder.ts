import type {
  Agent,
  AgentEvent,
  AgentMessage,
  StreamFn
} from '@earendil-works/pi-agent-core'
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  ProviderHeaders,
  SimpleStreamOptions
} from '@earendil-works/pi-ai'
import type { SessionManager } from '@earendil-works/pi-coding-agent'
import type {
  AgentInvocationActivityStatus,
  AgentInvocationDebugRecord,
  AgentInvocationMessageRecord,
  AgentInvocationRecord,
  AgentInvocationStatus,
  AgentModelCallPurpose,
  AgentModelCallRecord,
  SerializableJsonValue
} from '../../shared/agent-runtime'
import {
  AGENT_INVOCATION_DEBUG_FORMAT_VERSION,
  AGENT_INVOCATION_FORMAT_VERSION
} from '../../shared/agent-runtime'
import type { AgentDebugStore } from './agent-debug-store'
import { InMemoryAgentDebugStore } from './agent-debug-store'

const SAFE_STREAM_OPTION_KEYS = [
  'temperature',
  'maxTokens',
  'reasoning',
  'thinkingBudgets',
  'transport',
  'cacheRetention',
  'sessionId',
  'timeoutMs',
  'websocketConnectTimeoutMs',
  'maxRetries',
  'maxRetryDelayMs'
] as const

const SECRET_HEADER_PATTERN = /^(?:authorization|proxy[-_]authorization|cookie|set[-_]cookie|(?:x[-_])?(?:api[-_]?key|auth[-_]?token|access[-_]?token))$/i

export interface PiAgentInvocationRecorderOptions {
  agentId: string
  invocationId: string
  parentInvocationId?: string
  sessionManager?: Pick<
    SessionManager,
    'getSessionId' | 'getSessionFile' | 'getLeafId'
  >
  debugStore?: AgentDebugStore
  onUpdate?: (record: AgentInvocationDebugRecord) => void
  /** The Coding Agent SDK owns settling/retry; its adapter completes the Invocation explicitly. */
  completeOnAgentEnd?: boolean
}

export interface PiAgentInvocationRecorder {
  attach(agent: Agent): () => void
  wrapStreamFn(
    streamFn: StreamFn,
    purpose?: AgentModelCallPurpose | (() => AgentModelCallPurpose)
  ): StreamFn
  snapshot(): AgentInvocationDebugRecord
  invocationRecord(): AgentInvocationRecord
  complete(status: AgentInvocationStatus, error?: unknown): AgentInvocationDebugRecord
}

function jsonValue(value: unknown): SerializableJsonValue {
  if (value === undefined) return null
  try {
    const serialized = JSON.stringify(value)
    return serialized === undefined ? null : JSON.parse(serialized) as SerializableJsonValue
  } catch {
    return String(value)
  }
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message
  return typeof value === 'string' ? value : String(value)
}

function messageRole(message: AgentMessage): AgentInvocationMessageRecord['role'] {
  if (message.role === 'toolResult') return 'tool'
  if (message.role === 'user' || message.role === 'assistant') return message.role
  return 'runtime'
}

function modelView(model: Model<Api>): AgentModelCallRecord['model'] {
  return {
    id: model.id,
    name: model.name,
    provider: model.provider,
    api: model.api,
    reasoning: model.reasoning,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens
  }
}

function contextView(context: Context): AgentModelCallRecord['context'] {
  return {
    ...(context.systemPrompt === undefined ? {} : { systemPrompt: context.systemPrompt }),
    messages: context.messages.map(jsonValue),
    ...(context.tools ? {
      tools: context.tools.map((tool) => jsonValue({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        ...(tool.constrainedSampling === undefined
          ? {}
          : { constrainedSampling: tool.constrainedSampling })
      }))
    } : {})
  }
}

function safeOptions(options?: SimpleStreamOptions): AgentModelCallRecord['options'] {
  if (!options) return undefined
  const source = options as Record<string, unknown>
  const result: Record<string, SerializableJsonValue> = {}
  for (const key of SAFE_STREAM_OPTION_KEYS) {
    if (source[key] !== undefined) result[key] = jsonValue(source[key])
  }
  return Object.keys(result).length ? result : undefined
}

function debugHeaders(headers: ProviderHeaders | undefined): Record<string, SerializableJsonValue> | undefined {
  if (!headers) return undefined
  const result = Object.fromEntries(Object.entries(headers).map(([name, value]) => [
    name,
    SECRET_HEADER_PATTERN.test(name) ? '[redacted]' : jsonValue(value)
  ]))
  return Object.keys(result).length ? result : undefined
}

function duration(startedAt: string, completedAt: string): number {
  return Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime())
}

function modelCallStatus(message: AssistantMessage): AgentInvocationActivityStatus {
  if (message.stopReason === 'aborted') return 'cancelled'
  return message.stopReason === 'error' ? 'failed' : 'completed'
}

export function createPiAgentInvocationRecorder(
  options: PiAgentInvocationRecorderOptions
): PiAgentInvocationRecorder {
  let sequence = 0
  let turnNumber = 0
  let messageNumber = 0
  let modelCallNumber = 0
  let currentTurnId: string | undefined
  let currentMessageId: string | undefined
  const assistantMessageIdsByToolCall = new Map<string, string>()
  const debugStore = options.debugStore ?? new InMemoryAgentDebugStore()
  const initialLeafId = options.sessionManager?.getLeafId() ?? undefined
  const invocation: AgentInvocationRecord = {
    formatVersion: AGENT_INVOCATION_FORMAT_VERSION,
    invocationId: options.invocationId,
    agentId: options.agentId,
    ...(options.parentInvocationId ? { parentInvocationId: options.parentInvocationId } : {}),
    status: 'in_progress',
    startedAt: new Date().toISOString(),
    ...(options.sessionManager ? {
      session: {
        sessionId: options.sessionManager.getSessionId(),
        ...(options.sessionManager.getSessionFile()
          ? { sessionFile: options.sessionManager.getSessionFile() }
          : {}),
        ...(initialLeafId ? { startEntryId: initialLeafId } : {})
      }
    } : {}),
    debugRecordId: options.invocationId,
    modelCallCount: 0,
    toolCallCount: 0
  }
  const debug: AgentInvocationDebugRecord = {
    ...invocation,
    debugFormatVersion: AGENT_INVOCATION_DEBUG_FORMAT_VERSION,
    turns: [],
    messages: [],
    toolCalls: [],
    modelCalls: []
  }

  const syncEnvelope = (): void => {
    invocation.modelCallCount = debug.modelCalls.length
    invocation.toolCallCount = debug.toolCalls.length
    if (options.sessionManager && invocation.session) {
      const sessionFile = options.sessionManager.getSessionFile()
      const endEntryId = options.sessionManager.getLeafId()
      if (sessionFile) invocation.session.sessionFile = sessionFile
      if (endEntryId) invocation.session.endEntryId = endEntryId
    }
    Object.assign(debug, structuredClone(invocation))
  }

  const snapshot = (): AgentInvocationDebugRecord => {
    syncEnvelope()
    return structuredClone(debug)
  }

  const notify = (persist = true): void => {
    const value = snapshot()
    if (persist) debugStore.save(value)
    try {
      options.onUpdate?.(value)
    } catch {
      // Renderer observation must never change Agent behavior.
    }
  }

  const currentTurn = () => debug.turns.find((turn) => turn.id === currentTurnId)

  const finalizeInProgressActivities = (status: Exclude<AgentInvocationStatus, 'in_progress'>): void => {
    const completedAt = new Date().toISOString()
    for (const turn of debug.turns) {
      if (turn.status !== 'in_progress') continue
      turn.status = status
      turn.completedAt = completedAt
      turn.durationMs = duration(turn.startedAt, completedAt)
    }
    for (const call of debug.toolCalls) {
      if (call.status !== 'in_progress') continue
      call.status = status
      call.completedAt = completedAt
      call.durationMs = duration(call.startedAt, completedAt)
    }
    for (const call of debug.modelCalls) {
      if (call.status !== 'in_progress') continue
      call.status = status
      call.completedAt = completedAt
      call.durationMs = duration(call.startedAt, completedAt)
    }
    for (const message of debug.messages) {
      if (message.status === 'streaming') message.status = 'completed'
    }
  }

  const complete = (status: AgentInvocationStatus, error?: unknown): AgentInvocationDebugRecord => {
    if (invocation.status !== 'in_progress') return snapshot()
    if (status === 'in_progress') return snapshot()
    finalizeInProgressActivities(status)
    const completedAt = new Date().toISOString()
    invocation.status = status
    invocation.completedAt = completedAt
    invocation.durationMs = duration(invocation.startedAt, completedAt)
    if (error !== undefined) invocation.error = errorMessage(error)
    else delete invocation.error
    notify()
    return snapshot()
  }

  const recordMessage = (message: AgentMessage): void => {
    const id = `${invocation.invocationId}:message:${++messageNumber}`
    currentMessageId = id
    const record: AgentInvocationMessageRecord = {
      id,
      sequence: ++sequence,
      ...(currentTurnId ? { turnId: currentTurnId } : {}),
      status: 'streaming',
      role: messageRole(message),
      message: jsonValue(message)
    }
    debug.messages.push(record)
    currentTurn()?.messageIds.push(id)
    if (message.role === 'assistant') {
      const call = [...debug.modelCalls].reverse().find((candidate) => (
        candidate.purpose === 'agent'
        && candidate.outputMessageId === undefined
        && candidate.turnId === currentTurnId
      ))
      if (call) call.outputMessageId = id
    }
  }

  const updateMessage = (message: AgentMessage, completed: boolean): void => {
    const record = debug.messages.find((candidate) => candidate.id === currentMessageId)
    if (!record) return
    record.message = jsonValue(message)
    if (completed) {
      record.status = 'completed'
      if (message.role === 'assistant') {
        for (const block of message.content) {
          if (block.type === 'toolCall') assistantMessageIdsByToolCall.set(block.id, record.id)
        }
      }
      currentMessageId = undefined
    }
  }

  const recordEvent = (event: AgentEvent): void => {
    if (event.type === 'agent_start') {
      invocation.status = 'in_progress'
      notify()
      return
    }
    if (event.type === 'turn_start') {
      const id = `${invocation.invocationId}:turn:${++turnNumber}`
      currentTurnId = id
      debug.turns.push({
        id,
        sequence: ++sequence,
        status: 'in_progress',
        startedAt: new Date().toISOString(),
        messageIds: [],
        toolCallIds: []
      })
      notify()
      return
    }
    if (event.type === 'message_start') {
      recordMessage(event.message)
      notify()
      return
    }
    if (event.type === 'message_update') {
      updateMessage(event.message, false)
      notify(false)
      return
    }
    if (event.type === 'message_end') {
      updateMessage(event.message, true)
      notify()
      return
    }
    if (event.type === 'tool_execution_start') {
      debug.toolCalls.push({
        id: event.toolCallId,
        sequence: ++sequence,
        ...(currentTurnId ? { turnId: currentTurnId } : {}),
        ...(assistantMessageIdsByToolCall.get(event.toolCallId)
          ? { assistantMessageId: assistantMessageIdsByToolCall.get(event.toolCallId) }
          : {}),
        name: event.toolName,
        status: 'in_progress',
        startedAt: new Date().toISOString(),
        input: jsonValue(event.args)
      })
      currentTurn()?.toolCallIds.push(event.toolCallId)
      notify()
      return
    }
    if (event.type === 'tool_execution_update') {
      const call = debug.toolCalls.find((candidate) => candidate.id === event.toolCallId)
      if (call) call.result = jsonValue(event.partialResult)
      notify()
      return
    }
    if (event.type === 'tool_execution_end') {
      const call = debug.toolCalls.find((candidate) => candidate.id === event.toolCallId)
      if (!call) return
      const completedAt = new Date().toISOString()
      call.status = event.isError ? 'failed' : 'completed'
      call.completedAt = completedAt
      call.durationMs = duration(call.startedAt, completedAt)
      call.result = jsonValue(event.result)
      call.isError = event.isError
      notify()
      return
    }
    if (event.type === 'turn_end') {
      const turn = currentTurn()
      if (turn) {
        const completedAt = new Date().toISOString()
        turn.status = event.message.role === 'assistant'
          ? modelCallStatus(event.message)
          : 'completed'
        turn.completedAt = completedAt
        turn.durationMs = duration(turn.startedAt, completedAt)
      }
      currentTurnId = undefined
      notify()
      return
    }
    if (options.completeOnAgentEnd === false) {
      notify()
      return
    }
    const lastAssistant = [...event.messages].reverse().find(
      (message): message is AssistantMessage => message.role === 'assistant'
    )
    complete(lastAssistant ? modelCallStatus(lastAssistant) : 'completed', lastAssistant?.errorMessage)
  }

  const wrapStreamFn = (
    streamFn: StreamFn,
    purpose: AgentModelCallPurpose | (() => AgentModelCallPurpose) = 'agent'
  ): StreamFn => async (model, context, streamOptions) => {
    const id = `${invocation.invocationId}:model:${++modelCallNumber}`
    const call: AgentModelCallRecord = {
      id,
      sequence: ++sequence,
      ...(currentTurnId ? { turnId: currentTurnId } : {}),
      purpose: typeof purpose === 'function' ? purpose() : purpose,
      status: 'in_progress',
      startedAt: new Date().toISOString(),
      model: modelView(model),
      context: contextView(context),
      ...(safeOptions(streamOptions) ? { options: safeOptions(streamOptions) } : {})
    }
    debug.modelCalls.push(call)
    notify()
    const originalPayload = streamOptions?.onPayload
    const originalResponse = streamOptions?.onResponse
    const observedOptions: SimpleStreamOptions = {
      ...streamOptions,
      onPayload: async (payload, requestedModel) => {
        const transformed = await originalPayload?.(payload, requestedModel)
        const finalPayload = transformed === undefined ? payload : transformed
        call.providerRequest = {
          payload: jsonValue(finalPayload),
          ...(debugHeaders(streamOptions?.headers)
            ? { headers: debugHeaders(streamOptions?.headers) }
            : {})
        }
        notify()
        return finalPayload
      },
      onResponse: async (response, requestedModel) => {
        call.providerResponse = {
          status: response.status,
          headers: debugHeaders(response.headers) ?? {}
        }
        notify()
        await originalResponse?.(response, requestedModel)
      }
    }
    try {
      const stream = await streamFn(model, context, observedOptions)
      void Promise.resolve(stream.result()).then((message) => {
        const completedAt = new Date().toISOString()
        call.status = modelCallStatus(message)
        call.completedAt = completedAt
        call.durationMs = duration(call.startedAt, completedAt)
        call.output = jsonValue(message)
        if (message.errorMessage) call.error = message.errorMessage
        notify()
      }, (error) => {
        const completedAt = new Date().toISOString()
        call.status = 'failed'
        call.completedAt = completedAt
        call.durationMs = duration(call.startedAt, completedAt)
        call.error = errorMessage(error)
        notify()
      })
      return stream
    } catch (error) {
      const completedAt = new Date().toISOString()
      call.status = 'failed'
      call.completedAt = completedAt
      call.durationMs = duration(call.startedAt, completedAt)
      call.error = errorMessage(error)
      notify()
      throw error
    }
  }

  notify()
  return {
    attach: (agent) => agent.subscribe(recordEvent),
    wrapStreamFn,
    snapshot,
    invocationRecord: () => {
      syncEnvelope()
      return structuredClone(invocation)
    },
    complete
  }
}

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
  SimpleStreamOptions
} from '@earendil-works/pi-ai'
import type {
  AgentActivityStatus,
  AgentMessageRecord,
  AgentModelCallPurpose,
  AgentModelCallRecord,
  AgentRunRecord,
  AgentRunStatus,
  SerializableJsonValue
} from '../../shared/agent-runtime'

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

export interface PiAgentRunRecorderOptions {
  runId: string
  parentRunId?: string
  onUpdate?: (run: AgentRunRecord) => void
}

export interface PiAgentRunRecorder {
  attach(agent: Agent): () => void
  wrapStreamFn(streamFn: StreamFn, purpose?: AgentModelCallPurpose): StreamFn
  snapshot(): AgentRunRecord
  complete(status: AgentRunStatus, error?: unknown): AgentRunRecord
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

function messageRole(message: AgentMessage): AgentMessageRecord['role'] {
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

function duration(startedAt: string, completedAt: string): number {
  return Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime())
}

function modelCallStatus(message: AssistantMessage): AgentActivityStatus {
  if (message.stopReason === 'aborted') return 'cancelled'
  return message.stopReason === 'error' ? 'failed' : 'completed'
}

export function createPiAgentRunRecorder(
  options: PiAgentRunRecorderOptions
): PiAgentRunRecorder {
  let sequence = 0
  let turnNumber = 0
  let messageNumber = 0
  let modelCallNumber = 0
  let currentTurnId: string | undefined
  let currentMessageId: string | undefined
  const assistantMessageIdsByToolCall = new Map<string, string>()
  const run: AgentRunRecord = {
    id: options.runId,
    ...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
    status: 'running',
    startedAt: new Date().toISOString(),
    turns: [],
    messages: [],
    toolCalls: [],
    modelCalls: []
  }

  const notify = (): void => {
    try {
      options.onUpdate?.(structuredClone(run))
    } catch {
      // Observation is a side channel and must never change Agent behavior.
    }
  }

  const currentTurn = () => run.turns.find((turn) => turn.id === currentTurnId)

  const finalizeRunningActivities = (status: Exclude<AgentRunStatus, 'running'>): void => {
    const completedAt = new Date().toISOString()
    for (const turn of run.turns) {
      if (turn.status !== 'running') continue
      turn.status = status
      turn.completedAt = completedAt
      turn.durationMs = duration(turn.startedAt, completedAt)
    }
    for (const call of run.toolCalls) {
      if (call.status !== 'running') continue
      call.status = status
      call.completedAt = completedAt
      call.durationMs = duration(call.startedAt, completedAt)
    }
    for (const call of run.modelCalls) {
      if (call.status !== 'running') continue
      call.status = status
      call.completedAt = completedAt
      call.durationMs = duration(call.startedAt, completedAt)
    }
    for (const message of run.messages) {
      if (message.status === 'streaming') message.status = 'completed'
    }
  }

  const complete = (status: AgentRunStatus, error?: unknown): AgentRunRecord => {
    if (status === 'running') {
      run.status = status
      delete run.completedAt
      delete run.durationMs
      delete run.error
      notify()
      return structuredClone(run)
    }
    finalizeRunningActivities(status)
    const completedAt = new Date().toISOString()
    run.status = status
    run.completedAt = completedAt
    run.durationMs = duration(run.startedAt, completedAt)
    if (error !== undefined) run.error = errorMessage(error)
    else delete run.error
    notify()
    return structuredClone(run)
  }

  const recordMessage = (message: AgentMessage): void => {
    const id = `${run.id}:message:${++messageNumber}`
    currentMessageId = id
    const record: AgentMessageRecord = {
      id,
      sequence: ++sequence,
      ...(currentTurnId ? { turnId: currentTurnId } : {}),
      status: 'streaming',
      role: messageRole(message),
      message: jsonValue(message)
    }
    run.messages.push(record)
    currentTurn()?.messageIds.push(id)
    if (message.role === 'assistant') {
      const call = [...run.modelCalls].reverse().find((candidate) => (
        candidate.purpose === 'agent'
        && candidate.outputMessageId === undefined
        && candidate.turnId === currentTurnId
      ))
      if (call) call.outputMessageId = id
    }
  }

  const updateMessage = (message: AgentMessage, completed: boolean): void => {
    const record = run.messages.find((candidate) => candidate.id === currentMessageId)
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
      run.status = 'running'
      notify()
      return
    }
    if (event.type === 'turn_start') {
      const id = `${run.id}:turn:${++turnNumber}`
      currentTurnId = id
      run.turns.push({
        id,
        sequence: ++sequence,
        status: 'running',
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
      notify()
      return
    }
    if (event.type === 'message_end') {
      updateMessage(event.message, true)
      notify()
      return
    }
    if (event.type === 'tool_execution_start') {
      run.toolCalls.push({
        id: event.toolCallId,
        sequence: ++sequence,
        ...(currentTurnId ? { turnId: currentTurnId } : {}),
        ...(assistantMessageIdsByToolCall.get(event.toolCallId)
          ? { assistantMessageId: assistantMessageIdsByToolCall.get(event.toolCallId) }
          : {}),
        name: event.toolName,
        status: 'running',
        startedAt: new Date().toISOString(),
        input: jsonValue(event.args)
      })
      currentTurn()?.toolCallIds.push(event.toolCallId)
      notify()
      return
    }
    if (event.type === 'tool_execution_update') {
      const call = run.toolCalls.find((candidate) => candidate.id === event.toolCallId)
      if (call) call.result = jsonValue(event.partialResult)
      notify()
      return
    }
    if (event.type === 'tool_execution_end') {
      const call = run.toolCalls.find((candidate) => candidate.id === event.toolCallId)
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
    const lastAssistant = [...event.messages].reverse().find(
      (message): message is AssistantMessage => message.role === 'assistant'
    )
    complete(lastAssistant ? modelCallStatus(lastAssistant) : 'completed', lastAssistant?.errorMessage)
  }

  const wrapStreamFn = (
    streamFn: StreamFn,
    purpose: AgentModelCallPurpose = 'agent'
  ): StreamFn => async (model, context, streamOptions) => {
    const id = `${run.id}:model:${++modelCallNumber}`
    const call: AgentModelCallRecord = {
      id,
      sequence: ++sequence,
      ...(currentTurnId ? { turnId: currentTurnId } : {}),
      purpose,
      status: 'running',
      startedAt: new Date().toISOString(),
      model: modelView(model),
      context: contextView(context),
      ...(safeOptions(streamOptions) ? { options: safeOptions(streamOptions) } : {})
    }
    run.modelCalls.push(call)
    notify()
    try {
      const stream = await streamFn(model, context, streamOptions)
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
    snapshot: () => structuredClone(run),
    complete
  }
}

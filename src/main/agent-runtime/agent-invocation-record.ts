import {
  AGENT_INVOCATION_DEBUG_FORMAT_VERSION,
  AGENT_INVOCATION_FORMAT_VERSION,
  type AgentInvocationDebugRecord,
  type AgentInvocationRecord,
  type AgentInvocationStatus
} from '../../shared/agent-runtime'

const AGENT_INVOCATION_STATUSES: readonly AgentInvocationStatus[] = [
  'in_progress',
  'completed',
  'failed',
  'cancelled'
]
const MAX_AGENT_INVOCATION_ID_LENGTH = 256
const MAX_AGENT_ID_LENGTH = 256

function requiredString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string') throw new Error(`${label} 必须是字符串`)
  const normalized = value.trim()
  if (!normalized || normalized.length > maximum) throw new Error(`${label} 格式无效`)
  return normalized
}

function optionalError(value: unknown): void {
  if (value !== undefined && typeof value !== 'string') {
    throw new Error('Agent Invocation 错误信息必须是字符串')
  }
}

/** Validate the small, role-agnostic Invocation persistence envelope. */
export function parseAgentInvocationRecord(
  value: unknown,
  expectedInvocationId?: string
): AgentInvocationRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Agent Invocation 记录格式无效')
  }
  const record = value as Partial<AgentInvocationRecord> & {
    formatVersion?: number
    /** Version 3 compatibility. */
    id?: unknown
  }
  if (record.formatVersion !== AGENT_INVOCATION_FORMAT_VERSION && record.formatVersion !== 3) {
    throw new Error(`Agent Invocation 格式版本无效：${String(record.formatVersion)}`)
  }
  const invocationId = requiredString(
    record.invocationId ?? record.id,
    'Agent Invocation ID',
    MAX_AGENT_INVOCATION_ID_LENGTH
  )
  if (expectedInvocationId !== undefined && invocationId !== expectedInvocationId) {
    throw new Error('Agent Invocation ID 与持久化索引不匹配')
  }
  requiredString(record.agentId, 'Agent ID', MAX_AGENT_ID_LENGTH)
  if (record.parentInvocationId !== undefined) {
    const parentInvocationId = requiredString(
      record.parentInvocationId,
      '父 Agent Invocation ID',
      MAX_AGENT_INVOCATION_ID_LENGTH
    )
    if (parentInvocationId === invocationId) throw new Error('Agent Invocation 不能以自身作为父 Invocation')
  }
  if (!record.status || !AGENT_INVOCATION_STATUSES.includes(record.status)) {
    throw new Error('Agent Invocation 状态无效')
  }
  requiredString(record.startedAt, 'Agent Invocation 开始时间', 128)
  requiredString(record.debugRecordId, 'Debug Record ID', MAX_AGENT_INVOCATION_ID_LENGTH)
  optionalError(record.error)
  for (const [label, count] of [
    ['Model Call', record.modelCallCount],
    ['Tool Call', record.toolCallCount]
  ] as const) {
    if (!Number.isSafeInteger(count) || (count as number) < 0) {
      throw new Error(`${label} 计数无效：${invocationId}`)
    }
  }
  if (record.session) {
    requiredString(record.session.sessionId, 'Pi Session ID', 512)
    if (record.session.sessionFile !== undefined) {
      requiredString(record.session.sessionFile, 'Pi Session 文件', 8_192)
    }
  }
  if (record.status === 'in_progress') {
    if (record.completedAt !== undefined || record.durationMs !== undefined) {
      throw new Error(`处于 in_progress 的 Agent Invocation 不能包含终态时间：${invocationId}`)
    }
  } else {
    requiredString(record.completedAt, 'Agent Invocation 完成时间', 128)
    if (typeof record.durationMs !== 'number'
      || !Number.isFinite(record.durationMs)
      || record.durationMs < 0) {
      throw new Error(`Agent Invocation 耗时无效：${invocationId}`)
    }
  }
  return structuredClone({
    formatVersion: AGENT_INVOCATION_FORMAT_VERSION,
    invocationId,
    agentId: record.agentId,
    ...(record.parentInvocationId ? { parentInvocationId: record.parentInvocationId } : {}),
    status: record.status,
    startedAt: record.startedAt,
    ...(record.completedAt ? { completedAt: record.completedAt } : {}),
    ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
    ...(record.error !== undefined ? { error: record.error } : {}),
    ...(record.session ? { session: record.session } : {}),
    debugRecordId: record.debugRecordId,
    modelCallCount: record.modelCallCount,
    toolCallCount: record.toolCallCount
  } as AgentInvocationRecord)
}

export function parseTerminalAgentInvocationRecord(value: unknown): AgentInvocationRecord {
  const record = parseAgentInvocationRecord(value)
  if (record.status === 'in_progress') {
    throw new Error(`Agent Invocation 尚未终态化：${record.invocationId}`)
  }
  return record
}

export function parseAgentInvocationDebugRecord(
  value: unknown,
  expectedInvocationId?: string
): AgentInvocationDebugRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Agent Invocation Debug Record 格式无效')
  }
  const debug = value as Partial<AgentInvocationDebugRecord>
  if (debug.debugFormatVersion !== AGENT_INVOCATION_DEBUG_FORMAT_VERSION) {
    throw new Error(`Agent Invocation Debug 格式版本无效：${String(debug.debugFormatVersion)}`)
  }
  const invocation = parseAgentInvocationRecord(debug, expectedInvocationId)
  if (!Array.isArray(debug.turns)
    || !Array.isArray(debug.messages)
    || !Array.isArray(debug.toolCalls)
    || !Array.isArray(debug.modelCalls)) {
    throw new Error('Agent Invocation Debug 活动记录格式无效')
  }
  if (invocation.toolCallCount !== debug.toolCalls.length
    || invocation.modelCallCount !== debug.modelCalls.length) {
    throw new Error(`Agent Invocation Debug 计数不一致：${invocation.invocationId}`)
  }
  return structuredClone({
    ...invocation,
    debugFormatVersion: AGENT_INVOCATION_DEBUG_FORMAT_VERSION,
    turns: debug.turns,
    messages: debug.messages,
    toolCalls: debug.toolCalls,
    modelCalls: debug.modelCalls
  } as AgentInvocationDebugRecord)
}

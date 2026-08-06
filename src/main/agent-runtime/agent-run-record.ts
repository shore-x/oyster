import {
  AGENT_RUN_FORMAT_VERSION,
  type AgentRunRecord,
  type AgentRunStatus
} from '../../shared/agent-runtime'

const AGENT_RUN_STATUSES: readonly AgentRunStatus[] = [
  'running',
  'completed',
  'failed',
  'cancelled'
]
const MAX_AGENT_RUN_ID_LENGTH = 256
const MAX_AGENT_ID_LENGTH = 256

function requiredString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string') throw new Error(`${label} 必须是字符串`)
  const normalized = value.trim()
  if (!normalized || normalized.length > maximum) throw new Error(`${label} 格式无效`)
  return normalized
}

function optionalError(value: unknown): void {
  if (value !== undefined && typeof value !== 'string') {
    throw new Error('Agent Run 错误信息必须是字符串')
  }
}

/**
 * Validate the shared, Agent-role-agnostic persistence envelope.
 * Domain repositories must use this boundary instead of maintaining local shape checks.
 */
export function parseAgentRunRecord(
  value: unknown,
  expectedRunId?: string
): AgentRunRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Agent Run 记录格式无效')
  }
  const record = value as Partial<AgentRunRecord>
  if (record.formatVersion !== AGENT_RUN_FORMAT_VERSION) {
    throw new Error(`Agent Run 格式版本无效：${String(record.formatVersion)}`)
  }
  const id = requiredString(record.id, 'Agent Run ID', MAX_AGENT_RUN_ID_LENGTH)
  if (expectedRunId !== undefined && id !== expectedRunId) {
    throw new Error('Agent Run ID 与持久化索引不匹配')
  }
  requiredString(record.agentId, 'Agent ID', MAX_AGENT_ID_LENGTH)
  if (record.parentRunId !== undefined) {
    const parentRunId = requiredString(record.parentRunId, '父 Agent Run ID', MAX_AGENT_RUN_ID_LENGTH)
    if (parentRunId === id) throw new Error('Agent Run 不能以自身作为父运行')
  }
  if (!record.status || !AGENT_RUN_STATUSES.includes(record.status)) {
    throw new Error('Agent Run 状态无效')
  }
  requiredString(record.startedAt, 'Agent Run 开始时间', 128)
  optionalError(record.error)
  if (record.status === 'running') {
    if (record.completedAt !== undefined || record.durationMs !== undefined) {
      throw new Error(`运行中的 Agent Run 不能包含终态时间：${id}`)
    }
  } else {
    requiredString(record.completedAt, 'Agent Run 完成时间', 128)
    if (typeof record.durationMs !== 'number'
      || !Number.isFinite(record.durationMs)
      || record.durationMs < 0) {
      throw new Error(`Agent Run 耗时无效：${id}`)
    }
  }
  if (!Array.isArray(record.turns)
    || !Array.isArray(record.messages)
    || !Array.isArray(record.toolCalls)
    || !Array.isArray(record.modelCalls)) {
    throw new Error('Agent Run 活动记录格式无效')
  }
  return structuredClone(record as AgentRunRecord)
}

export function parseTerminalAgentRunRecord(value: unknown): AgentRunRecord {
  const record = parseAgentRunRecord(value)
  if (record.status === 'running') {
    throw new Error(`Agent Run 尚未终态化：${record.id}`)
  }
  if (record.turns.some((turn) => turn.status === 'running')
    || record.toolCalls.some((call) => call.status === 'running')
    || record.modelCalls.some((call) => call.status === 'running')
    || record.messages.some((message) => message.status === 'streaming')) {
    throw new Error(`Agent Run 仍包含运行中活动：${record.id}`)
  }
  return record
}

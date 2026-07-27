import type { AgentType } from '../../shared/discovery'

interface MessageEvent {
  role: 'user' | 'assistant'
  timestamp?: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : undefined
}

function messageRole(value: unknown): MessageEvent['role'] | undefined {
  return value === 'user' || value === 'assistant' ? value : undefined
}

function isoValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string' && typeof value !== 'number') continue
    const date = new Date(value)
    if (!Number.isNaN(date.valueOf())) return date.toISOString()
  }
  return undefined
}

function isClaudeToolResultOnly(message?: Record<string, unknown>): boolean {
  if (!Array.isArray(message?.content) || message.content.length === 0) return false
  return message.content.every((item) => asRecord(item)?.type === 'tool_result')
}

function messageEvent(
  agentType: AgentType,
  record: Record<string, unknown>
): MessageEvent | undefined {
  if (agentType === 'claude') {
    const message = asRecord(record.message)
    const role = messageRole(record.type) ?? messageRole(message?.role)
    if (!role || (record.type !== 'user' && record.type !== 'assistant')) return undefined
    if (role === 'user' && isClaudeToolResultOnly(message)) return undefined
    return {
      role,
      timestamp: isoValue(record.timestamp, message?.timestamp, record.createdAt)
    }
  }

  if (agentType === 'pi') {
    if (record.type !== 'message') return undefined
    const message = asRecord(record.message)
    const role = messageRole(record.role) ?? messageRole(message?.role)
    if (!role) return undefined
    return {
      role,
      timestamp: isoValue(record.timestamp, message?.timestamp, record.createdAt)
    }
  }

  if (record.type !== 'response_item') return undefined
  const payload = asRecord(record.payload)
  const role = messageRole(payload?.role)
  if (!payload || !role || (payload.type !== undefined && payload.type !== 'message')) return undefined
  return {
    role,
    timestamp: isoValue(record.timestamp, payload.timestamp, payload.createdAt)
  }
}

/** Incrementally derives semantic Session metadata without retaining conversation content. */
export class SessionInspector {
  private count = 0
  private firstMessageAt: string | undefined
  private lastMessageAt: string | undefined

  constructor(private readonly agentType: AgentType) {}

  visitLine(line: string): void {
    if (!line.trim()) return
    try {
      const record = asRecord(JSON.parse(line))
      if (!record) return
      const event = messageEvent(this.agentType, record)
      if (!event) return
      this.count += 1
      if (!event.timestamp) return
      if (!this.firstMessageAt || event.timestamp < this.firstMessageAt) {
        this.firstMessageAt = event.timestamp
      }
      if (!this.lastMessageAt || event.timestamp > this.lastMessageAt) {
        this.lastMessageAt = event.timestamp
      }
    } catch {
      // Malformed events do not make the surrounding Session unusable.
    }
  }

  result(): { messageCount: number; startedAt?: string; endedAt?: string } {
    return {
      messageCount: this.count,
      startedAt: this.firstMessageAt,
      endedAt: this.lastMessageAt
    }
  }
}

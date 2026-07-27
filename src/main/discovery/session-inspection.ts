export interface MessageEvent {
  role: 'user' | 'assistant'
  timestamp?: string
}

export type SessionRecordInspector = (
  record: Record<string, unknown>
) => MessageEvent | undefined

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : undefined
}

/** Incrementally derives semantic Session metadata without retaining conversation content. */
export class SessionInspector {
  private count = 0
  private firstMessageAt: string | undefined
  private lastMessageAt: string | undefined

  constructor(private readonly inspectRecord: SessionRecordInspector) {}

  visitLine(line: string): void {
    if (!line.trim()) return
    try {
      const record = asRecord(JSON.parse(line))
      if (!record) return
      const event = this.inspectRecord(record)
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

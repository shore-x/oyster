import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { ChatMessageView } from '../../shared/chat'
import type { SerializableJsonValue } from '../../shared/agent-runtime'

export function serializableChatValue(value: unknown): SerializableJsonValue {
  if (value === undefined) return null
  try {
    const serialized = JSON.stringify(value)
    return serialized === undefined ? null : JSON.parse(serialized) as SerializableJsonValue
  } catch {
    return String(value)
  }
}

function textContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const block = item as Record<string, unknown>
    if (block.type === 'text' && typeof block.text === 'string') return [block.text]
    if (block.type === 'image') return ['[image]']
    return []
  }).join('\n')
}

/** Renderer-safe projection. Raw Pi messages remain unchanged in JSONL storage. */
export function chatMessageView(message: AgentMessage): ChatMessageView {
  if (message.role === 'user') {
    return {
      role: 'user',
      text: textContent(message.content),
      timestamp: message.timestamp
    }
  }
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      text: textContent(message.content),
      toolCalls: message.content.flatMap((block) => block.type === 'toolCall'
        ? [{ id: block.id, name: block.name, input: serializableChatValue(block.arguments) }]
        : []),
      model: message.model,
      stopReason: message.stopReason,
      ...(message.errorMessage ? { error: message.errorMessage } : {}),
      timestamp: message.timestamp
    }
  }
  if (message.role !== 'toolResult') {
    throw new Error(`对话 Session 包含不支持的内部消息类型：${message.role}`)
  }
  return {
    role: 'tool',
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    text: textContent(message.content),
    isError: message.isError,
    ...(message.details === undefined ? {} : { details: serializableChatValue(message.details) }),
    timestamp: message.timestamp
  }
}

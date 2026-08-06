import {
  JsonlSessionRepo,
  type JsonlSessionMetadata,
  type Session,
  type SessionTreeEntry
} from '@earendil-works/pi-agent-core'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node'
import { REASONING_EFFORTS, type ReasoningEffort } from '../../shared/ai-backends'
import type {
  ChatSessionBinding,
  ChatSessionDetail,
  ChatSessionSummary,
  ChatTranscriptEntry
} from '../../shared/chat'
import type { ChatSessionRepository, PersistedChatSession } from './model'
import { chatMessageView } from './chat-message-view'
import { isAgentRuntimeFeedbackMessage } from '../agent-runtime/pi-agent-runtime'
import type { AgentRunRecord } from '../../shared/agent-runtime'

const CHAT_METADATA_KIND = 'oyster-chat'
const CHAT_RUN_CUSTOM_ENTRY = 'oyster-agent-run-v1'
const MAX_CHAT_TITLE_LENGTH = 512

interface ChatSessionMetadataPayload {
  kind: typeof CHAT_METADATA_KIND
  binding: ChatSessionBinding
}

function requiredString(value: unknown, label: string, maximum?: number): string {
  if (typeof value !== 'string') throw new Error(`${label} 必须是字符串`)
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} 不能为空`)
  if (maximum !== undefined && normalized.length > maximum) {
    throw new Error(`${label} 超出长度上限 ${maximum}`)
  }
  return normalized
}

function normalizeBinding(value: unknown): ChatSessionBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('对话 Session 的模型绑定无效')
  }
  const record = value as Record<string, unknown>
  const reasoningEffort = record.reasoningEffort
  if (
    reasoningEffort !== undefined
    && (
      typeof reasoningEffort !== 'string'
      || !REASONING_EFFORTS.includes(reasoningEffort as ReasoningEffort)
    )
  ) {
    throw new Error('对话 Session 的思考强度无效')
  }
  return {
    connectionId: requiredString(record.connectionId, 'Connection ID', 512),
    modelId: requiredString(record.modelId, 'Model ID', 512),
    systemPrompt: requiredString(record.systemPrompt, 'System Prompt'),
    ...(reasoningEffort ? { reasoningEffort: reasoningEffort as ReasoningEffort } : {})
  }
}

function metadataPayload(metadata: JsonlSessionMetadata): ChatSessionMetadataPayload | undefined {
  const value = metadata.metadata
  if (!value || value.kind !== CHAT_METADATA_KIND) return undefined
  return { kind: CHAT_METADATA_KIND, binding: normalizeBinding(value.binding) }
}

function messageEntries(entries: readonly SessionTreeEntry[]): ChatTranscriptEntry[] {
  return entries.flatMap((entry) => entry.type === 'message' && !isAgentRuntimeFeedbackMessage(entry.message)
    ? [{ id: entry.id, createdAt: entry.timestamp, message: chatMessageView(entry.message) }]
    : [])
}

function runEntries(entries: readonly SessionTreeEntry[]): AgentRunRecord[] {
  return entries.flatMap((entry) => {
    if (entry.type !== 'custom' || entry.customType !== CHAT_RUN_CUSTOM_ENTRY) return []
    const run = entry.data as AgentRunRecord | undefined
    if (
      !run
      || typeof run !== 'object'
      || typeof run.id !== 'string'
      || !Array.isArray(run.turns)
      || !Array.isArray(run.messages)
      || !Array.isArray(run.toolCalls)
      || !Array.isArray(run.modelCalls)
    ) return []
    return [structuredClone(run)]
  })
}

export async function appendChatAgentRun(session: Session, run: AgentRunRecord): Promise<void> {
  await session.appendCustomEntry(CHAT_RUN_CUSTOM_ENTRY, structuredClone(run))
}

async function sessionSummary(
  session: Session,
  binding: ChatSessionBinding,
  running: boolean
): Promise<ChatSessionSummary> {
  const [metadata, title, entries] = await Promise.all([
    session.getMetadata(),
    session.getSessionName(),
    session.getEntries()
  ])
  const messages = messageEntries(entries)
  return {
    id: metadata.id,
    ...(title ? { title } : {}),
    createdAt: metadata.createdAt,
    updatedAt: entries.at(-1)?.timestamp ?? metadata.createdAt,
    messageCount: messages.length,
    binding: {
      connectionId: binding.connectionId,
      modelId: binding.modelId,
      ...(binding.reasoningEffort ? { reasoningEffort: binding.reasoningEffort } : {})
    },
    isRunning: running
  }
}

/**
 * Thin Oyster adapter over Pi's native JSONL session repository.
 *
 * The raw Pi messages remain intact, including assistant tool calls and tool-result messages.
 * Chat history is intentionally stored separately from the Knowledge Store database.
 */
export class PiChatSessionRepository implements ChatSessionRepository {
  private readonly environment: NodeExecutionEnv
  private readonly repository: JsonlSessionRepo

  constructor(readonly rootPath: string) {
    this.environment = new NodeExecutionEnv({ cwd: rootPath })
    this.repository = new JsonlSessionRepo({
      fs: this.environment,
      sessionsRoot: rootPath
    })
  }

  async create(binding: ChatSessionBinding, title?: string): Promise<PersistedChatSession> {
    const normalizedBinding = normalizeBinding(binding)
    const normalizedTitle = title === undefined
      ? undefined
      : requiredString(title, '对话标题', MAX_CHAT_TITLE_LENGTH)
    const session = await this.repository.create({
      cwd: this.rootPath,
      metadata: {
        kind: CHAT_METADATA_KIND,
        binding: normalizedBinding
      }
    })
    if (normalizedTitle) await session.appendSessionName(normalizedTitle)
    return { session, binding: normalizedBinding }
  }

  private async metadataFor(sessionId: string): Promise<JsonlSessionMetadata> {
    const normalizedId = requiredString(sessionId, 'Session ID', 512)
    const metadata = (await this.repository.list({ cwd: this.rootPath })).find((candidate) => (
      candidate.id === normalizedId && metadataPayload(candidate)
    ))
    if (!metadata) throw new Error('对话 Session 不存在')
    return metadata
  }

  async open(sessionId: string): Promise<PersistedChatSession> {
    const metadata = await this.metadataFor(sessionId)
    const payload = metadataPayload(metadata)
    if (!payload) throw new Error('对话 Session 元数据无效')
    return {
      session: await this.repository.open(metadata),
      binding: payload.binding
    }
  }

  async list(): Promise<ChatSessionSummary[]> {
    const metadata = await this.repository.list({ cwd: this.rootPath })
    const summaries: ChatSessionSummary[] = []
    for (const item of metadata) {
      const payload = metadataPayload(item)
      if (!payload) continue
      const session = await this.repository.open(item)
      summaries.push(await sessionSummary(session, payload.binding, false))
    }
    return summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  async detail(sessionId: string, running = false): Promise<ChatSessionDetail> {
    const opened = await this.open(sessionId)
    const entries = await opened.session.getEntries()
    return {
      ...await sessionSummary(opened.session, opened.binding, running),
      messages: messageEntries(entries),
      runs: runEntries(entries)
    }
  }

  async delete(sessionId: string): Promise<void> {
    await this.repository.delete(await this.metadataFor(sessionId))
  }

  async dispose(): Promise<void> {
    await this.environment.cleanup()
  }
}

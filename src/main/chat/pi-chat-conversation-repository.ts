import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  SessionManager,
  type SessionEntry,
  type SessionHeader
} from '@earendil-works/pi-coding-agent'
import { REASONING_EFFORTS, type ReasoningEffort } from '../../shared/ai-backends'
import type {
  ChatConversationBinding,
  ChatConversationDetail,
  ChatConversationSummary,
  ConversationEntry
} from '../../shared/chat'
import type {
  AgentInvocationDebugRecord,
  AgentInvocationRecord
} from '../../shared/agent-runtime'
import type { AgentDebugStore } from '../agent-runtime/agent-debug-store'
import { InMemoryAgentDebugStore } from '../agent-runtime/agent-debug-store'
import type { ChatConversationRepository, PersistedChatConversation } from './model'
import { chatMessageView } from './chat-message-view'
import { isPiCodingAgentRuntimeFeedback } from '../agent-runtime/pi-coding-agent-runtime'
import {
  parseAgentInvocationRecord,
  parseTerminalAgentInvocationRecord
} from '../agent-runtime/agent-invocation-record'

const CHAT_METADATA_KIND = 'oyster-chat'
const CHAT_BINDING_CUSTOM_ENTRY = 'oyster-chat-binding-v1'
const CHAT_INVOCATION_CUSTOM_ENTRY = 'oyster-agent-invocation-v4'
const LEGACY_CHAT_INVOCATION_CUSTOM_ENTRY = 'oyster-agent-invocation-v3'
const CHAT_DESCRIPTOR_FORMAT_VERSION = 2
const CHAT_DESCRIPTOR_SUFFIX = '.conversation.json'
const MAX_CHAT_TITLE_LENGTH = 512

interface LegacyChatHeader extends SessionHeader {
  metadata?: {
    kind?: string
    binding?: unknown
  }
}

interface ChatConversationDescriptor {
  formatVersion: typeof CHAT_DESCRIPTOR_FORMAT_VERSION
  conversationId: string
  createdAt: string
  binding: ChatConversationBinding
  title?: string
  /** Relative to the Chat repository root. The file can be absent before the first assistant message. */
  piSessionFile?: string
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

function normalizeBinding(value: unknown): ChatConversationBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Chat Conversation 的模型绑定无效')
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
    throw new Error('Chat Conversation 的思考强度无效')
  }
  return {
    connectionId: requiredString(record.connectionId, 'Connection ID', 512),
    modelId: requiredString(record.modelId, 'Model ID', 512),
    systemPrompt: requiredString(record.systemPrompt, 'System Prompt'),
    ...(reasoningEffort ? { reasoningEffort: reasoningEffort as ReasoningEffort } : {})
  }
}

function descriptorPath(rootPath: string, conversationId: string): string {
  return join(rootPath, `${encodeURIComponent(conversationId)}${CHAT_DESCRIPTOR_SUFFIX}`)
}

function parseDescriptor(value: unknown): ChatConversationDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Chat Conversation 描述文件无效')
  }
  const record = value as Record<string, unknown>
  if (record.formatVersion !== CHAT_DESCRIPTOR_FORMAT_VERSION && record.formatVersion !== 1) {
    throw new Error(`Chat Conversation 描述文件版本无效：${String(record.formatVersion)}`)
  }
  const piSessionFile = record.piSessionFile
  if (piSessionFile !== undefined && (
    typeof piSessionFile !== 'string'
    || !piSessionFile
    || isAbsolute(piSessionFile)
    || piSessionFile.split(/[\\/]/).includes('..')
  )) {
    throw new Error('Chat Conversation 的 Pi Session 文件位置无效')
  }
  const title = record.title === undefined
    ? undefined
    : requiredString(record.title, '对话标题', MAX_CHAT_TITLE_LENGTH)
  return {
    formatVersion: CHAT_DESCRIPTOR_FORMAT_VERSION,
    conversationId: requiredString(record.conversationId ?? record.id, 'Conversation ID', 512),
    createdAt: requiredString(record.createdAt, '创建时间', 128),
    binding: normalizeBinding(record.binding),
    ...(title ? { title } : {}),
    ...(piSessionFile ? { piSessionFile } : {})
  }
}

function messageEntries(entries: readonly SessionEntry[]): ConversationEntry[] {
  return entries.flatMap((entry) => entry.type === 'message'
    && entry.message.role !== ('runtimeFeedback' as typeof entry.message.role)
    && !isPiCodingAgentRuntimeFeedback(entry.message)
    ? [{ id: entry.id, createdAt: entry.timestamp, message: chatMessageView(entry.message) }]
    : [])
}

function invocationEntries(entries: readonly SessionEntry[]): AgentInvocationRecord[] {
  return entries.flatMap((entry) => {
    if (entry.type !== 'custom' || ![
      CHAT_INVOCATION_CUSTOM_ENTRY,
      LEGACY_CHAT_INVOCATION_CUSTOM_ENTRY
    ].includes(entry.customType)) return []
    try {
      return [parseAgentInvocationRecord(entry.data)]
    } catch {
      return []
    }
  })
}

function bindingFromPiSession(manager: SessionManager): ChatConversationBinding | undefined {
  const custom = manager.getEntries().find((entry) => (
    entry.type === 'custom' && entry.customType === CHAT_BINDING_CUSTOM_ENTRY
  ))
  if (custom?.type === 'custom') return normalizeBinding(custom.data)
  const header = manager.getHeader() as LegacyChatHeader | null
  return header?.metadata?.kind === CHAT_METADATA_KIND
    ? normalizeBinding(header.metadata.binding)
    : undefined
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function jsonlFiles(rootPath: string): Promise<string[]> {
  if (!await pathExists(rootPath)) return []
  const entries = await readdir(rootPath, { recursive: true, withFileTypes: true })
  return entries.flatMap((entry) => entry.isFile() && entry.name.endsWith('.jsonl')
    ? [join(entry.parentPath, entry.name)]
    : [])
}

function descriptorForLegacy(
  rootPath: string,
  manager: SessionManager,
  binding: ChatConversationBinding
): ChatConversationDescriptor {
  const header = manager.getHeader()
  if (!header) throw new Error('Chat Conversation 的 Pi Session Header 无效')
  const title = manager.getSessionName()
  return {
    formatVersion: CHAT_DESCRIPTOR_FORMAT_VERSION,
    conversationId: header.id,
    createdAt: header.timestamp,
    binding,
    ...(title ? { title } : {}),
    ...(manager.getSessionFile() ? {
      piSessionFile: relative(rootPath, manager.getSessionFile()!)
    } : {})
  }
}

function sessionSummary(
  descriptor: ChatConversationDescriptor,
  manager: SessionManager,
  hasActiveInvocation: boolean
): ChatConversationSummary {
  const entries = manager.getEntries()
  const messages = messageEntries(entries)
  return {
    conversationId: descriptor.conversationId,
    ...(descriptor.title ?? manager.getSessionName()
      ? { title: descriptor.title ?? manager.getSessionName() }
      : {}),
    createdAt: descriptor.createdAt,
    updatedAt: entries.at(-1)?.timestamp ?? descriptor.createdAt,
    messageCount: messages.length,
    binding: {
      connectionId: descriptor.binding.connectionId,
      modelId: descriptor.binding.modelId,
      ...(descriptor.binding.reasoningEffort
        ? { reasoningEffort: descriptor.binding.reasoningEffort }
        : {})
    },
    hasActiveInvocation
  }
}

/**
 * Oyster-owned Chat Conversation adapter over Coding Agent's SessionManager.
 *
 * The sidecar owns immutable product binding and keeps empty conversations durable;
 * Pi's append-only JSONL remains the complete message, tool, and compaction transcript.
 */
export class PiChatConversationRepository implements ChatConversationRepository {
  private readonly openManagers = new Map<string, SessionManager>()

  constructor(
    readonly rootPath: string,
    private readonly debugStore: AgentDebugStore = new InMemoryAgentDebugStore()
  ) {}

  private async writeDescriptor(descriptor: ChatConversationDescriptor): Promise<void> {
    await mkdir(this.rootPath, { recursive: true })
    const target = descriptorPath(this.rootPath, descriptor.conversationId)
    const temporary = `${target}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(descriptor, null, 2)}\n`, 'utf8')
    await rename(temporary, target)
  }

  private async readDescriptor(conversationId: string): Promise<ChatConversationDescriptor | undefined> {
    const normalizedId = requiredString(conversationId, 'Conversation ID', 512)
    try {
      const raw = JSON.parse(
        await readFile(descriptorPath(this.rootPath, normalizedId), 'utf8')
      ) as Record<string, unknown>
      const descriptor = parseDescriptor(raw)
      if (descriptor.conversationId !== normalizedId) throw new Error('Conversation ID 与描述文件名不一致')
      if (
        raw.formatVersion !== CHAT_DESCRIPTOR_FORMAT_VERSION
        || raw.conversationId !== descriptor.conversationId
      ) await this.writeDescriptor(descriptor)
      return descriptor
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  private managerForDescriptor(descriptor: ChatConversationDescriptor): SessionManager {
    const cached = this.openManagers.get(descriptor.conversationId)
    if (cached) return cached
    const candidate = descriptor.piSessionFile
      ? resolve(this.rootPath, descriptor.piSessionFile)
      : undefined
    const manager = candidate && candidate.startsWith(`${resolve(this.rootPath)}/`)
      && requireExistingPath(candidate)
      ? SessionManager.open(candidate, this.rootPath, this.rootPath)
      : SessionManager.create(this.rootPath, this.rootPath, { id: descriptor.conversationId })
    if (!bindingFromPiSession(manager)) {
      manager.appendCustomEntry(CHAT_BINDING_CUSTOM_ENTRY, descriptor.binding)
      if (descriptor.title) manager.appendSessionInfo(descriptor.title)
    }
    this.openManagers.set(descriptor.conversationId, manager)
    return manager
  }

  private async legacyConversation(conversationId: string): Promise<PersistedChatConversation | undefined> {
    for (const file of await jsonlFiles(this.rootPath)) {
      let manager: SessionManager
      try {
        manager = SessionManager.open(file, dirname(file), this.rootPath)
      } catch {
        continue
      }
      if (manager.getSessionId() !== conversationId) continue
      const binding = bindingFromPiSession(manager)
      if (!binding) return undefined
      this.openManagers.set(conversationId, manager)
      return { conversationId, piSessionManager: manager, binding }
    }
    return undefined
  }

  async create(binding: ChatConversationBinding, title?: string): Promise<PersistedChatConversation> {
    const normalizedBinding = normalizeBinding(binding)
    const normalizedTitle = title === undefined
      ? undefined
      : requiredString(title, '对话标题', MAX_CHAT_TITLE_LENGTH)
    const id = randomUUID()
    const manager = SessionManager.create(this.rootPath, this.rootPath, { id })
    manager.appendCustomEntry(CHAT_BINDING_CUSTOM_ENTRY, normalizedBinding)
    if (normalizedTitle) manager.appendSessionInfo(normalizedTitle)
    const descriptor: ChatConversationDescriptor = {
      formatVersion: CHAT_DESCRIPTOR_FORMAT_VERSION,
      conversationId: id,
      createdAt: new Date().toISOString(),
      binding: normalizedBinding,
      ...(normalizedTitle ? { title: normalizedTitle } : {}),
      ...(manager.getSessionFile() ? {
        piSessionFile: relative(this.rootPath, manager.getSessionFile()!)
      } : {})
    }
    await this.writeDescriptor(descriptor)
    this.openManagers.set(id, manager)
    return { conversationId: id, piSessionManager: manager, binding: normalizedBinding }
  }

  async open(conversationId: string): Promise<PersistedChatConversation> {
    const normalizedId = requiredString(conversationId, 'Conversation ID', 512)
    const descriptor = await this.readDescriptor(normalizedId)
    if (descriptor) {
      return {
        conversationId: descriptor.conversationId,
        piSessionManager: this.managerForDescriptor(descriptor),
        binding: descriptor.binding
      }
    }
    const legacy = await this.legacyConversation(normalizedId)
    if (!legacy) throw new Error('Chat Conversation 不存在')
    return legacy
  }

  private async descriptors(): Promise<ChatConversationDescriptor[]> {
    if (!await pathExists(this.rootPath)) return []
    const files = (await readdir(this.rootPath, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(CHAT_DESCRIPTOR_SUFFIX))
    const descriptors: ChatConversationDescriptor[] = []
    for (const file of files) {
      const raw = JSON.parse(
        await readFile(join(this.rootPath, file.name), 'utf8')
      ) as Record<string, unknown>
      const descriptor = parseDescriptor(raw)
      descriptors.push(descriptor)
      if (
        raw.formatVersion !== CHAT_DESCRIPTOR_FORMAT_VERSION
        || raw.conversationId !== descriptor.conversationId
      ) await this.writeDescriptor(descriptor)
    }
    return descriptors
  }

  async list(): Promise<ChatConversationSummary[]> {
    const descriptors = await this.descriptors()
    const byId = new Map(descriptors.map((descriptor) => [descriptor.conversationId, descriptor]))
    for (const file of await jsonlFiles(this.rootPath)) {
      let manager: SessionManager
      try {
        manager = SessionManager.open(file, dirname(file), this.rootPath)
      } catch {
        continue
      }
      if (byId.has(manager.getSessionId())) continue
      const binding = bindingFromPiSession(manager)
      if (!binding) continue
      const descriptor = descriptorForLegacy(this.rootPath, manager, binding)
      byId.set(descriptor.conversationId, descriptor)
      this.openManagers.set(descriptor.conversationId, manager)
    }
    return [...byId.values()].map((descriptor) => sessionSummary(
      descriptor,
      this.managerForDescriptor(descriptor),
      false
    )).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  async detail(
    conversationId: string,
    hasActiveInvocation = false
  ): Promise<ChatConversationDetail> {
    const opened = await this.open(conversationId)
    const descriptor = await this.readDescriptor(opened.conversationId)
      ?? descriptorForLegacy(this.rootPath, opened.piSessionManager, opened.binding)
    const entries = opened.piSessionManager.getEntries()
    const invocations = invocationEntries(entries)
    return {
      ...sessionSummary(descriptor, opened.piSessionManager, hasActiveInvocation),
      messages: messageEntries(entries),
      invocations: invocations.flatMap((invocation) => {
        const debug = this.debugStore.read(invocation.debugRecordId)
        return debug ? [debug] : []
      })
    }
  }

  async setTitle(conversationId: string, title: string): Promise<void> {
    const normalizedTitle = requiredString(title, '对话标题', MAX_CHAT_TITLE_LENGTH)
    const opened = await this.open(conversationId)
    if (opened.piSessionManager.getSessionName() !== normalizedTitle) {
      opened.piSessionManager.appendSessionInfo(normalizedTitle)
    }
    const descriptor = await this.readDescriptor(opened.conversationId)
      ?? descriptorForLegacy(this.rootPath, opened.piSessionManager, opened.binding)
    await this.writeDescriptor({ ...descriptor, title: normalizedTitle })
  }

  async appendInvocation(
    conversationId: string,
    debugRecord: AgentInvocationDebugRecord
  ): Promise<void> {
    this.debugStore.save(debugRecord)
    const opened = await this.open(conversationId)
    opened.piSessionManager.appendCustomEntry(
      CHAT_INVOCATION_CUSTOM_ENTRY,
      parseTerminalAgentInvocationRecord(debugRecord)
    )
    const descriptor = await this.readDescriptor(opened.conversationId)
      ?? descriptorForLegacy(this.rootPath, opened.piSessionManager, opened.binding)
    const sessionFile = opened.piSessionManager.getSessionFile()
    await this.writeDescriptor({
      ...descriptor,
      ...(sessionFile ? { piSessionFile: relative(this.rootPath, sessionFile) } : {})
    })
  }

  async dispose(): Promise<void> {
    this.openManagers.clear()
  }
}

function requireExistingPath(path: string): boolean {
  return existsSync(path)
}

export async function appendChatAgentInvocation(
  piSessionManager: SessionManager,
  invocation: AgentInvocationRecord
): Promise<void> {
  piSessionManager.appendCustomEntry(
    CHAT_INVOCATION_CUSTOM_ENTRY,
    parseTerminalAgentInvocationRecord(invocation)
  )
}

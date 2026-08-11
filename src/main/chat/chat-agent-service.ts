import type {
  CancelChatInvocationInput,
  ChatApi,
  ChatEvent,
  ChatConversationDetail,
  ChatConversationModelBinding,
  ChatStateView,
  CreateChatConversationInput,
  DeleteChatConversationInput,
  SaveChatDefaultInstructionsInput,
  SendChatMessageInput
} from '../../shared/chat'
import { CHAT_AGENT_ID } from '../../shared/chat'
import { REASONING_EFFORTS } from '../../shared/ai-backends'
import type {
  ChatAgentRuntime,
  ChatAiBackendPort,
  ChatConfigurationRepository,
  ChatConfigurationStateData,
  ChatConversationRepository
} from './model'
import { chatAgentToolViews } from './chat-tool-catalog'
import { DEFAULT_CHAT_AGENT_SYSTEM_PROMPT } from './prompt'
import { PiChatAgent } from './pi-chat-agent'
import { createPiAgentInvocationRecorder } from '../agent-runtime/pi-agent-invocation-recorder'
import type { AgentInvocationDebugRecord } from '../../shared/agent-runtime'
import {
  InMemoryAgentDebugStore,
  type AgentDebugStore
} from '../agent-runtime/agent-debug-store'

const MAX_CONVERSATION_TITLE_LENGTH = 512

export interface ChatAgentServiceOptions {
  conversations: ChatConversationRepository
  configuration: ChatConfigurationRepository
  aiBackend: ChatAiBackendPort
  repositoryPath: string
  agent?: ChatAgentRuntime
  debugStore?: AgentDebugStore
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

function safeError(value: unknown, fallback: string): Error {
  if (value instanceof Error) return value
  if (typeof value === 'string' && value) return new Error(value)
  return new Error(fallback)
}

function automaticTitle(text: string): string {
  const firstLine = text.replace(/[\r\n]+/g, ' ').trim()
  return firstLine.length <= 80 ? firstLine : `${firstLine.slice(0, 79)}…`
}

export class ChatAgentService implements ChatApi {
  private readonly agent: ChatAgentRuntime
  private readonly debugStore: AgentDebugStore
  private readonly listeners = new Set<(event: ChatEvent) => void>()
  private readonly activeInvocations = new Map<string, {
    invocationId: string
    controller: AbortController
  }>()
  private state: ChatConfigurationStateData = {}
  private configurationError?: string
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(private readonly options: ChatAgentServiceOptions) {
    this.debugStore = options.debugStore ?? new InMemoryAgentDebugStore()
    this.agent = options.agent ?? new PiChatAgent(
      options.repositoryPath,
      undefined,
      this.debugStore
    )
  }

  async initialize(): Promise<void> {
    try {
      this.state = await this.options.configuration.load()
      this.configurationError = undefined
    } catch (error) {
      this.state = {}
      this.configurationError = `对话 Agent 配置无法读取：${safeError(error, '未知错误').message}`
    }
  }

  private defaultInstructions(): string {
    return this.state.defaultInstructionsOverride ?? DEFAULT_CHAT_AGENT_SYSTEM_PROMPT
  }

  private emit(event: ChatEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(structuredClone(event))
      } catch {
        // Renderer diagnostics must not change Agent behavior.
      }
    }
  }

  private async emitState(): Promise<ChatStateView> {
    const state = await this.getState()
    this.emit({ type: 'state_changed', state })
    return state
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation)
    this.mutationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  private assertConfigurationWritable(): void {
    if (this.configurationError) {
      throw new Error('对话 Agent 配置当前不可修改；请先修复配置文件并重新启动 Oyster')
    }
  }

  private validateModelBinding(binding: ChatConversationModelBinding): ChatConversationModelBinding {
    if (!binding || typeof binding !== 'object') throw new Error('对话模型绑定无效')
    const connectionId = requiredString(binding.connectionId, 'Connection ID', 512)
    const modelId = requiredString(binding.modelId, 'Model ID', 512)
    if (
      binding.reasoningEffort !== undefined
      && !REASONING_EFFORTS.includes(binding.reasoningEffort)
    ) {
      throw new Error('思考强度无效')
    }
    const connection = this.options.aiBackend.snapshot().connections.find((item) => item.id === connectionId)
    if (!connection) throw new Error('所选 AI Connection 不存在')
    const model = connection.models.find((item) => item.id === modelId)
    if (!model) throw new Error('所选模型不可用')
    if (binding.reasoningEffort && !model.reasoningEfforts.includes(binding.reasoningEffort)) {
      throw new Error('所选模型不支持该思考强度')
    }
    return {
      connectionId,
      modelId,
      ...(binding.reasoningEffort ? { reasoningEffort: binding.reasoningEffort } : {})
    }
  }

  async getState(): Promise<ChatStateView> {
    const conversations = (await this.options.conversations.list()).map((conversation) => ({
      ...conversation,
      hasActiveInvocation: this.activeInvocations.has(conversation.id)
    }))
    return structuredClone({
      agent: {
        id: CHAT_AGENT_ID,
        displayName: '通用 Agent',
        description: '理解和维护 Oyster 的 Knowledge 与 Artifact。',
        runtime: 'pi_coding_agent' as const,
        tools: chatAgentToolViews(this.options.repositoryPath).map((tool) => (
          structuredClone(tool)
        )),
        builtInInstructions: DEFAULT_CHAT_AGENT_SYSTEM_PROMPT,
        defaultInstructions: this.defaultInstructions(),
        isDefaultCustomized: Boolean(this.state.defaultInstructionsOverride)
      },
      conversations,
      ...(this.configurationError ? { configurationError: this.configurationError } : {})
    })
  }

  async createConversation(input: CreateChatConversationInput): Promise<ChatConversationDetail> {
    if (!input || typeof input !== 'object') throw new Error('新建对话参数无效')
    const defaultLlm = this.options.aiBackend.snapshot().defaultLlm
    if (!defaultLlm) throw new Error('请先在 AI 后端页面配置默认 LLM')
    const binding = this.validateModelBinding(defaultLlm)
    const title = input.title === undefined
      ? undefined
      : requiredString(input.title, '对话标题', MAX_CONVERSATION_TITLE_LENGTH)
    const opened = await this.options.conversations.create({
      ...binding,
      systemPrompt: this.defaultInstructions()
    }, title)
    const detail = await this.options.conversations.detail(opened.id)
    await this.emitState()
    return detail
  }

  async readConversation(conversationId: string): Promise<ChatConversationDetail> {
    const normalizedId = requiredString(conversationId, 'Conversation ID', 512)
    return this.options.conversations.detail(
      normalizedId,
      this.activeInvocations.has(normalizedId)
    )
  }

  async deleteConversation(input: DeleteChatConversationInput): Promise<ChatStateView> {
    if (!input || typeof input !== 'object') throw new Error('删除对话参数无效')
    const conversationId = requiredString(input.conversationId, 'Conversation ID', 512)
    if (this.activeInvocations.has(conversationId)) {
      throw new Error('存在进行中的 Agent Invocation；请先取消再删除对话')
    }
    await this.options.conversations.delete(conversationId)
    return this.emitState()
  }

  async sendMessage(input: SendChatMessageInput): Promise<ChatConversationDetail> {
    if (!input || typeof input !== 'object') throw new Error('发送消息参数无效')
    const conversationId = requiredString(input.conversationId, 'Conversation ID', 512)
    const text = requiredString(input.text, '消息')
    if (this.activeInvocations.has(conversationId)) {
      throw new Error('该对话已有进行中的 Agent Invocation')
    }
    const rootInvocationId = randomUUID()
    const controller = new AbortController()
    // Reserve synchronously so two messages cannot enter the same Chat Conversation concurrently.
    this.activeInvocations.set(conversationId, { invocationId: rootInvocationId, controller })
    const observedInvocations = new Map<string, AgentInvocationDebugRecord>()
    const observeInvocation = (record: AgentInvocationDebugRecord): void => {
      observedInvocations.set(record.id, structuredClone(record))
      this.emit({
        type: 'invocation_updated',
        conversationId,
        invocation: structuredClone(record)
      })
    }
    const placeholder = createPiAgentInvocationRecorder({
      agentId: CHAT_AGENT_ID,
      invocationId: rootInvocationId,
      debugStore: this.debugStore,
      onUpdate: observeInvocation
    })
    this.emit({
      type: 'invocation_state_changed',
      conversationId,
      invocationId: rootInvocationId,
      status: 'in_progress'
    })
    let status: 'completed' | 'failed' | 'cancelled' = 'completed'
    let failure: Error | undefined
    let opened: Awaited<ReturnType<ChatConversationRepository['open']>> | undefined
    try {
      const openedConversation = await this.options.conversations.open(conversationId)
      opened = openedConversation
      controller.signal.throwIfAborted()
      if (!openedConversation.piSessionManager.getSessionName()) {
        await this.options.conversations.setTitle(conversationId, automaticTitle(text))
      }
      controller.signal.throwIfAborted()
      await this.options.aiBackend.withModelStream(
        openedConversation.binding.connectionId,
        openedConversation.binding.modelId,
        (modelStream) => this.agent.invoke({
          conversationId,
          rootInvocationId,
          piSessionManager: openedConversation.piSessionManager,
          binding: openedConversation.binding,
          modelStream,
          text,
          signal: controller.signal,
          onInvocationUpdate: observeInvocation,
          onEvent: (event) => this.emit(event)
        }),
        { trackHealth: true }
      )
    } catch (error) {
      failure = safeError(error, 'Chat Agent Invocation 失败')
      status = controller.signal.aborted ? 'cancelled' : 'failed'
    } finally {
      this.activeInvocations.delete(conversationId)
    }

    const rootInvocation = observedInvocations.get(rootInvocationId)
    if (!rootInvocation || rootInvocation.status === 'in_progress') {
      placeholder.complete(status, failure)
    }
    if (opened) {
      for (const invocation of observedInvocations.values()) {
        if (invocation.status !== 'in_progress') {
          await this.options.conversations.appendInvocation(
            conversationId,
            invocation
          )
        }
      }
    }
    this.emit({
      type: 'invocation_state_changed',
      conversationId,
      invocationId: rootInvocationId,
      status,
      ...(failure ? { error: failure.message } : {})
    })
    await this.emitState()
    if (failure) throw failure
    return this.options.conversations.detail(conversationId)
  }

  async cancelInvocation(input: CancelChatInvocationInput): Promise<void> {
    if (!input || typeof input !== 'object') throw new Error('取消对话参数无效')
    const conversationId = requiredString(input.conversationId, 'Conversation ID', 512)
    this.activeInvocations.get(conversationId)?.controller.abort(
      new Error('用户取消了对话 Agent Invocation')
    )
  }

  async saveDefaultInstructions(input: SaveChatDefaultInstructionsInput): Promise<ChatStateView> {
    if (!input || typeof input !== 'object') throw new Error('System Prompt 配置无效')
    return this.enqueueMutation(async () => {
      this.assertConfigurationWritable()
      const override = input.instructionsOverride === null
        ? undefined
        : requiredString(input.instructionsOverride, 'System Prompt')
      const nextState: ChatConfigurationStateData = override && override !== DEFAULT_CHAT_AGENT_SYSTEM_PROMPT
        ? { defaultInstructionsOverride: override }
        : {}
      await this.options.configuration.save(nextState)
      this.state = nextState
      return this.emitState()
    })
  }

  subscribe(listener: (event: ChatEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    for (const active of this.activeInvocations.values()) {
      active.controller.abort(new Error('Oyster 正在退出'))
    }
    this.listeners.clear()
  }
}
import { randomUUID } from 'node:crypto'

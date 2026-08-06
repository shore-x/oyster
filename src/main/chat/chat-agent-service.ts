import type {
  CancelChatRunInput,
  ChatApi,
  ChatEvent,
  ChatSessionDetail,
  ChatSessionModelBinding,
  ChatSnapshot,
  CreateChatSessionInput,
  DeleteChatSessionInput,
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
  ChatSessionRepository
} from './model'
import { chatAgentToolViews } from './chat-tool-catalog'
import { DEFAULT_CHAT_AGENT_SYSTEM_PROMPT } from './prompt'
import { PiChatAgent } from './pi-chat-agent'

const MAX_SESSION_TITLE_LENGTH = 512

export interface ChatAgentServiceOptions {
  sessions: ChatSessionRepository
  configuration: ChatConfigurationRepository
  aiBackend: ChatAiBackendPort
  repositoryPath: string
  agent?: ChatAgentRuntime
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
  private readonly listeners = new Set<(event: ChatEvent) => void>()
  private readonly activeRuns = new Map<string, AbortController>()
  private state: ChatConfigurationStateData = {}
  private configurationError?: string
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(private readonly options: ChatAgentServiceOptions) {
    this.agent = options.agent ?? new PiChatAgent(options.repositoryPath)
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

  private async emitSnapshot(): Promise<ChatSnapshot> {
    const snapshot = await this.getSnapshot()
    this.emit({ type: 'snapshot_changed', snapshot })
    return snapshot
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

  private validateModelBinding(binding: ChatSessionModelBinding): ChatSessionModelBinding {
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

  async getSnapshot(): Promise<ChatSnapshot> {
    const sessions = (await this.options.sessions.list()).map((session) => ({
      ...session,
      isRunning: this.activeRuns.has(session.id)
    }))
    return structuredClone({
      agent: {
        id: CHAT_AGENT_ID,
        displayName: '通用 Agent',
        description: '理解和维护 Oyster 的 Knowledge 与 Artifact。',
        runtime: 'pi_agent_core' as const,
        tools: chatAgentToolViews(this.options.repositoryPath).map((tool) => (
          structuredClone(tool)
        )),
        builtInInstructions: DEFAULT_CHAT_AGENT_SYSTEM_PROMPT,
        defaultInstructions: this.defaultInstructions(),
        isDefaultCustomized: Boolean(this.state.defaultInstructionsOverride)
      },
      sessions,
      ...(this.configurationError ? { configurationError: this.configurationError } : {})
    })
  }

  async createSession(input: CreateChatSessionInput): Promise<ChatSessionDetail> {
    if (!input || typeof input !== 'object') throw new Error('新建对话参数无效')
    const defaultLlm = this.options.aiBackend.snapshot().defaultLlm
    if (!defaultLlm) throw new Error('请先在 AI 后端页面配置默认 LLM')
    const binding = this.validateModelBinding(defaultLlm)
    const title = input.title === undefined
      ? undefined
      : requiredString(input.title, '对话标题', MAX_SESSION_TITLE_LENGTH)
    const opened = await this.options.sessions.create({
      ...binding,
      systemPrompt: this.defaultInstructions()
    }, title)
    const metadata = await opened.session.getMetadata()
    const detail = await this.options.sessions.detail(metadata.id)
    await this.emitSnapshot()
    return detail
  }

  async readSession(sessionId: string): Promise<ChatSessionDetail> {
    const normalizedId = requiredString(sessionId, 'Session ID', 512)
    return this.options.sessions.detail(normalizedId, this.activeRuns.has(normalizedId))
  }

  async deleteSession(input: DeleteChatSessionInput): Promise<ChatSnapshot> {
    if (!input || typeof input !== 'object') throw new Error('删除对话参数无效')
    const sessionId = requiredString(input.sessionId, 'Session ID', 512)
    if (this.activeRuns.has(sessionId)) throw new Error('运行中的对话不能删除；请先取消当前运行')
    await this.options.sessions.delete(sessionId)
    return this.emitSnapshot()
  }

  async sendMessage(input: SendChatMessageInput): Promise<ChatSessionDetail> {
    if (!input || typeof input !== 'object') throw new Error('发送消息参数无效')
    const sessionId = requiredString(input.sessionId, 'Session ID', 512)
    const text = requiredString(input.text, '消息')
    if (this.activeRuns.has(sessionId)) throw new Error('该对话正在运行')
    const controller = new AbortController()
    // Reserve synchronously, before the first repository await, so two sends cannot enter
    // the same Pi Session concurrently.
    this.activeRuns.set(sessionId, controller)
    let runAnnounced = false
    let status: 'completed' | 'failed' | 'cancelled' = 'completed'
    let failure: Error | undefined
    try {
      const opened = await this.options.sessions.open(sessionId)
      controller.signal.throwIfAborted()
      if (!await opened.session.getSessionName()) {
        await opened.session.appendSessionName(automaticTitle(text))
      }
      controller.signal.throwIfAborted()
      this.emit({ type: 'run_state_changed', sessionId, status: 'running' })
      runAnnounced = true
      await this.options.aiBackend.withModelRuntime(
        opened.binding.connectionId,
        opened.binding.modelId,
        (runtime) => this.agent.run({
          sessionId,
          session: opened.session,
          binding: opened.binding,
          runtime,
          text,
          signal: controller.signal,
          onEvent: (event) => this.emit(event)
        }),
        { trackHealth: true }
      )
    } catch (error) {
      failure = safeError(error, '对话 Agent 运行失败')
      status = controller.signal.aborted ? 'cancelled' : 'failed'
    } finally {
      this.activeRuns.delete(sessionId)
    }

    if (runAnnounced) {
      this.emit({
        type: 'run_state_changed',
        sessionId,
        status,
        ...(failure ? { error: failure.message } : {})
      })
    }
    await this.emitSnapshot()
    if (failure) throw failure
    return this.options.sessions.detail(sessionId)
  }

  async cancelRun(input: CancelChatRunInput): Promise<void> {
    if (!input || typeof input !== 'object') throw new Error('取消对话参数无效')
    const sessionId = requiredString(input.sessionId, 'Session ID', 512)
    this.activeRuns.get(sessionId)?.abort(new Error('用户取消了对话 Agent 运行'))
  }

  async saveDefaultInstructions(input: SaveChatDefaultInstructionsInput): Promise<ChatSnapshot> {
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
      return this.emitSnapshot()
    })
  }

  subscribe(listener: (event: ChatEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    for (const controller of this.activeRuns.values()) {
      controller.abort(new Error('Oyster 正在退出'))
    }
    this.listeners.clear()
  }
}

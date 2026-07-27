import { randomUUID } from 'node:crypto'
import type {
  AiBackendOption,
  AiBackendSnapshot,
  AiConnection,
  AvailableModel,
  CodingPlanAuthentication,
  CodingPlanLoginMethod,
  ConnectAiBackendInput,
  ConnectionTestResult,
  DiscoverModelsInput,
  ModelDiscoveryResult,
  SaveModelConnectionInput,
  TestConnectionInput
} from '../../shared/ai-backends'
import {
  CODING_PLAN_LOGIN_METHODS,
  MODEL_PROTOCOLS,
  MODEL_PROVIDER_IDS
} from '../../shared/ai-backends'
import { createOysterModelRuntime } from '../knowledge-processing/oyster-model-stream'
import { CODEX_CONNECTION_ID } from './codex-adapter'
import type { ModelRuntime, ModelGenerationRequest, ModelGenerationResult } from './model'
import { ModelConnectionFailureError, ModelContextOverflowError } from './model'
import type {
  AgentBackendAdapter,
  AiBackendRepository,
  AiBackendStateData,
  CredentialStore,
  ModelBackendAdapter,
  StoredModelConnection
} from './model'
import { reasoningEffortsForModel } from './model-capabilities'
import { normalizeModelBaseUrl } from './openai-compatible-adapter'

const OPTIONS: AiBackendOption[] = [
  {
    adapterId: 'codex',
    backendKind: 'coding_plan',
    providerId: 'openai_codex',
    displayName: 'OpenAI Codex Coding Plan',
    description: '通过 Oyster OAuth 使用已有的 ChatGPT/Codex Coding Plan'
  },
  {
    adapterId: 'openai-compatible',
    backendKind: 'api',
    providerId: 'openai',
    displayName: 'OpenAI API',
    description: '使用 OpenAI API Key'
  },
  {
    adapterId: 'openai-compatible',
    backendKind: 'api',
    providerId: 'openai_compatible',
    displayName: 'OpenAI-compatible API',
    description: '使用自定义模型端点'
  }
]

interface ConnectionRuntimeState {
  status: AiConnection['status']
  errorMessage?: string
  lastCheckedAt?: string
}

type ApiRuntimeFactory = (
  connection: StoredModelConnection,
  apiKey?: string
) => ModelRuntime

export interface CodingPlanBackend {
  listModels(): AvailableModel[]
  inspectAuth(): Promise<{
    status: 'needs_auth' | 'ready' | 'unsupported' | 'unavailable'
    errorMessage?: string
  }>
  connect(
    loginMethod: CodingPlanLoginMethod,
    onAuthenticationUpdate?: (authentication: CodingPlanAuthentication) => void
  ): Promise<void>
  cancelConnect(): void
  generate(modelId: string, request: ModelGenerationRequest): Promise<ModelGenerationResult>
  runtime(modelId: string): ModelRuntime
  dispose(): void
}

function preferredModel(models: AvailableModel[]): string | undefined {
  return models.find((model) => /(?:mini|small)/i.test(model.id))?.id ?? models[0]?.id
}

function initialCodingPlanConnection(): AiConnection {
  return {
    id: CODEX_CONNECTION_ID,
    adapterId: 'codex',
    backendKind: 'coding_plan',
    providerId: 'openai_codex',
    displayName: 'OpenAI Codex Coding Plan',
    credentialMode: 'oyster_keychain',
    status: 'unverified',
    models: []
  }
}

function assertModelInput(input: unknown): asserts input is SaveModelConnectionInput {
  if (!input || typeof input !== 'object') throw new Error('API Connection 配置无效')
  const value = input as Record<string, unknown>
  if (
    typeof value.providerId !== 'string'
    || !MODEL_PROVIDER_IDS.includes(value.providerId as SaveModelConnectionInput['providerId'])
  ) {
    throw new Error('不支持的 Model Provider')
  }
  if (
    typeof value.protocol !== 'string'
    || !MODEL_PROTOCOLS.includes(value.protocol as SaveModelConnectionInput['protocol'])
  ) {
    throw new Error('不支持的模型协议')
  }
  if (typeof value.baseUrl !== 'string' || value.baseUrl.length > 2_048) {
    throw new Error('Base URL 无效')
  }
  if (typeof value.model !== 'string' || !value.model.trim() || value.model.trim().length > 200) {
    throw new Error('Model 名称无效')
  }
  if (value.apiKey !== undefined && typeof value.apiKey !== 'string') {
    throw new Error('API Key 格式无效')
  }
  if (typeof value.apiKey === 'string' && value.apiKey.length > 16_384) {
    throw new Error('API Key 过长')
  }
  const typed = input as SaveModelConnectionInput
  if (typed.providerId === 'openai' && !typed.apiKey?.trim()) {
    throw new Error('OpenAI API 需要 API Key')
  }
}

function assertDiscoveryInput(input: unknown): asserts input is DiscoverModelsInput {
  if (!input || typeof input !== 'object') throw new Error('模型发现配置无效')
  const value = input as Record<string, unknown>
  if (
    typeof value.providerId !== 'string'
    || !MODEL_PROVIDER_IDS.includes(value.providerId as DiscoverModelsInput['providerId'])
  ) {
    throw new Error('不支持的 Model Provider')
  }
  if (typeof value.baseUrl !== 'string' || value.baseUrl.length > 2_048) {
    throw new Error('Base URL 无效')
  }
  if (value.apiKey !== undefined && typeof value.apiKey !== 'string') {
    throw new Error('API Key 格式无效')
  }
  if (typeof value.apiKey === 'string' && value.apiKey.length > 16_384) {
    throw new Error('API Key 过长')
  }
  const typed = input as DiscoverModelsInput
  if (typed.providerId === 'openai' && !typed.apiKey?.trim()) {
    throw new Error('获取 OpenAI 模型列表需要 API Key')
  }
}

function assertTestInput(input: unknown): asserts input is TestConnectionInput {
  if (!input || typeof input !== 'object') throw new Error('连接测试配置无效')
  const value = input as Record<string, unknown>
  if (typeof value.connectionId !== 'string' || !value.connectionId.trim()) {
    throw new Error('Connection 配置无效')
  }
  if (typeof value.modelId !== 'string' || !value.modelId.trim() || value.modelId.length > 200) {
    throw new Error('Model 配置无效')
  }
}

function assertConnectInput(input: unknown): asserts input is ConnectAiBackendInput {
  if (!input || typeof input !== 'object') throw new Error('Coding Plan 登录配置无效')
  const value = input as Record<string, unknown>
  if (typeof value.connectionId !== 'string' || !value.connectionId.trim()) {
    throw new Error('Connection 配置无效')
  }
  if (
    typeof value.loginMethod !== 'string'
    || !CODING_PLAN_LOGIN_METHODS.includes(value.loginMethod as CodingPlanLoginMethod)
  ) {
    throw new Error('Coding Plan 登录方式无效')
  }
}

function modelDisplayName(connection: StoredModelConnection): string {
  if (connection.providerId === 'openai') return 'OpenAI API'
  return new URL(connection.baseUrl).host
}

function defaultApiModels(connection: StoredModelConnection): AvailableModel[] {
  return [{
    id: connection.model,
    displayName: connection.model,
    reasoningEfforts: reasoningEffortsForModel(connection.providerId, connection.model)
  }]
}

function runtimeWithModelMetadata(runtime: ModelRuntime, model: AvailableModel): ModelRuntime {
  const contextWindow = model.contextWindowTokens ?? runtime.model.contextWindow
  const maxTokens = model.maxOutputTokens
    ? Math.min(runtime.model.maxTokens, model.maxOutputTokens)
    : runtime.model.maxTokens
  if (contextWindow === runtime.model.contextWindow && maxTokens === runtime.model.maxTokens) {
    return runtime
  }
  return {
    ...runtime,
    model: {
      ...runtime.model,
      contextWindow,
      maxTokens
    }
  }
}

function modelDiscoveryKey(providerId: StoredModelConnection['providerId'], baseUrl: string): string {
  return `${providerId}\0${baseUrl}`
}

export class AiBackendService {
  private state: AiBackendStateData = { connections: [] }
  private codingPlanConnection = initialCodingPlanConnection()
  private codingPlanAuthenticationActive = false
  private readonly connectionStates = new Map<string, ConnectionRuntimeState>()
  private readonly apiModels = new Map<string, AvailableModel[]>()
  private readonly discoveredModelCache = new Map<string, AvailableModel[]>()
  private readonly listeners = new Set<(snapshot: AiBackendSnapshot) => void>()
  private readonly unsubscribeDiscovery: () => void
  private configurationError?: string
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly repository: AiBackendRepository,
    private readonly credentialStore: CredentialStore,
    /** Used only to discover a locally installed Codex account; its token is never read. */
    private readonly codexDiscovery: AgentBackendAdapter,
    private readonly modelAdapter: ModelBackendAdapter,
    private readonly codingPlanAdapter: CodingPlanBackend,
    private readonly apiRuntimeFactory: ApiRuntimeFactory = createOysterModelRuntime
  ) {
    this.unsubscribeDiscovery = codexDiscovery.subscribe(() => void this.refreshCodingPlan())
  }

  async initialize(): Promise<void> {
    try {
      const stored = await this.repository.load()
      this.state = {
        connections: stored.connections.map((connection, index) => {
          const baseUrl = connection.providerId === 'openai'
            ? 'https://api.openai.com/v1'
            : normalizeModelBaseUrl(connection.baseUrl)
          if (!connection.model.trim() || connection.model.length > 200) {
            throw new Error(`第 ${index + 1} 条 AI Connection 的 Model 名称无效`)
          }
          return { ...connection, baseUrl }
        })
      }
      this.configurationError = undefined
    } catch (error) {
      this.state = { connections: [] }
      this.configurationError = `AI Connection 配置无法读取：${error instanceof Error ? error.message : String(error)}`
    }

    for (const connection of this.state.connections) {
      this.connectionStates.set(connection.id, { status: 'unverified' })
      this.apiModels.set(connection.id, defaultApiModels(connection))
    }
    this.codingPlanConnection = {
      ...this.codingPlanConnection,
      models: this.codingPlanAdapter.listModels()
    }
  }

  snapshot(): AiBackendSnapshot {
    const apiConnections: AiConnection[] = this.state.connections.map((connection) => {
      const runtime = this.connectionStates.get(connection.id) ?? { status: 'unverified' as const }
      const models = this.apiModels.get(connection.id) ?? defaultApiModels(connection)
      return {
        id: connection.id,
        adapterId: connection.adapterId,
        backendKind: 'api',
        providerId: connection.providerId,
        displayName: modelDisplayName(connection),
        credentialMode: 'oyster_keychain',
        status: runtime.status,
        models: models.map((model) => ({
          ...model,
          reasoningEfforts: [...model.reasoningEfforts]
        })),
        defaultModelId: connection.model,
        modelConfig: {
          providerId: connection.providerId,
          protocol: connection.protocol,
          baseUrl: connection.baseUrl,
          model: connection.model,
          hasApiKey: Boolean(connection.credentialRef),
          reasoningEfforts: reasoningEffortsForModel(connection.providerId, connection.model)
        },
        errorMessage: runtime.errorMessage,
        lastCheckedAt: runtime.lastCheckedAt
      }
    })
    return structuredClone({
      options: OPTIONS,
      connections: [this.codingPlanConnection, ...apiConnections],
      configurationError: this.configurationError
    })
  }

  private assertConfigurationWritable(): void {
    if (this.configurationError) {
      throw new Error('AI Connection 配置当前不可修改；请先修复配置文件并重新启动 Oyster')
    }
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation)
    this.mutationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  async refresh(): Promise<AiBackendSnapshot> {
    await Promise.all([
      this.refreshCodingPlan(),
      ...this.state.connections.map((connection) => this.refreshApiModels(connection))
    ])
    return this.snapshot()
  }

  private async refreshCodingPlan(): Promise<void> {
    const [discovered, auth] = await Promise.all([
      this.codexDiscovery.inspect(),
      this.codingPlanAdapter.inspectAuth()
    ])
    const models = this.codingPlanAdapter.listModels()
    const authenticating = this.codingPlanAuthenticationActive
    this.codingPlanConnection = {
      id: CODEX_CONNECTION_ID,
      adapterId: 'codex',
      backendKind: 'coding_plan',
      providerId: 'openai_codex',
      displayName: 'OpenAI Codex Coding Plan',
      credentialMode: 'oyster_keychain',
      status: authenticating ? 'authenticating' : auth.status,
      models,
      defaultModelId: preferredModel(models),
      executablePath: discovered.executablePath,
      accountLabel: discovered.accountLabel,
      planType: discovered.planType,
      errorMessage: authenticating ? undefined : auth.errorMessage,
      lastCheckedAt: new Date().toISOString(),
      ...(authenticating && this.codingPlanConnection.authentication
        ? { authentication: this.codingPlanConnection.authentication }
        : {})
    }
    this.emit()
  }

  private async refreshApiModels(connection: StoredModelConnection): Promise<void> {
    try {
      const apiKey = connection.credentialRef
        ? await this.credentialStore.get(connection.credentialRef)
        : undefined
      if (connection.credentialRef && !apiKey) throw new Error('Keychain 中的 API Key 已不可用')
      const discovered = await this.modelAdapter.listModels(
        connection.providerId,
        connection.baseUrl,
        apiKey
      )
      this.discoveredModelCache.set(
        modelDiscoveryKey(connection.providerId, connection.baseUrl),
        structuredClone(discovered)
      )
      const models = new Map(discovered.map((model) => [model.id, model]))
      for (const model of defaultApiModels(connection)) {
        if (!models.has(model.id)) models.set(model.id, model)
      }
      this.apiModels.set(connection.id, [...models.values()])
      this.connectionStates.set(connection.id, {
        status: 'ready',
        lastCheckedAt: new Date().toISOString()
      })
    } catch (error) {
      this.connectionStates.set(connection.id, {
        status: 'unavailable',
        errorMessage: error instanceof Error ? error.message : String(error),
        lastCheckedAt: new Date().toISOString()
      })
    }
    this.emit()
  }

  async connect(input: ConnectAiBackendInput): Promise<AiBackendSnapshot> {
    assertConnectInput(input)
    if (input.connectionId !== CODEX_CONNECTION_ID) {
      throw new Error('该 Connection 不支持 OAuth 登录')
    }
    if (this.codingPlanAuthenticationActive) throw new Error('Coding Plan 认证正在进行')
    this.codingPlanAuthenticationActive = true
    this.codingPlanConnection = {
      ...this.codingPlanConnection,
      status: 'authenticating',
      errorMessage: undefined,
      authentication: { loginMethod: input.loginMethod }
    }
    this.emit()
    try {
      await this.codingPlanAdapter.connect(input.loginMethod, (authentication) => {
        if (!this.codingPlanAuthenticationActive) return
        this.codingPlanConnection = {
          ...this.codingPlanConnection,
          status: 'authenticating',
          errorMessage: undefined,
          authentication
        }
        this.emit()
      })
      this.codingPlanAuthenticationActive = false
      await this.refreshCodingPlan()
      return this.snapshot()
    } catch (error) {
      this.codingPlanAuthenticationActive = false
      await this.refreshCodingPlan()
      throw error
    }
  }

  cancelConnect(connectionId: string): void {
    if (connectionId !== CODEX_CONNECTION_ID) return
    this.codingPlanAdapter.cancelConnect()
  }

  async discoverModels(input: DiscoverModelsInput): Promise<ModelDiscoveryResult> {
    assertDiscoveryInput(input)
    const baseUrl = input.providerId === 'openai'
      ? 'https://api.openai.com/v1'
      : normalizeModelBaseUrl(input.baseUrl)
    const models = await this.modelAdapter.listModels(
      input.providerId,
      baseUrl,
      input.apiKey?.trim() || undefined
    )
    this.discoveredModelCache.set(modelDiscoveryKey(input.providerId, baseUrl), structuredClone(models))
    return { models }
  }

  saveModelConnection(input: SaveModelConnectionInput): Promise<AiBackendSnapshot> {
    return this.enqueueMutation(async () => {
      this.assertConfigurationWritable()
      assertModelInput(input)
      const id = `model:${randomUUID()}`
      const credentialRef = input.apiKey?.trim() ? id : undefined
      const connection: StoredModelConnection = {
        id,
        adapterId: 'openai-compatible',
        providerId: input.providerId,
        protocol: input.protocol,
        baseUrl: input.providerId === 'openai'
          ? 'https://api.openai.com/v1'
          : normalizeModelBaseUrl(input.baseUrl),
        model: input.model.trim(),
        credentialRef
      }

      if (credentialRef) await this.credentialStore.set(credentialRef, input.apiKey!.trim())
      try {
        this.state.connections.push(connection)
        await this.repository.save(this.state)
      } catch (error) {
        this.state.connections = this.state.connections.filter((candidate) => candidate.id !== id)
        if (credentialRef) {
          try {
            await this.credentialStore.delete(credentialRef)
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              'API Connection 保存失败，且 Keychain 回滚未完成'
            )
          }
        }
        throw error
      }
      this.connectionStates.set(id, { status: 'unverified' })
      const discovered = this.discoveredModelCache.get(
        modelDiscoveryKey(connection.providerId, connection.baseUrl)
      ) ?? []
      const models = new Map(discovered.map((candidate) => [candidate.id, candidate]))
      for (const candidate of defaultApiModels(connection)) {
        if (!models.has(candidate.id)) models.set(candidate.id, candidate)
      }
      this.apiModels.set(id, [...models.values()])
      this.emit()
      return this.snapshot()
    })
  }

  removeConnection(connectionId: string): Promise<AiBackendSnapshot> {
    return this.enqueueMutation(async () => {
      this.assertConfigurationWritable()
      const connection = this.state.connections.find((candidate) => candidate.id === connectionId)
      if (!connection) throw new Error('未找到可删除的 API Connection')
      const previousState = this.state
      const nextState = {
        connections: this.state.connections.filter((candidate) => candidate.id !== connectionId)
      }
      await this.repository.save(nextState)
      if (connection.credentialRef) {
        try {
          await this.credentialStore.delete(connection.credentialRef)
        } catch (error) {
          await this.repository.save(previousState)
          throw error
        }
      }
      this.state = nextState
      this.connectionStates.delete(connectionId)
      this.apiModels.delete(connectionId)
      this.emit()
      return this.snapshot()
    })
  }

  private connectionModel(connectionId: string, modelId: string): AvailableModel {
    const connection = this.snapshot().connections.find((candidate) => candidate.id === connectionId)
    if (!connection) throw new Error('未找到 AI Connection')
    const model = connection.models.find((candidate) => candidate.id === modelId)
    if (!model) throw new Error('所选 Model 不属于该 Connection')
    return model
  }

  private updateHealth(connectionId: string, status: ConnectionRuntimeState): void {
    if (connectionId === CODEX_CONNECTION_ID) {
      this.codingPlanConnection = { ...this.codingPlanConnection, ...status }
    } else if (this.state.connections.some((connection) => connection.id === connectionId)) {
      this.connectionStates.set(connectionId, status)
    }
    this.emit()
  }

  private async withApiConnection<T>(
    connectionId: string,
    modelId: string,
    operation: (connection: StoredModelConnection, apiKey?: string) => Promise<T>
  ): Promise<T> {
    const connection = this.state.connections.find((candidate) => candidate.id === connectionId)
    if (!connection) throw new Error('未找到 API Connection')
    this.connectionModel(connectionId, modelId)
    const apiKey = connection.credentialRef
      ? await this.credentialStore.get(connection.credentialRef)
      : undefined
    if (connection.credentialRef && !apiKey) throw new Error('Keychain 中的 API Key 已不可用')
    return operation({ ...connection, model: modelId }, apiKey)
  }

  async generateWithModel(
    connectionId: string,
    modelId: string,
    request: ModelGenerationRequest
  ): Promise<ModelGenerationResult> {
    this.connectionModel(connectionId, modelId)
    try {
      const result = connectionId === CODEX_CONNECTION_ID
        ? await this.codingPlanAdapter.generate(modelId, request)
        : await this.withApiConnection(
            connectionId,
            modelId,
            (connection, apiKey) => this.modelAdapter.generate(connection, apiKey, request)
          )
      this.updateHealth(connectionId, {
        status: 'ready',
        lastCheckedAt: new Date().toISOString()
      })
      return result
    } catch (error) {
      if (!request.signal?.aborted && !(error instanceof ModelContextOverflowError)) {
        this.updateHealth(connectionId, {
          status: 'unavailable',
          errorMessage: error instanceof Error ? error.message : String(error),
          lastCheckedAt: new Date().toISOString()
        })
      }
      throw error
    }
  }

  async withModelRuntime<T>(
    connectionId: string,
    modelId: string,
    operation: (runtime: ModelRuntime) => Promise<T>,
    options: { trackHealth?: boolean } = {}
  ): Promise<T> {
    const model = this.connectionModel(connectionId, modelId)
    try {
      const result = connectionId === CODEX_CONNECTION_ID
        ? await operation(runtimeWithModelMetadata(this.codingPlanAdapter.runtime(modelId), model))
        : await this.withApiConnection(
            connectionId,
            modelId,
            (connection, apiKey) => operation(runtimeWithModelMetadata(
              this.apiRuntimeFactory(connection, apiKey),
              model
            ))
          )
      if (options.trackHealth) {
        this.updateHealth(connectionId, {
          status: 'ready',
          lastCheckedAt: new Date().toISOString()
        })
      }
      return result
    } catch (error) {
      if (options.trackHealth && error instanceof ModelConnectionFailureError) {
        this.updateHealth(connectionId, {
          status: 'unavailable',
          errorMessage: error.operationError.message,
          lastCheckedAt: new Date().toISOString()
        })
        throw error.operationError
      }
      throw error
    }
  }

  async testConnection(input: TestConnectionInput): Promise<ConnectionTestResult> {
    assertTestInput(input)
    const model = this.connectionModel(input.connectionId, input.modelId)
    if (input.reasoningEffort && !model.reasoningEfforts.includes(input.reasoningEffort)) {
      throw new Error('所选模型不支持该思考强度')
    }
    const startedAt = Date.now()
    const result = await this.generateWithModel(input.connectionId, input.modelId, {
      prompt: 'This is a connection test. Reply with the single word OYSTER.',
      maxOutputTokens: 32,
      timeoutMs: 30_000,
      maxResponseBytes: 64 * 1_024,
      reasoningEffort: input.reasoningEffort
    })
    return {
      connectionId: input.connectionId,
      output: result.text,
      durationMs: Date.now() - startedAt
    }
  }

  subscribe(listener: (snapshot: AiBackendSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    const snapshot = this.snapshot()
    for (const listener of this.listeners) listener(snapshot)
  }

  dispose(): void {
    this.unsubscribeDiscovery()
    this.codexDiscovery.dispose()
    this.codingPlanAdapter.dispose()
    this.listeners.clear()
  }
}

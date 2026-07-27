import type { StreamFn } from '@earendil-works/pi-agent-core'
import {
  REASONING_EFFORTS,
  type AvailableModel,
  type ReasoningEffort
} from '../../shared/ai-backends'
import {
  contentText,
  createModels,
  getSupportedThinkingLevels,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type AuthCheck,
  type AuthInteraction,
  type AuthType,
  type Context,
  type Credential,
  type CredentialStore,
  type Model,
  type ModelsSimpleStreamOptions
} from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import type {
  ModelGenerationRequest,
  ModelGenerationResult,
  ModelRuntime
} from './model'

const PROVIDER_ID = 'openai-codex'
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000
const MAX_REQUEST_TIMEOUT_MS = 10 * 60_000
const DEFAULT_MAX_OUTPUT_TOKENS = 4_096
const MAX_OUTPUT_TOKENS = 32_768
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1_024 * 1_024
const MAX_RESPONSE_BYTES = 16 * 1_024 * 1_024

export type PiCodingPlanAuthStatus = 'needs_auth' | 'ready' | 'unsupported' | 'unavailable'

export interface PiCodingPlanAuthState {
  status: PiCodingPlanAuthStatus
  errorMessage?: string
}

export interface PiCodingPlanModels {
  getModels(provider?: string): readonly Model<Api>[]
  getModel(provider: string, modelId: string): Model<Api> | undefined
  checkAuth(providerId: string): Promise<AuthCheck | undefined>
  login(
    providerId: string,
    type: AuthType,
    interaction: AuthInteraction
  ): Promise<Credential>
  completeSimple(
    model: Model<Api>,
    context: Context,
    options?: ModelsSimpleStreamOptions
  ): Promise<AssistantMessage>
  streamSimple(
    model: Model<Api>,
    context: Context,
    options?: ModelsSimpleStreamOptions
  ): AssistantMessageEventStream
}

export interface PiCodingPlanAdapterOptions {
  credentials: CredentialStore
  openExternal(url: string): Promise<void>
  models?: PiCodingPlanModels
}

function createCodingPlanModels(credentials: CredentialStore): PiCodingPlanModels {
  const models = createModels({ credentials })
  models.setProvider(openaiCodexProvider())
  return models
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} 必须是 ${minimum} 到 ${maximum} 之间的整数`)
  }
  return value
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('操作已取消')
}

function requestSignal(
  source: AbortSignal | undefined,
  timeoutMs: number
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('模型请求超时')), timeoutMs)
  const abort = (): void => controller.abort(source?.reason ?? new Error('模型请求已取消'))
  source?.addEventListener('abort', abort, { once: true })
  if (source?.aborted) abort()
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      source?.removeEventListener('abort', abort)
    }
  }
}

function waitUntilAborted(signals: Array<AbortSignal | undefined>): Promise<string> {
  return new Promise((_resolve, reject) => {
    const available = signals.filter((signal): signal is AbortSignal => Boolean(signal))
    const cleanup = (): void => {
      for (const signal of available) signal.removeEventListener('abort', abort)
    }
    const abort = (): void => {
      cleanup()
      const signal = available.find((candidate) => candidate.aborted)
      reject(signal ? abortError(signal) : new Error('认证已取消'))
    }
    if (available.some((signal) => signal.aborted)) return abort()
    for (const signal of available) signal.addEventListener('abort', abort, { once: true })
  })
}

function reasoningEfforts(model: Model<Api>): ReasoningEffort[] {
  return getSupportedThinkingLevels(model).filter(
    (effort): effort is ReasoningEffort => REASONING_EFFORTS.includes(effort as ReasoningEffort)
  )
}

function ensureReasoningEffort(model: Model<Api>, effort?: ReasoningEffort): void {
  if (effort && !reasoningEfforts(model).includes(effort)) {
    throw new Error(`模型 ${model.id} 不支持思考强度 ${effort}`)
  }
}

/**
 * Model-call adapter for a ChatGPT/Codex Coding Plan authenticated by Pi OAuth.
 * It never reads the Codex Runtime token and never returns an OAuth URL to the renderer.
 */
export class PiCodingPlanAdapter {
  private readonly models: PiCodingPlanModels
  private activeAuthentication?: AbortController

  constructor(private readonly options: PiCodingPlanAdapterOptions) {
    this.models = options.models ?? createCodingPlanModels(options.credentials)
  }

  listModels(): AvailableModel[] {
    const seen = new Set<string>()
    return this.models.getModels(PROVIDER_ID).flatMap((model) => {
      if (!model.id.trim() || seen.has(model.id)) return []
      seen.add(model.id)
      return [{
        id: model.id,
        displayName: model.name || model.id,
        reasoningEfforts: reasoningEfforts(model)
      }]
    })
  }

  async inspectAuth(): Promise<PiCodingPlanAuthState> {
    try {
      const auth = await this.models.checkAuth(PROVIDER_ID)
      if (!auth) return { status: 'needs_auth' }
      return auth.type === 'oauth'
        ? { status: 'ready' }
        : { status: 'unsupported', errorMessage: 'Coding Plan 必须使用 OAuth 认证' }
    } catch (error) {
      return { status: 'unavailable', errorMessage: errorText(error) }
    }
  }

  async connect(): Promise<void> {
    if (this.activeAuthentication) throw new Error('Coding Plan 认证正在进行')
    const controller = new AbortController()
    this.activeAuthentication = controller
    let openFailure: Error | undefined
    let opening = Promise.resolve()

    try {
      await this.models.login(PROVIDER_ID, 'oauth', {
        signal: controller.signal,
        prompt: (prompt) => {
          if (prompt.type === 'select') {
            const browser = prompt.options.find((option) => option.id === 'browser')
            if (!browser) throw new Error('Coding Plan OAuth 不支持浏览器登录')
            return Promise.resolve(browser.id)
          }
          if (prompt.type === 'manual_code') {
            return waitUntilAborted([prompt.signal, controller.signal])
          }
          throw new Error('Coding Plan OAuth 请求了不受支持的交互')
        },
        notify: (event) => {
          if (event.type !== 'auth_url') return
          let url: URL
          try {
            url = new URL(event.url)
          } catch {
            openFailure = new Error('Coding Plan OAuth 返回了无效登录地址')
            controller.abort(openFailure)
            return
          }
          if (url.protocol !== 'https:') {
            openFailure = new Error('Coding Plan OAuth 返回了不安全的登录地址')
            controller.abort(openFailure)
            return
          }
          opening = opening.then(() => this.options.openExternal(url.toString())).catch((error: unknown) => {
            openFailure = error instanceof Error ? error : new Error(String(error))
            controller.abort(openFailure)
          })
        }
      })
      await opening
      if (openFailure) throw openFailure
      controller.signal.throwIfAborted()
    } finally {
      if (this.activeAuthentication === controller) this.activeAuthentication = undefined
    }
  }

  cancelConnect(): void {
    this.activeAuthentication?.abort(new Error('用户取消了 Coding Plan 认证'))
  }

  private model(modelId: string): Model<Api> {
    if (typeof modelId !== 'string' || !modelId.trim() || modelId.length > 200) {
      throw new Error('Coding Plan Model ID 无效')
    }
    const model = this.models.getModel(PROVIDER_ID, modelId)
    if (!model) throw new Error('所选 Coding Plan 模型当前不可用')
    return model
  }

  async generate(
    modelId: string,
    request: ModelGenerationRequest
  ): Promise<ModelGenerationResult> {
    const model = this.model(modelId)
    ensureReasoningEffort(model, request.reasoningEffort)
    const timeoutMs = boundedInteger(
      request.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      1,
      MAX_REQUEST_TIMEOUT_MS,
      '请求超时'
    )
    const maxTokens = boundedInteger(
      request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      1,
      MAX_OUTPUT_TOKENS,
      '最大输出 Token'
    )
    const maxResponseBytes = boundedInteger(
      request.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      1,
      MAX_RESPONSE_BYTES,
      '最大响应大小'
    )
    const operation = requestSignal(request.signal, timeoutMs)
    try {
      const result = await this.models.completeSimple(model, {
        systemPrompt: request.systemPrompt,
        messages: [{ role: 'user', content: request.prompt, timestamp: Date.now() }]
      }, {
        maxTokens,
        maxRetries: 0,
        timeoutMs,
        signal: operation.signal,
        ...(request.reasoningEffort ? { reasoning: request.reasoningEffort } : {})
      })
      operation.signal.throwIfAborted()
      if (result.stopReason === 'error' || result.stopReason === 'aborted') {
        throw new Error(result.errorMessage || 'Coding Plan 模型调用失败')
      }
      if (result.stopReason === 'length') throw new Error('Coding Plan 模型返回了不完整结果')
      const text = contentText(result.content)
      if (Buffer.byteLength(text, 'utf8') > maxResponseBytes) {
        throw new Error('Coding Plan 模型返回内容过大')
      }
      return { text }
    } finally {
      operation.dispose()
    }
  }

  runtime(modelId: string): ModelRuntime {
    const model = this.model(modelId)
    const streamFn: StreamFn = (_requestedModel, context, options) => {
      if (options?.reasoning) {
        ensureReasoningEffort(model, options.reasoning as ReasoningEffort)
      }
      return this.models.streamSimple(model, context, options)
    }
    return { model, streamFn }
  }

  dispose(): void {
    this.cancelConnect()
  }
}

export const PI_CODING_PLAN_PROVIDER_ID = PROVIDER_ID

import type {
  AvailableModel,
  ModelProtocol,
  ModelProviderId
} from '../../shared/ai-backends'
import type {
  ModelBackendAdapter,
  ModelGenerationRequest,
  ModelGenerationResult,
  StoredModelConnection
} from './model'
import { ModelContextOverflowError } from './model'
import { reasoningEffortsForModel } from './model-capabilities'

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000
const MAX_REQUEST_TIMEOUT_MS = 10 * 60_000
const DEFAULT_MAX_OUTPUT_TOKENS = 4_096
const MAX_OUTPUT_TOKENS = 32_768
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1_024 * 1_024
const MAX_RESPONSE_BYTES = 16 * 1_024 * 1_024
const MODELS_REQUEST_TIMEOUT_MS = 30_000
const MODELS_MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024
const MAX_DISCOVERED_MODELS = 10_000
const ERROR_RESPONSE_MAX_BYTES = 64 * 1_024
const MAX_DECLARED_MODEL_TOKENS = 100_000_000

const CONTEXT_WINDOW_FIELDS = [
  'context_window',
  'context_length',
  'max_context_length',
  'max_model_len',
  'contextWindowTokens'
] as const

const MAX_OUTPUT_FIELDS = [
  'max_output_tokens',
  'max_completion_tokens',
  'maxOutputTokens'
] as const

const CONTEXT_OVERFLOW_CODES = new Set([
  'context_length_exceeded',
  'context_window_exceeded',
  'input_too_long',
  'prompt_too_long',
  'model_context_window_exceeded',
  'max_context_length',
  'max_context_window',
  'input_tokens_exceeded',
  'request_too_large'
])

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1'
}

export function normalizeModelBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('Base URL 格式无效')
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Base URL 不能包含账号、查询参数或片段')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHostname(url.hostname))) {
    throw new Error('远程 Base URL 必须使用 HTTPS；HTTP 只允许 localhost')
  }

  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  return url.toString().replace(/\/$/, '')
}

function endpoint(baseUrl: string, protocol: ModelProtocol): URL {
  const suffix = protocol === 'openai_responses' ? 'responses' : 'chat/completions'
  return new URL(`${baseUrl.replace(/\/+$/, '')}/${suffix}`)
}

function modelsEndpoint(baseUrl: string): URL {
  return new URL(`${baseUrl.replace(/\/+$/, '')}/models`)
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} 必须是 ${minimum} 到 ${maximum} 之间的整数`)
  }
  return value
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('模型请求超时')), timeoutMs)
  const abort = (): void => controller.abort(signal?.reason)
  signal?.addEventListener('abort', abort, { once: true })
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }
}

async function readBoundedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error('模型端点返回内容过大')
  }
  if (!response.body) throw new Error('模型端点未返回响应内容')

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new Error('模型端点返回内容过大')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  return new TextDecoder().decode(await readBoundedBytes(response, maxBytes))
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const text = await readBoundedText(response, maxBytes)
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error('模型端点返回了无效 JSON')
  }
}

function declaredModelLimit(
  record: Record<string, unknown>,
  fields: readonly string[]
): number | undefined {
  for (const field of fields) {
    const value = record[field]
    if (
      typeof value === 'number'
      && Number.isSafeInteger(value)
      && value > 0
      && value <= MAX_DECLARED_MODEL_TOKENS
    ) {
      return value
    }
  }
  return undefined
}

interface ModelEndpointErrorDetails {
  codes: string[]
  text: string
}

function modelEndpointErrorDetails(raw: string): ModelEndpointErrorDetails {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return { codes: [], text: raw }
  }
  if (!parsed || typeof parsed !== 'object') return { codes: [], text: raw }
  const payload = parsed as Record<string, unknown>
  const nested = payload.error && typeof payload.error === 'object'
    ? payload.error as Record<string, unknown>
    : undefined
  const records = nested ? [nested, payload] : [payload]
  const codes = records.flatMap((record) => ['code', 'type', 'reason'].flatMap((field) => {
    const value = record[field]
    return typeof value === 'string' ? [value] : []
  }))
  const messages = records.flatMap((record) => {
    const value = record.message
    return typeof value === 'string' ? [value] : []
  })
  return {
    codes,
    text: [...codes, ...messages].join(' ') || raw
  }
}

function isContextOverflowDetails(details: ModelEndpointErrorDetails): boolean {
  if (details.codes.some((code) => CONTEXT_OVERFLOW_CODES.has(code.trim().toLowerCase()))) return true
  if (/rate[ _-]?limit|too many requests/i.test(details.text)) return false
  return [
    /exceeds? (?:the )?(?:model'?s )?context window/i,
    /exceeds? (?:the )?(?:model'?s )?maximum context length/i,
    /maximum context length is [\d,]+ tokens/i,
    /(?:input|prompt)(?: token count)?[^.]{0,80}(?:too long|exceeds? (?:the )?maximum)/i,
    /context[_ ](?:length|window)[_ ]exceeded/i,
    /too many tokens/i,
    /token limit exceeded/i
  ].some((pattern) => pattern.test(details.text))
}

async function modelEndpointHttpError(response: Response): Promise<Error> {
  if (!response.body) return new Error(`模型端点返回 HTTP ${response.status}`)
  const details = modelEndpointErrorDetails(await readBoundedText(response, ERROR_RESPONSE_MAX_BYTES))
  return isContextOverflowDetails(details)
    ? new ModelContextOverflowError('模型输入超过所选模型的上下文窗口')
    : new Error(`模型端点返回 HTTP ${response.status}`)
}

function responseText(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const response = value as Record<string, unknown>
  if (typeof response.output_text === 'string') return response.output_text

  if (Array.isArray(response.output)) {
    const parts: string[] = []
    for (const output of response.output) {
      if (!output || typeof output !== 'object') continue
      const content = (output as Record<string, unknown>).content
      if (!Array.isArray(content)) continue
      for (const item of content) {
        if (!item || typeof item !== 'object') continue
        const text = (item as Record<string, unknown>).text
        if (typeof text === 'string') parts.push(text)
      }
    }
    if (parts.length) return parts.join('')
  }

  const choices = response.choices
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== 'object') return undefined
  const message = (choices[0] as Record<string, unknown>).message
  if (!message || typeof message !== 'object') return undefined
  const content = (message as Record<string, unknown>).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const parts = content.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const text = (item as Record<string, unknown>).text
    return typeof text === 'string' ? [text] : []
  })
  return parts.length ? parts.join('') : undefined
}

function assertResponseComplete(value: unknown): void {
  if (!value || typeof value !== 'object') return
  const response = value as Record<string, unknown>

  if (typeof response.status === 'string' && response.status !== 'completed') {
    const details = response.incomplete_details
    const reason = details && typeof details === 'object'
      ? (details as Record<string, unknown>).reason
      : undefined
    if (
      typeof reason === 'string'
      && isContextOverflowDetails({ codes: [reason], text: reason })
    ) {
      throw new ModelContextOverflowError('模型输入超过所选模型的上下文窗口')
    }
    throw new Error(
      typeof reason === 'string'
        ? `模型输出不完整：${reason}`
        : `模型响应未完成：${response.status}`
    )
  }

  const choices = response.choices
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== 'object') return
  const finishReason = (choices[0] as Record<string, unknown>).finish_reason
  if (finishReason === 'length') {
    throw new Error('模型输出达到长度上限，结果不完整')
  }
  if (typeof finishReason === 'string' && finishReason !== 'stop') {
    throw new Error(`模型响应未正常完成：${finishReason}`)
  }
}

export class OpenAiCompatibleAdapter implements ModelBackendAdapter {
  readonly id = 'openai-compatible' as const

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async listModels(
    providerId: ModelProviderId,
    baseUrlValue: string,
    apiKey?: string,
    signal?: AbortSignal
  ): Promise<AvailableModel[]> {
    signal?.throwIfAborted()
    const baseUrl = normalizeModelBaseUrl(baseUrlValue)
    const controlledSignal = requestSignal(signal, MODELS_REQUEST_TIMEOUT_MS)
    try {
      const response = await this.fetchImpl(modelsEndpoint(baseUrl), {
        method: 'GET',
        redirect: 'manual',
        signal: controlledSignal.signal,
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined
      })
      if (response.status >= 300 && response.status < 400) {
        throw new Error('模型端点返回了重定向，为避免凭据泄露已拒绝跟随')
      }
      if (!response.ok) throw new Error(`模型列表端点返回 HTTP ${response.status}`)
      const payload = await readBoundedJson(response, MODELS_MAX_RESPONSE_BYTES)
      if (!payload || typeof payload !== 'object' || !Array.isArray((payload as Record<string, unknown>).data)) {
        throw new Error('模型列表端点未返回标准 data 数组')
      }
      const data = (payload as { data: unknown[] }).data
      if (data.length > MAX_DISCOVERED_MODELS) throw new Error('模型列表数量超出安全上限')

      const models = new Map<string, AvailableModel>()
      for (const item of data) {
        if (!item || typeof item !== 'object') continue
        const record = item as Record<string, unknown>
        if (typeof record.id !== 'string') continue
        const id = record.id.trim()
        if (!id || id.length > 200 || models.has(id)) continue
        const name = typeof record.name === 'string' && record.name.trim().length <= 200
          ? record.name.trim()
          : id
        const contextWindowTokens = declaredModelLimit(record, CONTEXT_WINDOW_FIELDS)
        const declaredMaxOutputTokens = declaredModelLimit(record, MAX_OUTPUT_FIELDS)
        const maxOutputTokens = declaredMaxOutputTokens
          && (!contextWindowTokens || declaredMaxOutputTokens <= contextWindowTokens)
          ? declaredMaxOutputTokens
          : undefined
        models.set(id, {
          id,
          displayName: name,
          reasoningEfforts: reasoningEffortsForModel(providerId, id),
          ...(contextWindowTokens ? { contextWindowTokens } : {}),
          ...(maxOutputTokens ? { maxOutputTokens } : {})
        })
      }
      return [...models.values()].sort((left, right) => left.id.localeCompare(right.id))
    } finally {
      controlledSignal.dispose()
    }
  }

  async generate(
    connection: StoredModelConnection,
    apiKey: string | undefined,
    request: ModelGenerationRequest
  ): Promise<ModelGenerationResult> {
    request.signal?.throwIfAborted()
    const baseUrl = normalizeModelBaseUrl(connection.baseUrl)
    const target = endpoint(baseUrl, connection.protocol)
    const maxOutputTokens = boundedInteger(
      request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      1,
      MAX_OUTPUT_TOKENS,
      'maxOutputTokens'
    )
    const timeoutMs = boundedInteger(
      request.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      1_000,
      MAX_REQUEST_TIMEOUT_MS,
      'timeoutMs'
    )
    const maxResponseBytes = boundedInteger(
      request.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      1_024,
      MAX_RESPONSE_BYTES,
      'maxResponseBytes'
    )
    const controlledSignal = requestSignal(request.signal, timeoutMs)
    const reasoningEffort = request.reasoningEffort
      && reasoningEffortsForModel(connection.providerId, connection.model).includes(request.reasoningEffort)
      ? request.reasoningEffort
      : undefined
    const body = connection.protocol === 'openai_responses'
      ? {
          model: connection.model,
          input: request.prompt,
          ...(request.systemPrompt ? { instructions: request.systemPrompt } : {}),
          max_output_tokens: maxOutputTokens,
          store: false,
          ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {})
        }
      : {
          model: connection.model,
          messages: [
            ...(request.systemPrompt ? [{ role: 'system', content: request.systemPrompt }] : []),
            { role: 'user', content: request.prompt }
          ],
          ...(connection.providerId === 'openai'
            ? { max_completion_tokens: maxOutputTokens, store: false }
            : { max_tokens: maxOutputTokens }),
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {})
    }

    try {
      request.signal?.throwIfAborted()
      const response = await this.fetchImpl(target, {
        method: 'POST',
        redirect: 'manual',
        signal: controlledSignal.signal,
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
        },
        body: JSON.stringify(body)
      })

      if (response.status >= 300 && response.status < 400) {
        throw new Error('模型端点返回了重定向，为避免凭据泄露已拒绝跟随')
      }
      if (!response.ok) throw await modelEndpointHttpError(response)

      const payload = await readBoundedJson(response, maxResponseBytes)
      assertResponseComplete(payload)
      const text = responseText(payload)?.trim()
      if (!text) throw new Error('模型端点未返回可读文本')
      return { text }
    } finally {
      controlledSignal.dispose()
    }
  }
}

import OpenAI from 'openai'
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionTool
} from 'openai/resources/chat/completions.js'
import type { ResponseCreateParamsStreaming } from 'openai/resources/responses/responses.js'
import {
  createAssistantMessageEventStream,
  parseStreamingJson,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type TextContent,
  type ToolCall,
  type Usage
} from '@earendil-works/pi-ai'
import {
  convertResponsesMessages,
  convertResponsesTools,
  processResponsesStream
} from '@earendil-works/pi-ai/api/openai-responses-shared'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import type { ModelRuntime, StoredModelConnection } from '../ai-backends/model'
import { normalizeModelBaseUrl } from '../ai-backends/openai-compatible-adapter'
import { reasoningEffortsForModel } from '../ai-backends/model-capabilities'
import type { ReasoningEffort } from '../../shared/ai-backends'

const MAX_AGENT_RESPONSE_BYTES = 8 * 1_024 * 1_024
const DEFAULT_AGENT_REQUEST_TIMEOUT_MS = 5 * 60_000
const UNKNOWN_MODEL_MAX_OUTPUT_TOKENS = 4_096
const MAX_ERROR_MESSAGE_CHARACTERS = 4_096

interface StreamingToolCall extends ToolCall {
  partialArguments: string
  streamIndex: number
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  }
}

function assistantMessage(model: Model<Api>): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: 'stop',
    timestamp: Date.now()
  }
}

function errorText(error: unknown): string {
  let message: string
  if (!(error instanceof Error)) {
    message = String(error)
  } else {
    const cause = (error as Error & { cause?: unknown }).cause
    message = cause && (error.message === 'Connection error.' || error.message === 'Connection error')
      ? errorText(cause)
      : error.message
  }
  return message.length <= MAX_ERROR_MESSAGE_CHARACTERS
    ? message
    : `${message.slice(0, MAX_ERROR_MESSAGE_CHARACTERS - 1)}…`
}

function positiveSafeInteger(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function requestMaxOutputTokens(model: Model<Api>, requested: number | undefined): number {
  const modelMaximum = positiveSafeInteger(model.maxTokens) ?? UNKNOWN_MODEL_MAX_OUTPUT_TOKENS
  if (requested === undefined) return modelMaximum
  const normalized = positiveSafeInteger(requested)
  if (!normalized) throw new Error('maxTokens must be a positive safe integer')
  return Math.min(normalized, modelMaximum)
}

function requestTimeoutMs(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_AGENT_REQUEST_TIMEOUT_MS
  const normalized = positiveSafeInteger(requested)
  if (!normalized) throw new Error('timeoutMs must be a positive safe integer')
  return normalized
}

function responseBodyWithLimit(body: ReadableStream<Uint8Array>, maxBytes: number): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  let total = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          controller.close()
          return
        }
        total += value.byteLength
        if (total > maxBytes) {
          await reader.cancel()
          controller.error(new Error('模型端点返回内容过大'))
          return
        }
        controller.enqueue(value)
      } catch (error) {
        controller.error(error)
      }
    },
    cancel(reason) {
      return reader.cancel(reason)
    }
  })
}

function guardedFetch(expectedEndpoint: URL, fetchImpl: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    init?.signal?.throwIfAborted()
    const target = new URL(input instanceof Request ? input.url : input.toString())
    if (target.origin !== expectedEndpoint.origin || target.pathname !== expectedEndpoint.pathname || target.search) {
      throw new Error('模型请求试图离开已配置端点')
    }
    if ((init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase() !== 'POST') {
      throw new Error('模型请求使用了未授权的方法')
    }

    const response = await fetchImpl(input, { ...init, redirect: 'manual' })
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel()
      throw new Error('模型端点返回了重定向，为避免凭据或观察数据泄露已拒绝跟随')
    }
    const declaredLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > MAX_AGENT_RESPONSE_BYTES) {
      await response.body?.cancel()
      throw new Error('模型端点返回内容过大')
    }
    if (!response.body) return response
    return new Response(responseBodyWithLimit(response.body, MAX_AGENT_RESPONSE_BYTES), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    })
  }) as typeof fetch
}

function openAiClient(
  connection: StoredModelConnection,
  apiKey: string | undefined,
  fetchImpl: typeof fetch
): OpenAI {
  const baseUrl = normalizeModelBaseUrl(connection.baseUrl)
  const suffix = connection.protocol === 'openai_responses' ? 'responses' : 'chat/completions'
  const expectedEndpoint = new URL(`${baseUrl}/${suffix}`)
  return new OpenAI({
    apiKey: apiKey || 'unused',
    baseURL: baseUrl,
    maxRetries: 0,
    timeout: DEFAULT_AGENT_REQUEST_TIMEOUT_MS,
    fetch: guardedFetch(expectedEndpoint, fetchImpl),
    ...(!apiKey ? { defaultHeaders: { authorization: null } } : {})
  })
}

function textFromContent(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === 'string') return content
  return content.flatMap((item) => item.type === 'text' && item.text ? [item.text] : []).join('')
}

function chatMessages(context: Context): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = []
  if (context.systemPrompt) messages.push({ role: 'system', content: context.systemPrompt })
  for (const message of context.messages) {
    if (message.role === 'user') {
      messages.push({ role: 'user', content: textFromContent(message.content) })
      continue
    }
    if (message.role === 'toolResult') {
      messages.push({
        role: 'tool',
        tool_call_id: message.toolCallId,
        content: message.content.flatMap((item) => item.type === 'text' ? [item.text] : []).join('\n')
      })
      continue
    }
    const text = message.content.flatMap((item) => item.type === 'text' ? [item.text] : []).join('')
    const toolCalls = message.content.flatMap((item) => item.type === 'toolCall'
      ? [{
          id: item.id,
          type: 'function' as const,
          function: { name: item.name, arguments: JSON.stringify(item.arguments) }
        }]
      : [])
    if (text || toolCalls.length) {
      messages.push({
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {})
      })
    }
  }
  return messages
}

function chatTools(context: Context): ChatCompletionTool[] | undefined {
  if (!context.tools?.length) return undefined
  return context.tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as Record<string, unknown>
    }
  }))
}

function applyChatUsage(output: AssistantMessage, chunk: ChatCompletionChunk): void {
  if (!chunk.usage) return
  const cached = chunk.usage.prompt_tokens_details?.cached_tokens || 0
  output.usage = {
    input: Math.max(0, chunk.usage.prompt_tokens - cached),
    output: chunk.usage.completion_tokens,
    cacheRead: cached,
    cacheWrite: 0,
    reasoning: chunk.usage.completion_tokens_details?.reasoning_tokens || 0,
    totalTokens: chunk.usage.total_tokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  }
}

function chatStream(
  model: Model<Api>,
  connection: StoredModelConnection,
  client: OpenAI,
  context: Context,
  reasoningEffort?: ReasoningEffort,
  signal?: AbortSignal,
  requestedMaxTokens?: number,
  requestedTimeoutMs?: number
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream()
  const output = assistantMessage(model)
  void (async () => {
    const toolCalls = new Map<number, StreamingToolCall>()
    let textBlock: TextContent | undefined
    let finishReason: string | null = null
    try {
      signal?.throwIfAborted()
      const maxOutputTokens = requestMaxOutputTokens(model, requestedMaxTokens)
      const timeoutMs = requestTimeoutMs(requestedTimeoutMs)
      const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
        model: connection.model,
        messages: chatMessages(context),
        stream: true,
        ...(connection.providerId === 'openai' ? { stream_options: { include_usage: true }, store: false } : {}),
        ...(connection.providerId === 'openai'
          ? { max_completion_tokens: maxOutputTokens }
          : { max_tokens: maxOutputTokens }),
        ...(reasoningEffort
          ? { reasoning_effort: reasoningEffort as OpenAI.ReasoningEffort }
          : {}),
        ...(chatTools(context) ? { tools: chatTools(context) } : {})
      }
      const providerStream = await client.chat.completions.create(params, {
        signal,
        timeout: timeoutMs,
        maxRetries: 0
      })
      stream.push({ type: 'start', partial: output })
      for await (const chunk of providerStream) {
        applyChatUsage(output, chunk)
        for (const choice of chunk.choices) {
          if (choice.finish_reason) finishReason = choice.finish_reason
          if (choice.delta.content) {
            if (!textBlock) {
              textBlock = { type: 'text', text: '' }
              output.content.push(textBlock)
              stream.push({ type: 'text_start', contentIndex: output.content.length - 1, partial: output })
            }
            textBlock.text += choice.delta.content
            stream.push({
              type: 'text_delta',
              contentIndex: output.content.indexOf(textBlock),
              delta: choice.delta.content,
              partial: output
            })
          }
          for (const delta of choice.delta.tool_calls || []) {
            const index = delta.index
            let block = toolCalls.get(index)
            if (!block) {
              block = {
                type: 'toolCall',
                id: delta.id || `call_${index}`,
                name: '',
                arguments: {},
                partialArguments: '',
                streamIndex: index
              }
              toolCalls.set(index, block)
              output.content.push(block)
              stream.push({ type: 'toolcall_start', contentIndex: output.content.length - 1, partial: output })
            }
            if (delta.id) block.id = delta.id
            if (!block.name && delta.function?.name) block.name = delta.function.name
            if (delta.function?.arguments) {
              block.partialArguments += delta.function.arguments
              block.arguments = parseStreamingJson(block.partialArguments)
              stream.push({
                type: 'toolcall_delta',
                contentIndex: output.content.indexOf(block),
                delta: delta.function.arguments,
                partial: output
              })
            }
          }
        }
      }
      if (!finishReason) throw new Error('模型流在没有 finish_reason 的情况下结束')
      if (textBlock) {
        stream.push({
          type: 'text_end',
          contentIndex: output.content.indexOf(textBlock),
          content: textBlock.text,
          partial: output
        })
      }
      for (const block of toolCalls.values()) {
        block.arguments = parseStreamingJson(block.partialArguments)
        delete (block as Partial<StreamingToolCall>).partialArguments
        delete (block as Partial<StreamingToolCall>).streamIndex
        stream.push({
          type: 'toolcall_end',
          contentIndex: output.content.indexOf(block),
          toolCall: block,
          partial: output
        })
      }
      output.stopReason = finishReason === 'length'
        ? 'length'
        : finishReason === 'tool_calls' && toolCalls.size > 0
          ? 'toolUse'
          : finishReason === 'stop' && toolCalls.size === 0
            ? 'stop'
            : 'error'
      if (output.stopReason === 'error') output.errorMessage = `Provider finish_reason: ${finishReason}`
      if (output.stopReason === 'error') throw new Error(output.errorMessage)
      stream.push({ type: 'done', reason: output.stopReason, message: output })
      stream.end()
    } catch (error) {
      output.stopReason = signal?.aborted ? 'aborted' : 'error'
      output.errorMessage = errorText(error)
      stream.push({ type: 'error', reason: output.stopReason, error: output })
      stream.end()
    }
  })()
  return stream
}

function responsesStream(
  model: Model<Api>,
  connection: StoredModelConnection,
  client: OpenAI,
  context: Context,
  reasoningEffort?: ReasoningEffort,
  signal?: AbortSignal,
  requestedMaxTokens?: number,
  requestedTimeoutMs?: number
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream()
  const output = assistantMessage(model)
  void (async () => {
    try {
      signal?.throwIfAborted()
      const maxOutputTokens = requestMaxOutputTokens(model, requestedMaxTokens)
      const timeoutMs = requestTimeoutMs(requestedTimeoutMs)
      const tools = context.tools?.length
        ? convertResponsesTools(context.tools, { supportsStrictMode: false, strict: false })
        : undefined
      const params: ResponseCreateParamsStreaming = {
        model: connection.model,
        input: convertResponsesMessages(
          model,
          context,
          new Set(['openai', 'openai_compatible']),
          { includeSystemPrompt: false }
        ),
        ...(context.systemPrompt ? { instructions: context.systemPrompt } : {}),
        stream: true,
        store: false,
        max_output_tokens: maxOutputTokens,
        ...(reasoningEffort
          ? { reasoning: { effort: reasoningEffort as OpenAI.ReasoningEffort } }
          : {}),
        ...(tools ? { tools } : {})
      }
      const providerStream = await client.responses.create(params, {
        signal,
        timeout: timeoutMs,
        maxRetries: 0
      })
      stream.push({ type: 'start', partial: output })
      await processResponsesStream(providerStream, output, stream, model)
      signal?.throwIfAborted()
      if (output.stopReason === 'error' || output.stopReason === 'aborted') {
        throw new Error(output.errorMessage || '模型请求失败')
      }
      stream.push({ type: 'done', reason: output.stopReason, message: output })
      stream.end()
    } catch (error) {
      output.stopReason = signal?.aborted ? 'aborted' : 'error'
      output.errorMessage = errorText(error)
      stream.push({ type: 'error', reason: output.stopReason, error: output })
      stream.end()
    }
  })()
  return stream
}

export type OysterModelRuntime = ModelRuntime

export function createOysterModelRuntime(
  connection: StoredModelConnection,
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch
): OysterModelRuntime {
  const reasoningEfforts = reasoningEffortsForModel(connection.providerId, connection.model)
  const model: Model<Api> = {
    id: connection.model,
    name: connection.model,
    api: connection.protocol === 'openai_responses' ? 'openai-responses' : 'openai-completions',
    provider: connection.providerId === 'openai' ? 'openai' : 'openai_compatible',
    baseUrl: normalizeModelBaseUrl(connection.baseUrl),
    reasoning: reasoningEfforts.length > 0,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: UNKNOWN_MODEL_MAX_OUTPUT_TOKENS,
    compat: {
      supportsDeveloperRole: connection.providerId === 'openai',
      supportsStrictMode: false,
      supportsOpenAIGrammarTools: false,
      supportsLongCacheRetention: false
    }
  }
  const client = openAiClient(connection, apiKey, fetchImpl)
  const streamFn: StreamFn = (requestedModel, context, options) => {
    const effectiveModel = requestedModel.id === model.id
      ? {
          ...model,
          contextWindow: requestedModel.contextWindow,
          maxTokens: requestedModel.maxTokens
        }
      : model
    const reasoningEffort = options?.reasoning
      && reasoningEfforts.includes(options.reasoning)
      ? options.reasoning
      : undefined
    return connection.protocol === 'openai_responses'
      ? responsesStream(
          effectiveModel,
          connection,
          client,
          context,
          reasoningEffort,
          options?.signal,
          options?.maxTokens,
          options?.timeoutMs
        )
      : chatStream(
          effectiveModel,
          connection,
          client,
          context,
          reasoningEffort,
          options?.signal,
          options?.maxTokens,
          options?.timeoutMs
        )
  }
  return { model, streamFn }
}

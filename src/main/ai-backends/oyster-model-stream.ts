import type { StreamFn } from '@earendil-works/pi-agent-core'
import type { Api, Model, ProviderHeaders, SimpleStreamOptions } from '@earendil-works/pi-ai'
import { streamSimple as streamOpenAICompletions } from '@earendil-works/pi-ai/api/openai-completions'
import { streamSimple as streamOpenAIResponses } from '@earendil-works/pi-ai/api/openai-responses'
import type { SelectedModelStream, StoredModelConnection } from './model'
import { normalizeModelBaseUrl } from './openai-compatible-adapter'
import { reasoningEffortsForModel } from './model-capabilities'

// Pi uses these same defaults for custom model definitions. Discovery metadata,
// when available, replaces them before an Agent Invocation starts.
export const DEFAULT_MODEL_CONTEXT_WINDOW = 128_000
export const DEFAULT_MODEL_MAX_OUTPUT_TOKENS = 16_384

function requestHeaders(
  apiKey: string | undefined,
  headers: ProviderHeaders | undefined
): ProviderHeaders | undefined {
  if (apiKey) return headers
  // pi-ai requires a client key, but OpenAI-compatible local endpoints commonly do
  // not. A null override prevents its placeholder from becoming an HTTP header.
  return { ...headers, Authorization: null }
}

/**
 * Bind an Oyster Connection to Pi's mature OpenAI transports.
 * Endpoint construction, payload conversion, retries, hooks, streaming, and errors
 * are owned by pi-ai; Oyster only supplies the selected model and credential.
 */
export function createOysterModelStream(
  connection: StoredModelConnection,
  apiKey: string | undefined
): SelectedModelStream {
  const reasoningEfforts = reasoningEffortsForModel(connection.providerId, connection.model)
  const model: Model<Api> = {
    id: connection.model,
    name: connection.model,
    api: connection.protocol === 'openai_responses'
      ? 'openai-responses'
      : 'openai-completions',
    provider: connection.providerId === 'openai' ? 'openai' : 'openai_compatible',
    baseUrl: normalizeModelBaseUrl(connection.baseUrl),
    reasoning: reasoningEfforts.length > 0,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_MODEL_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MODEL_MAX_OUTPUT_TOKENS,
    compat: {
      supportsDeveloperRole: connection.providerId === 'openai',
      supportsStrictMode: false,
      supportsOpenAIGrammarTools: false,
      supportsLongCacheRetention: false
    }
  }
  const providerStream = connection.protocol === 'openai_responses'
    ? streamOpenAIResponses
    : streamOpenAICompletions
  const streamFn: StreamFn = (requestedModel, context, options) => {
    const effectiveModel: Model<Api> = requestedModel.id === model.id
      ? { ...model, ...requestedModel, baseUrl: model.baseUrl }
      : model
    const providerOptions: SimpleStreamOptions = {
      ...options,
      apiKey: apiKey ?? 'oyster-local-endpoint',
      headers: requestHeaders(apiKey, options?.headers)
    }
    return providerStream(effectiveModel as never, context, providerOptions)
  }
  return { model, streamFn }
}

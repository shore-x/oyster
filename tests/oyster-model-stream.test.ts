import { afterEach, describe, expect, it, vi } from 'vitest'
import { Type, type Context } from '@earendil-works/pi-ai'
import type { StoredModelConnection } from '../src/main/ai-backends/model'
import { createOysterModelStream } from '../src/main/ai-backends/oyster-model-stream'

afterEach(() => vi.unstubAllGlobals())

function modelStream(
  value: StoredModelConnection,
  apiKey: string | undefined,
  fetchImpl: typeof fetch
) {
  vi.stubGlobal('fetch', fetchImpl)
  return createOysterModelStream(value, apiKey)
}

function connection(
  protocol: StoredModelConnection['protocol'],
  providerId: StoredModelConnection['providerId'] = 'openai_compatible'
): StoredModelConnection {
  return {
    id: 'model:test',
    adapterId: 'openai-compatible',
    providerId,
    protocol,
    baseUrl: 'http://localhost:11434/v1',
    model: 'test-model'
  }
}

const TOOL = {
  name: 'record_test_result',
  description: 'Record a test result.',
  parameters: Type.Object({ content: Type.String() }, { additionalProperties: false })
}

function context(messages: Context['messages'] = [{
  role: 'user',
  content: [{ type: 'text', text: 'Maintain this knowledge.' }],
  timestamp: 1
}]): Context {
  return {
    systemPrompt: 'SYSTEM INSTRUCTIONS',
    messages,
    tools: [TOOL]
  }
}

function sse(events: unknown[]): Response {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  })
}

async function requestDetails(input: RequestInfo | URL, init?: RequestInit): Promise<{
  url: string
  method: string
  headers: Headers
  body: Record<string, unknown>
}> {
  if (input instanceof Request) {
    return {
      url: input.url,
      method: input.method,
      headers: input.headers,
      body: JSON.parse(await input.clone().text()) as Record<string, unknown>
    }
  }
  return {
    url: input.toString(),
    method: init?.method || 'GET',
    headers: new Headers(init?.headers),
    body: JSON.parse(String(init?.body)) as Record<string, unknown>
  }
}

describe('Oyster model Agent stream', () => {
  it('encodes Chat Completions system instructions and reconstructs streamed tool calls', async () => {
    let request: Awaited<ReturnType<typeof requestDetails>> | undefined
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      request = await requestDetails(input, init)
      return sse([
        {
          id: 'chatcmpl-1',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'test-model',
          choices: [{
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [{
                index: 0,
                id: 'call-1',
                type: 'function',
                function: { name: 'record_test_result', arguments: '{"content":' }
              }]
            },
            finish_reason: null
          }]
        },
        {
          id: 'chatcmpl-1',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'test-model',
          choices: [{
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '"candidate"}' } }] },
            finish_reason: null
          }]
        },
        {
          id: 'chatcmpl-1',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'test-model',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }
        }
      ])
    }) as typeof fetch
    const selected = modelStream(
      connection('openai_chat_completions'),
      'secret-key',
      fetchImpl
    )

    const result = await (await selected.streamFn(
      selected.model,
      context(),
      { reasoning: 'high' }
    )).result()

    expect(request).toBeDefined()
    expect(request!.url).toBe('http://localhost:11434/v1/chat/completions')
    expect(request!.method).toBe('POST')
    expect(request!.headers.get('authorization')).toBe('Bearer secret-key')
    expect(request!.body).toMatchObject({
      model: 'test-model',
      messages: [
        { role: 'system', content: 'SYSTEM INSTRUCTIONS' },
        {
          role: 'user',
          content: [{ type: 'text', text: 'Maintain this knowledge.' }]
        }
      ]
    })
    expect((request!.body.tools as Array<Record<string, unknown>>)).toHaveLength(1)
    expect(request!.body).not.toHaveProperty('reasoning_effort')
    expect(result.stopReason).toBe('toolUse')
    expect(result.content).toContainEqual(expect.objectContaining({
      type: 'toolCall',
      id: 'call-1',
      name: 'record_test_result',
      arguments: { content: 'candidate' }
    }))
  })

  it('uses the requested model capability and a lower per-call maxTokens for Chat Completions', async () => {
    let request: Awaited<ReturnType<typeof requestDetails>> | undefined
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      request = await requestDetails(input, init)
      return sse([
        {
          id: 'chatcmpl-capability',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'gpt-5-mini',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'OYSTER' }, finish_reason: null }]
        },
        {
          id: 'chatcmpl-capability',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'gpt-5-mini',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
        }
      ])
    }) as typeof fetch
    const selected = modelStream({
      ...connection('openai_chat_completions', 'openai'),
      model: 'gpt-5-mini'
    }, 'secret-key', fetchImpl)
    const selectedModel = { ...selected.model, maxTokens: 16_384 }

    await (await selected.streamFn(selectedModel, context(), { maxTokens: 6_000 })).result()

    expect(request?.body.max_completion_tokens).toBe(6_000)
  })

  it('encodes a supported Pi reasoning effort in the provider request body', async () => {
    let request: Awaited<ReturnType<typeof requestDetails>> | undefined
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      request = await requestDetails(input, init)
      return sse([
        {
          id: 'chatcmpl-reasoning',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'gpt-5-mini',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'OYSTER' }, finish_reason: null }]
        },
        {
          id: 'chatcmpl-reasoning',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'gpt-5-mini',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }
        }
      ])
    }) as typeof fetch
    const selected = modelStream({
      ...connection('openai_chat_completions', 'openai'),
      model: 'gpt-5-mini'
    }, 'secret-key', fetchImpl)

    await (await selected.streamFn(selected.model, context(), { reasoning: 'low' })).result()

    expect(selected.model.reasoning).toBe(true)
    expect(request?.body.reasoning_effort).toBe('low')
  })

  it('uses Responses instructions and omits authorization when a local Connection has no key', async () => {
    let request: Awaited<ReturnType<typeof requestDetails>> | undefined
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      request = await requestDetails(input, init)
      const functionCall = {
        type: 'function_call',
        id: 'fc-1',
        call_id: 'call-1',
        name: 'record_test_result',
        arguments: '{"content":"candidate"}',
        status: 'completed'
      }
      return sse([
        {
          type: 'response.created',
          sequence_number: 0,
          response: { id: 'resp-1', status: 'in_progress', output: [] }
        },
        {
          type: 'response.output_item.added',
          sequence_number: 1,
          output_index: 0,
          item: { ...functionCall, arguments: '', status: 'in_progress' }
        },
        {
          type: 'response.function_call_arguments.delta',
          sequence_number: 2,
          output_index: 0,
          item_id: 'fc-1',
          delta: '{"content":"candidate"}'
        },
        {
          type: 'response.output_item.done',
          sequence_number: 3,
          output_index: 0,
          item: functionCall
        },
        {
          type: 'response.completed',
          sequence_number: 4,
          response: {
            id: 'resp-1',
            status: 'completed',
            output: [functionCall],
            usage: {
              input_tokens: 10,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens: 3,
              output_tokens_details: { reasoning_tokens: 0 },
              total_tokens: 13
            }
          }
        }
      ])
    }) as typeof fetch
    const selected = modelStream(connection('openai_responses'), undefined, fetchImpl)

    const selectedModel = { ...selected.model, maxTokens: 12_000 }
    const result = await (await selected.streamFn(
      selectedModel,
      context(),
      { maxTokens: 7_000 }
    )).result()

    expect(request).toBeDefined()
    expect(request!.url).toBe('http://localhost:11434/v1/responses')
    expect(request!.headers.has('authorization')).toBe(false)
    expect(request!.body).toMatchObject({
      model: 'test-model',
      store: false,
      stream: true,
      max_output_tokens: 7_000
    })
    expect(JSON.stringify(request!.body.input)).toContain('SYSTEM INSTRUCTIONS')
    expect(result.stopReason).toBe('toolUse')
    expect(result.content).toContainEqual(expect.objectContaining({
      type: 'toolCall',
      name: 'record_test_result',
      arguments: { content: 'candidate' }
    }))
  })

  it('applies timeoutMs to one request without an implicit retry', async () => {
    const fetchImpl: typeof fetch = vi.fn((_input, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      const abort = (): void => reject(signal?.reason ?? new Error('request aborted'))
      if (signal?.aborted) abort()
      else signal?.addEventListener('abort', abort, { once: true })
    })) as typeof fetch
    const selected = modelStream(
      connection('openai_chat_completions'),
      undefined,
      fetchImpl
    )

    const result = await (await selected.streamFn(
      selected.model,
      context(),
      { timeoutMs: 10 }
    )).result()

    expect(result.stopReason).toBe('error')
    expect(result.errorMessage?.toLowerCase()).toContain('timed out')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('does not accept a tool call unless the provider explicitly finishes with tool_calls', async () => {
    const fetchImpl: typeof fetch = vi.fn(async () => sse([
      {
        id: 'chatcmpl-filtered',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'test-model',
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{
              index: 0,
              id: 'call-filtered',
              type: 'function',
              function: {
                name: 'record_test_result',
                arguments: '{"content":"must not execute"}'
              }
            }]
          },
          finish_reason: null
        }]
      },
      {
        id: 'chatcmpl-filtered',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'test-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'content_filter' }]
      }
    ])) as typeof fetch
    const selected = modelStream(
      connection('openai_chat_completions'),
      undefined,
      fetchImpl
    )

    const result = await (await selected.streamFn(selected.model, context())).result()

    expect(result.stopReason).toBe('error')
    expect(result.errorMessage).toContain('content_filter')
  })

  it('forwards Pi provider payload and response hooks', async () => {
    let request: Awaited<ReturnType<typeof requestDetails>> | undefined
    let responseStatus: number | undefined
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      request = await requestDetails(input, init)
      return sse([{
        id: 'chatcmpl-hooks',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'test-model',
        choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }]
      }])
    }) as typeof fetch
    const selected = modelStream(
      connection('openai_chat_completions'),
      'secret-key',
      fetchImpl
    )
    await (await selected.streamFn(selected.model, context(), {
      maxRetries: 0,
      headers: { 'x-oyster-extension': 'enabled' },
      onPayload: (payload) => ({ ...(payload as object), oyster_hook: true }),
      onResponse: (response) => { responseStatus = response.status }
    })).result()

    expect(request?.headers.get('x-oyster-extension')).toBe('enabled')
    expect(request?.body).toMatchObject({ oyster_hook: true })
    expect(responseStatus).toBe(200)
  })
})

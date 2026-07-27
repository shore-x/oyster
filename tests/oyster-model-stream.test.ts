import { describe, expect, it, vi } from 'vitest'
import { Type, type Context } from '@earendil-works/pi-ai'
import type { StoredModelConnection } from '../src/main/ai-backends/model'
import { createOysterModelRuntime } from '../src/main/knowledge-processing/oyster-model-stream'

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
  name: 'submit_knowledge_contribution',
  description: 'Submit the candidate.',
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
                function: { name: 'submit_knowledge_contribution', arguments: '{"content":' }
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
    const runtime = createOysterModelRuntime(
      connection('openai_chat_completions'),
      'secret-key',
      fetchImpl
    )

    const result = await (await runtime.streamFn(runtime.model, context(), { reasoning: 'high' })).result()

    expect(request).toBeDefined()
    expect(request!.url).toBe('http://localhost:11434/v1/chat/completions')
    expect(request!.method).toBe('POST')
    expect(request!.headers.get('authorization')).toBe('Bearer secret-key')
    expect(request!.body).toMatchObject({
      model: 'test-model',
      max_tokens: 4_096,
      messages: [
        { role: 'system', content: 'SYSTEM INSTRUCTIONS' },
        { role: 'user', content: 'Maintain this knowledge.' }
      ]
    })
    expect((request!.body.tools as Array<Record<string, unknown>>)).toHaveLength(1)
    expect(request!.body).not.toHaveProperty('reasoning_effort')
    expect(result.stopReason).toBe('toolUse')
    expect(result.content).toContainEqual(expect.objectContaining({
      type: 'toolCall',
      id: 'call-1',
      name: 'submit_knowledge_contribution',
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
    const runtime = createOysterModelRuntime({
      ...connection('openai_chat_completions', 'openai'),
      model: 'gpt-5-mini'
    }, 'secret-key', fetchImpl)
    const selectedModel = { ...runtime.model, maxTokens: 16_384 }

    await (await runtime.streamFn(selectedModel, context(), { maxTokens: 6_000 })).result()

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
    const runtime = createOysterModelRuntime({
      ...connection('openai_chat_completions', 'openai'),
      model: 'gpt-5-mini'
    }, 'secret-key', fetchImpl)

    await (await runtime.streamFn(runtime.model, context(), { reasoning: 'low' })).result()

    expect(runtime.model.reasoning).toBe(true)
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
        name: 'submit_knowledge_contribution',
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
    const runtime = createOysterModelRuntime(connection('openai_responses'), undefined, fetchImpl)

    const selectedModel = { ...runtime.model, maxTokens: 12_000 }
    const result = await (await runtime.streamFn(selectedModel, context(), { maxTokens: 7_000 })).result()

    expect(request).toBeDefined()
    expect(request!.url).toBe('http://localhost:11434/v1/responses')
    expect(request!.headers.has('authorization')).toBe(false)
    expect(request!.body).toMatchObject({
      model: 'test-model',
      instructions: 'SYSTEM INSTRUCTIONS',
      store: false,
      stream: true,
      max_output_tokens: 7_000
    })
    expect(JSON.stringify(request!.body.input)).not.toContain('SYSTEM INSTRUCTIONS')
    expect(result.stopReason).toBe('toolUse')
    expect(result.content).toContainEqual(expect.objectContaining({
      type: 'toolCall',
      name: 'submit_knowledge_contribution',
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
    const runtime = createOysterModelRuntime(
      connection('openai_chat_completions'),
      undefined,
      fetchImpl
    )

    const result = await (await runtime.streamFn(runtime.model, context(), { timeoutMs: 10 })).result()

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
                name: 'submit_knowledge_contribution',
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
    const runtime = createOysterModelRuntime(
      connection('openai_chat_completions'),
      undefined,
      fetchImpl
    )

    const result = await (await runtime.streamFn(runtime.model, context())).result()

    expect(result.stopReason).toBe('error')
    expect(result.errorMessage).toContain('content_filter')
  })

  it('rejects redirects and oversized responses without following them', async () => {
    const redirectedFetch: typeof fetch = vi.fn(async () => new Response(null, {
      status: 307,
      headers: { location: 'https://attacker.example/collect' }
    })) as typeof fetch
    const redirectedRuntime = createOysterModelRuntime(
      connection('openai_chat_completions'),
      'secret-key',
      redirectedFetch
    )
    const redirected = await (await redirectedRuntime.streamFn(
      redirectedRuntime.model,
      context()
    )).result()

    expect(redirected.stopReason).toBe('error')
    expect(redirected.errorMessage).toContain('重定向')
    expect(redirectedFetch).toHaveBeenCalledTimes(1)

    const oversizedFetch: typeof fetch = vi.fn(async () => new Response('ignored', {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'content-length': String(8 * 1_024 * 1_024 + 1)
      }
    })) as typeof fetch
    const oversizedRuntime = createOysterModelRuntime(
      connection('openai_chat_completions'),
      undefined,
      oversizedFetch
    )
    const oversized = await (await oversizedRuntime.streamFn(
      oversizedRuntime.model,
      context()
    )).result()

    expect(oversized.stopReason).toBe('error')
    expect(oversized.errorMessage).toContain('内容过大')
  })
})

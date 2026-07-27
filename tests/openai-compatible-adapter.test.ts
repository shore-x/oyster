import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { OpenAiCompatibleAdapter, normalizeModelBaseUrl } from '../src/main/ai-backends/openai-compatible-adapter'
import { ModelContextOverflowError, type StoredModelConnection } from '../src/main/ai-backends/model'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })))
})

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}/v1`
}

function connection(baseUrl: string): StoredModelConnection {
  return {
    id: 'model:test',
    adapterId: 'openai-compatible',
    providerId: 'openai_compatible',
    protocol: 'openai_chat_completions',
    baseUrl,
    model: 'test-model',
    credentialRef: 'model:test'
  }
}

describe('OpenAiCompatibleAdapter', () => {
  it('lists all standard model records, sends credentials only to the configured endpoint, and annotates known reasoning models', async () => {
    let authorization: string | undefined
    let requestPath: string | undefined
    const baseUrl = await listen((request, response) => {
      authorization = request.headers.authorization
      requestPath = request.url
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({
        object: 'list',
        data: [
          {
            id: 'gpt-5-mini',
            object: 'model',
            name: 'GPT-5 mini',
            context_window: 272_000,
            max_output_tokens: 128_000
          },
          {
            id: 'gpt-4.1-mini',
            object: 'model',
            context_length: -1,
            max_completion_tokens: 'unknown'
          },
          { id: 'gpt-5-mini', object: 'model' },
          { object: 'model' }
        ]
      }))
    })

    const result = await new OpenAiCompatibleAdapter().listModels(
      'openai',
      baseUrl,
      'secret-key'
    )

    expect(requestPath).toBe('/v1/models')
    expect(authorization).toBe('Bearer secret-key')
    expect(result.map((model) => model.id)).toEqual(['gpt-4.1-mini', 'gpt-5-mini'])
    expect(result.find((model) => model.id === 'gpt-4.1-mini')?.reasoningEfforts).toEqual([])
    expect(result.find((model) => model.id === 'gpt-5-mini')?.reasoningEfforts).toEqual([
      'minimal', 'low', 'medium', 'high'
    ])
    expect(result.find((model) => model.id === 'gpt-5-mini')).toMatchObject({
      contextWindowTokens: 272_000,
      maxOutputTokens: 128_000
    })
    expect(result.find((model) => model.id === 'gpt-4.1-mini')).not.toHaveProperty('contextWindowTokens')
    expect(result.find((model) => model.id === 'gpt-4.1-mini')).not.toHaveProperty('maxOutputTokens')
  })

  it('sends the key only to the configured endpoint and parses chat completion text', async () => {
    let authorization: string | undefined
    let requestPath: string | undefined
    let requestBody: Record<string, unknown> | undefined
    const baseUrl = await listen((request, response) => {
      authorization = request.headers.authorization
      requestPath = request.url
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk) => { body += chunk })
      request.on('end', () => {
        requestBody = JSON.parse(body) as Record<string, unknown>
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ choices: [{ message: { content: 'OYSTER' } }] }))
      })
    })

    const result = await new OpenAiCompatibleAdapter().generate(
      connection(baseUrl),
      'secret-key',
      { prompt: 'test', maxOutputTokens: 777 }
    )
    expect(result.text).toBe('OYSTER')
    expect(authorization).toBe('Bearer secret-key')
    expect(requestPath).toBe('/v1/chat/completions')
    expect(requestBody?.max_tokens).toBe(777)
  })

  it('does not follow redirects carrying authorization', async () => {
    const baseUrl = await listen((_request, response) => {
      response.statusCode = 302
      response.setHeader('location', 'https://example.com/collect')
      response.end()
    })
    await expect(new OpenAiCompatibleAdapter().generate(
      connection(baseUrl),
      'secret-key',
      { prompt: 'test' }
    )).rejects.toThrow('重定向')
  })

  it('uses the current OpenAI Chat Completions output-limit field for the OpenAI preset', async () => {
    let requestBody: Record<string, unknown> | undefined
    const baseUrl = await listen((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk) => { body += chunk })
      request.on('end', () => {
        requestBody = JSON.parse(body) as Record<string, unknown>
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ choices: [{ message: { content: 'OYSTER' } }] }))
      })
    })
    await new OpenAiCompatibleAdapter().generate(
      { ...connection(baseUrl), providerId: 'openai' },
      'secret-key',
      { prompt: 'test', maxOutputTokens: 321, reasoningEffort: 'high' }
    )

    expect(requestBody?.max_completion_tokens).toBe(321)
    expect(requestBody?.store).toBe(false)
    expect(requestBody).not.toHaveProperty('max_tokens')
    expect(requestBody).not.toHaveProperty('reasoning_effort')
  })

  it('sends reasoning effort only for a model whose capability is known', async () => {
    let requestBody: Record<string, unknown> | undefined
    const baseUrl = await listen((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk) => { body += chunk })
      request.on('end', () => {
        requestBody = JSON.parse(body) as Record<string, unknown>
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ output_text: 'OYSTER' }))
      })
    })

    await new OpenAiCompatibleAdapter().generate(
      {
        ...connection(baseUrl),
        providerId: 'openai',
        protocol: 'openai_responses',
        model: 'gpt-5-mini'
      },
      'secret-key',
      { prompt: 'test', reasoningEffort: 'low' }
    )

    expect(requestBody?.reasoning).toEqual({ effort: 'low' })
  })

  it('sends a system prompt separately from observation content for both protocols', async () => {
    const bodies: Record<string, unknown>[] = []
    const baseUrl = await listen((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk) => { body += chunk })
      request.on('end', () => {
        bodies.push(JSON.parse(body) as Record<string, unknown>)
        response.setHeader('content-type', 'application/json')
        response.end(request.url?.endsWith('/responses')
          ? JSON.stringify({ output_text: 'OYSTER' })
          : JSON.stringify({ choices: [{ message: { content: 'OYSTER' } }] }))
      })
    })
    const adapter = new OpenAiCompatibleAdapter()
    await adapter.generate(connection(baseUrl), 'secret-key', {
      systemPrompt: 'system instructions',
      prompt: 'untrusted observation'
    })
    await adapter.generate({ ...connection(baseUrl), protocol: 'openai_responses' }, 'secret-key', {
      systemPrompt: 'system instructions',
      prompt: 'untrusted observation'
    })

    expect(bodies[0].messages).toEqual([
      { role: 'system', content: 'system instructions' },
      { role: 'user', content: 'untrusted observation' }
    ])
    expect(bodies[1]).toMatchObject({
      instructions: 'system instructions',
      input: 'untrusted observation',
      store: false
    })
  })

  it('rejects responses that explicitly report truncated output', async () => {
    const baseUrl = await listen((request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(request.url?.endsWith('/responses')
        ? JSON.stringify({
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
            output_text: 'partial response'
          })
        : JSON.stringify({
            choices: [{ finish_reason: 'length', message: { content: 'partial response' } }]
          }))
    })
    const adapter = new OpenAiCompatibleAdapter()

    await expect(adapter.generate(connection(baseUrl), undefined, { prompt: 'test' }))
      .rejects.toThrow('不完整')
    await expect(adapter.generate(
      { ...connection(baseUrl), protocol: 'openai_responses' },
      undefined,
      { prompt: 'test' }
    )).rejects.toThrow('max_output_tokens')
  })

  it('classifies bounded provider context errors without treating other HTTP 400 failures as overflow', async () => {
    const payloads = [
      {
        error: {
          type: 'invalid_request_error',
          code: 'context_length_exceeded',
          message: 'Your input exceeds the context window of this model'
        }
      },
      { error: { message: 'invalid request syntax' } }
    ]
    const adapter = new OpenAiCompatibleAdapter(async () => new Response(
      JSON.stringify(payloads.shift()),
      { status: 400, headers: { 'content-type': 'application/json' } }
    ))

    await expect(adapter.generate(
      connection('http://localhost:11434/v1'),
      undefined,
      { prompt: 'oversized' }
    )).rejects.toBeInstanceOf(ModelContextOverflowError)
    await expect(adapter.generate(
      connection('http://localhost:11434/v1'),
      undefined,
      { prompt: 'invalid' }
    )).rejects.toThrow('HTTP 400')
  })

  it('classifies a Responses incomplete context reason separately from output exhaustion', async () => {
    const payloads = [
      { status: 'incomplete', incomplete_details: { reason: 'context_length_exceeded' } },
      { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }
    ]
    const adapter = new OpenAiCompatibleAdapter(async () => new Response(
      JSON.stringify(payloads.shift()),
      { status: 200, headers: { 'content-type': 'application/json' } }
    ))
    const responsesConnection = {
      ...connection('http://localhost:11434/v1'),
      protocol: 'openai_responses' as const
    }

    await expect(adapter.generate(responsesConnection, undefined, { prompt: 'oversized' }))
      .rejects.toBeInstanceOf(ModelContextOverflowError)
    let outputError: unknown
    try {
      await adapter.generate(responsesConnection, undefined, { prompt: 'valid input' })
    } catch (error) {
      outputError = error
    }
    expect(outputError).toBeInstanceOf(Error)
    expect(outputError).not.toBeInstanceOf(ModelContextOverflowError)
    expect((outputError as Error).message).toContain('max_output_tokens')
  })

  it('accepts compatible endpoints that omit completion status metadata', async () => {
    const baseUrl = await listen((request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(request.url?.endsWith('/responses')
        ? JSON.stringify({ output_text: 'RESPONSES' })
        : JSON.stringify({ choices: [{ message: { content: 'CHAT' } }] }))
    })
    const adapter = new OpenAiCompatibleAdapter()

    await expect(adapter.generate(connection(baseUrl), undefined, { prompt: 'test' }))
      .resolves.toEqual({ text: 'CHAT' })
    await expect(adapter.generate(
      { ...connection(baseUrl), protocol: 'openai_responses' },
      undefined,
      { prompt: 'test' }
    )).resolves.toEqual({ text: 'RESPONSES' })
  })

  it('rejects other explicit non-success response states and finish reasons', async () => {
    const payloads = [
      { status: 'failed', output_text: 'partial response' },
      { choices: [{ finish_reason: 'content_filter', message: { content: 'partial response' } }] }
    ]
    const adapter = new OpenAiCompatibleAdapter(async () => new Response(
      JSON.stringify(payloads.shift()),
      { status: 200, headers: { 'content-type': 'application/json' } }
    ))

    await expect(adapter.generate(
      { ...connection('http://localhost:11434/v1'), protocol: 'openai_responses' },
      undefined,
      { prompt: 'test' }
    )).rejects.toThrow('failed')
    await expect(adapter.generate(
      connection('http://localhost:11434/v1'),
      undefined,
      { prompt: 'test' }
    )).rejects.toThrow('content_filter')
  })

  it('allows local HTTP but rejects insecure remote and ambiguous URLs', () => {
    expect(normalizeModelBaseUrl('http://localhost:11434/v1/')).toBe('http://localhost:11434/v1')
    expect(() => normalizeModelBaseUrl('http://example.com/v1')).toThrow('HTTPS')
    expect(() => normalizeModelBaseUrl('https://user@example.com/v1')).toThrow('账号')
    expect(() => normalizeModelBaseUrl('https://example.com/v1?target=x')).toThrow('查询参数')
  })

  it('rejects unsafe output limits before sending a request', async () => {
    await expect(new OpenAiCompatibleAdapter().generate(
      connection('http://localhost:11434/v1'),
      undefined,
      { prompt: 'test', maxOutputTokens: 0 }
    )).rejects.toThrow('maxOutputTokens')
  })

  it('does not send a request when cancellation already happened', async () => {
    const controller = new AbortController()
    controller.abort()
    let requested = false
    const adapter = new OpenAiCompatibleAdapter(async () => {
      requested = true
      throw new Error('fetch must not run')
    })

    await expect(adapter.generate(
      connection('http://localhost:11434/v1'),
      'secret-key',
      { prompt: 'test', signal: controller.signal }
    )).rejects.toThrow()
    expect(requested).toBe(false)
  })

  it('bounds response bodies instead of buffering an unlimited provider response', async () => {
    const baseUrl = await listen((_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ choices: [{ message: { content: 'x'.repeat(4_096) } }] }))
    })
    await expect(new OpenAiCompatibleAdapter().generate(
      connection(baseUrl),
      undefined,
      { prompt: 'test', maxResponseBytes: 1_024 }
    )).rejects.toThrow('内容过大')
  })

  it('also bounds non-success response bodies used for context-error classification', async () => {
    const adapter = new OpenAiCompatibleAdapter(async () => new Response(
      JSON.stringify({ error: { message: 'x'.repeat(65 * 1_024) } }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    ))
    await expect(adapter.generate(
      connection('http://localhost:11434/v1'),
      undefined,
      { prompt: 'test' }
    )).rejects.toThrow('内容过大')
  })
})

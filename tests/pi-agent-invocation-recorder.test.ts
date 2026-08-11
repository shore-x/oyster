import { describe, expect, it } from 'vitest'
import { Agent } from '@earendil-works/pi-agent-core'
import {
  createAssistantMessageEventStream,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context
} from '@earendil-works/pi-ai'
import { createPiAgentInvocationRecorder } from '../src/main/agent-runtime/pi-agent-invocation-recorder'
import { AgentTodoStore, createAgentTodoTools } from '../src/main/agent-runtime/agent-todos'

describe('Pi Agent Invocation recorder', () => {
  it('captures the transformed Pi Context and final output at the StreamFn boundary', async () => {
    const faux = fauxProvider()
    faux.setResponses([fauxAssistantMessage('Recorded output.')])
    const models = createModels()
    models.setProvider(faux.provider)
    const receivedContexts: Context[] = []
    const recorder = createPiAgentInvocationRecorder({
      agentId: 'test_agent',
      invocationId: 'invocation:context'
    })
    const agent = new Agent({
      initialState: {
        systemPrompt: 'Recorder system prompt.',
        model: faux.getModel(),
        tools: createAgentTodoTools(new AgentTodoStore())
      },
      transformContext: async () => [{
        role: 'user',
        content: 'Transformed context only.',
        timestamp: 1
      }],
      streamFn: recorder.wrapStreamFn((model, context, options) => {
        receivedContexts.push(context)
        return models.streamSimple(model, context, options)
      })
    })
    recorder.attach(agent)

    await agent.prompt('Original prompt.')

    const invocation = recorder.snapshot()
    expect(agent.state.errorMessage).toBeUndefined()
    expect(receivedContexts[0].messages).toEqual([expect.objectContaining({
      role: 'user', content: 'Transformed context only.'
    })])
    expect(invocation.modelCalls).toHaveLength(1)
    expect(invocation.modelCalls[0].context).toMatchObject({
      systemPrompt: 'Recorder system prompt.',
      messages: [expect.objectContaining({ role: 'user', content: 'Transformed context only.' })]
    })
    expect(invocation.modelCalls[0].context.tools?.[0]).toMatchObject({
      name: 'add_todos',
      description: expect.any(String),
      parameters: expect.any(Object)
    })
    expect(JSON.stringify(invocation.modelCalls[0].context.tools)).not.toContain('executionMode')
    expect(invocation.modelCalls[0].output).toMatchObject({
      role: 'assistant',
      stopReason: 'stop',
      content: [{ type: 'text', text: 'Recorded output.' }]
    })
    expect(invocation.modelCalls[0].outputMessageId).toBe(
      invocation.messages.find((message) => message.role === 'assistant')?.id
    )
    expect(invocation.status).toBe('completed')
  })

  it('links tool activity to the requesting assistant message by toolCallId', async () => {
    const faux = fauxProvider()
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('list_todos', {}), { stopReason: 'toolUse' }),
      fauxAssistantMessage('Done.')
    ])
    const models = createModels()
    models.setProvider(faux.provider)
    const recorder = createPiAgentInvocationRecorder({
      agentId: 'test_agent',
      invocationId: 'invocation:tool'
    })
    const tools = createAgentTodoTools(new AgentTodoStore())
    const agent = new Agent({
      initialState: {
        systemPrompt: 'Use tools.',
        model: faux.getModel(),
        tools
      },
      streamFn: recorder.wrapStreamFn(
        (model, context, options) => models.streamSimple(model, context, options)
      ),
      toolExecution: 'sequential'
    })
    recorder.attach(agent)

    await agent.prompt('List Todos.')

    const invocation = recorder.snapshot()
    const tool = invocation.toolCalls[0]
    expect(tool).toMatchObject({ name: 'list_todos', status: 'completed', isError: false })
    expect(tool.assistantMessageId).toBeDefined()
    expect(invocation.messages.find((message) => message.id === tool.assistantMessageId)).toMatchObject({
      role: 'assistant'
    })
    expect(invocation.turns[0].toolCallIds).toEqual([tool.id])
  })

  it('marks compaction calls separately and omits credentials and transport callbacks', async () => {
    const faux = fauxProvider()
    faux.setResponses([fauxAssistantMessage('Summary.')])
    const models = createModels()
    models.setProvider(faux.provider)
    const recorder = createPiAgentInvocationRecorder({
      agentId: 'test_agent',
      invocationId: 'invocation:compaction'
    })
    const stream = await recorder.wrapStreamFn(
      (model, context, options) => models.streamSimple(model, context, options),
      'context_compaction'
    )(faux.getModel(), {
      systemPrompt: 'Compact.',
      messages: [{ role: 'user', content: 'Long context.', timestamp: 1 }]
    }, {
      maxTokens: 512,
      apiKey: 'must-not-be-recorded',
      headers: { authorization: 'must-not-be-recorded' },
      metadata: { secret: 'must-not-be-recorded' },
      onPayload: () => undefined
    })
    await stream.result()
    await Promise.resolve()

    const call = recorder.snapshot().modelCalls[0]
    expect(call.purpose).toBe('context_compaction')
    expect(call.options).toEqual({ maxTokens: 512 })
    expect(JSON.stringify(call)).not.toContain('must-not-be-recorded')
  })

  it('isolates failing observers from the Agent loop', async () => {
    const faux = fauxProvider()
    faux.setResponses([fauxAssistantMessage('Still completed.')])
    const models = createModels()
    models.setProvider(faux.provider)
    const recorder = createPiAgentInvocationRecorder({
      agentId: 'test_agent',
      invocationId: 'invocation:observer',
      onUpdate: () => { throw new Error('observer failed') }
    })
    const agent = new Agent({
      initialState: { systemPrompt: 'Continue.', model: faux.getModel(), tools: [] },
      streamFn: recorder.wrapStreamFn(
        (model, context, options) => models.streamSimple(model, context, options)
      )
    })
    recorder.attach(agent)

    await expect(agent.prompt('Start.')).resolves.toBeUndefined()
    expect(recorder.snapshot()).toMatchObject({ status: 'completed' })
  })

  it('captures the final provider payload, safe headers, and response metadata', async () => {
    const faux = fauxProvider()
    const recorder = createPiAgentInvocationRecorder({
      agentId: 'test_agent',
      invocationId: 'invocation:provider-debug'
    })
    const stream = await recorder.wrapStreamFn(async (model, _context, options) => {
      const payload = await options?.onPayload?.({ original: true }, model)
      await options?.onResponse?.({ status: 202, headers: { 'x-request-id': 'request-1' } }, model)
      const output = createAssistantMessageEventStream()
      output.end(fauxAssistantMessage(JSON.stringify(payload)))
      return output
    })(faux.getModel(), { messages: [] }, {
      headers: {
        authorization: 'Bearer secret',
        'x-extension-header': 'visible'
      },
      onPayload: (payload) => ({ ...(payload as object), extended: true })
    })
    await stream.result()
    await Promise.resolve()

    expect(recorder.snapshot().modelCalls[0]).toMatchObject({
      providerRequest: {
        payload: { original: true, extended: true },
        headers: {
          authorization: '[redacted]',
          'x-extension-header': 'visible'
        }
      },
      providerResponse: {
        status: 202,
        headers: { 'x-request-id': 'request-1' }
      }
    })
  })
})

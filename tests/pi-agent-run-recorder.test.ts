import { describe, expect, it } from 'vitest'
import { Agent } from '@earendil-works/pi-agent-core'
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context
} from '@earendil-works/pi-ai'
import {
  convertPiAgentMessages,
  createPiAgentRuntime
} from '../src/main/agent-runtime/pi-agent-runtime'

describe('Pi Agent run recorder', () => {
  it('captures the transformed Pi Context and final output at the StreamFn boundary', async () => {
    const faux = fauxProvider()
    faux.setResponses([fauxAssistantMessage('Recorded output.')])
    const models = createModels()
    models.setProvider(faux.provider)
    const receivedContexts: Context[] = []
    const runtime = createPiAgentRuntime({ agentId: 'test_agent', run: { runId: 'run:context' } })
    const agent = new Agent({
      initialState: {
        systemPrompt: 'Recorder system prompt.',
        model: faux.getModel(),
        tools: runtime.tools
      },
      transformContext: async () => [{
        role: 'user',
        content: 'Transformed context only.',
        timestamp: 1
      }],
      convertToLlm: convertPiAgentMessages,
      streamFn: runtime.run.wrapStreamFn((model, context, options) => {
        receivedContexts.push(context)
        return models.streamSimple(model, context, options)
      })
    })
    runtime.attach(agent)

    await agent.prompt('Original prompt.')

    const run = runtime.run.snapshot()
    expect(agent.state.errorMessage).toBeUndefined()
    expect(receivedContexts[0].messages).toEqual([expect.objectContaining({
      role: 'user', content: 'Transformed context only.'
    })])
    expect(run.modelCalls).toHaveLength(1)
    expect(run.modelCalls[0].context).toMatchObject({
      systemPrompt: 'Recorder system prompt.',
      messages: [expect.objectContaining({ role: 'user', content: 'Transformed context only.' })]
    })
    expect(run.modelCalls[0].context.tools?.[0]).toMatchObject({
      name: 'add_todos',
      description: expect.any(String),
      parameters: expect.any(Object)
    })
    expect(JSON.stringify(run.modelCalls[0].context.tools)).not.toContain('executionMode')
    expect(run.modelCalls[0].output).toMatchObject({
      role: 'assistant',
      stopReason: 'stop',
      content: [{ type: 'text', text: 'Recorded output.' }]
    })
    expect(run.modelCalls[0].outputMessageId).toBe(
      run.messages.find((message) => message.role === 'assistant')?.id
    )
    expect(run.status).toBe('completed')
  })

  it('links tool activity to the requesting assistant message by toolCallId', async () => {
    const faux = fauxProvider()
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('list_todos', {}), { stopReason: 'toolUse' }),
      fauxAssistantMessage('Done.')
    ])
    const models = createModels()
    models.setProvider(faux.provider)
    const runtime = createPiAgentRuntime({ agentId: 'test_agent', run: { runId: 'run:tool' } })
    const agent = new Agent({
      initialState: {
        systemPrompt: 'Use tools.',
        model: faux.getModel(),
        tools: runtime.tools
      },
      convertToLlm: convertPiAgentMessages,
      streamFn: runtime.run.wrapStreamFn(
        (model, context, options) => models.streamSimple(model, context, options)
      ),
      toolExecution: 'sequential'
    })
    runtime.attach(agent)

    await agent.prompt('List Todos.')

    const run = runtime.run.snapshot()
    const tool = run.toolCalls[0]
    expect(tool).toMatchObject({ name: 'list_todos', status: 'completed', isError: false })
    expect(tool.assistantMessageId).toBeDefined()
    expect(run.messages.find((message) => message.id === tool.assistantMessageId)).toMatchObject({
      role: 'assistant'
    })
    expect(run.turns[0].toolCallIds).toEqual([tool.id])
  })

  it('marks compaction calls separately and omits credentials and transport callbacks', async () => {
    const faux = fauxProvider()
    faux.setResponses([fauxAssistantMessage('Summary.')])
    const models = createModels()
    models.setProvider(faux.provider)
    const runtime = createPiAgentRuntime({ agentId: 'test_agent', run: { runId: 'run:compaction' } })
    const stream = await runtime.run.wrapStreamFn(
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

    const call = runtime.run.snapshot().modelCalls[0]
    expect(call.purpose).toBe('context_compaction')
    expect(call.options).toEqual({ maxTokens: 512 })
    expect(JSON.stringify(call)).not.toContain('must-not-be-recorded')
  })

  it('isolates failing observers from the Agent loop', async () => {
    const faux = fauxProvider()
    faux.setResponses([fauxAssistantMessage('Still completed.')])
    const models = createModels()
    models.setProvider(faux.provider)
    const runtime = createPiAgentRuntime({
      agentId: 'test_agent',
      run: {
        runId: 'run:observer',
        onUpdate: () => { throw new Error('observer failed') }
      }
    })
    const agent = new Agent({
      initialState: { systemPrompt: 'Continue.', model: faux.getModel(), tools: [] },
      convertToLlm: convertPiAgentMessages,
      streamFn: runtime.run.wrapStreamFn(
        (model, context, options) => models.streamSimple(model, context, options)
      )
    })
    runtime.attach(agent)

    await expect(agent.prompt('Start.')).resolves.toBeUndefined()
    expect(runtime.run.snapshot()).toMatchObject({ status: 'completed' })
  })
})

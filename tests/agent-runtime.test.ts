import { describe, expect, it } from 'vitest'
import { Agent } from '@earendil-works/pi-agent-core'
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
  type FauxResponseStep
} from '@earendil-works/pi-ai'
import { AgentTodoStore } from '../src/main/agent-runtime/agent-todos'
import {
  convertPiAgentMessages,
  createPiAgentRuntime,
  isAgentRuntimeFeedbackMessage,
  type PiAgentRuntimeOptions
} from '../src/main/agent-runtime/pi-agent-runtime'

function testAgent(
  responses: FauxResponseStep[],
  options: Omit<PiAgentRuntimeOptions, 'agentId'> = {}
) {
  const faux = fauxProvider()
  faux.setResponses(responses)
  const models = createModels()
  models.setProvider(faux.provider)
  const runtime = createPiAgentRuntime({ agentId: 'test_agent', ...options })
  const agent = new Agent({
    initialState: {
      systemPrompt: 'Test the general Agent Runtime.',
      model: faux.getModel(),
      tools: runtime.tools
    },
    streamFn: (model, context, streamOptions) => models.streamSimple(model, context, streamOptions),
    convertToLlm: convertPiAgentMessages,
    toolExecution: 'sequential'
  })
  runtime.attach(agent)
  return { agent, runtime, callCount: () => faux.state.callCount }
}

function contextText(context: Context): string {
  return JSON.stringify(context.messages)
}

describe('general Agent Runtime', () => {
  it('keeps a minimal, stable, and idempotent Host-owned Todo list', () => {
    const store = new AgentTodoStore([' Inspect evidence '])
    expect(store.list()).toEqual([{
      id: 'T000001',
      content: 'Inspect evidence',
      status: 'pending'
    }])

    expect(store.add(['Write draft', 'Review result']).map((todo) => todo.id))
      .toEqual(['T000002', 'T000003'])
    expect(store.complete(['T000002', 'T000002'])).toEqual([{
      id: 'T000002',
      content: 'Write draft',
      status: 'completed'
    }])
    expect(store.complete(['T000002'])).toEqual([{
      id: 'T000002',
      content: 'Write draft',
      status: 'completed'
    }])
    expect(store.pendingCount).toBe(2)
    expect(() => store.complete(['T999999'])).toThrow('Todo 不存在')
  })

  it('binds initial Todos without injecting them into the first model context and continues after a premature stop', async () => {
    const contexts: Context[] = []
    const prepared = testAgent([
      (context) => {
        contexts.push(context)
        expect(contextText(context)).not.toContain('Inspect the source')
        return fauxAssistantMessage(
          fauxToolCall('list_todos', {}),
          { stopReason: 'toolUse' }
        )
      },
      (context) => {
        contexts.push(context)
        expect(contextText(context)).toContain('T000001 [pending] Inspect the source')
        return fauxAssistantMessage('Finished too early.')
      },
      (context) => {
        contexts.push(context)
        expect(context.messages.at(-1)).toMatchObject({ role: 'user' })
        expect(contextText(context)).toContain('1 Todos remain pending')
        return fauxAssistantMessage(
          fauxToolCall('complete_todos', { ids: ['T000001'] }),
          { stopReason: 'toolUse' }
        )
      },
      fauxAssistantMessage('Finished after completing the Todo.')
    ], { initialTodos: ['Inspect the source'] })

    await prepared.agent.prompt('Start the task.')

    expect(prepared.callCount()).toBe(4)
    expect(prepared.runtime.todos.pendingCount).toBe(0)
    expect(prepared.agent.state.messages.some(isAgentRuntimeFeedbackMessage)).toBe(true)
    expect(contexts).toHaveLength(3)
  })

  it('combines independent end-check reasons in one Runtime feedback message', async () => {
    let externalWorkPending = true
    const prepared = testAgent([
      fauxAssistantMessage('Stopping too early.'),
      (context) => {
        const feedback = contextText(context)
        expect(feedback).toContain('1 Todos remain pending')
        expect(feedback).toContain('The draft still requires review')
        externalWorkPending = false
        return fauxAssistantMessage(
          fauxToolCall('complete_todos', { ids: ['T000001'] }),
          { stopReason: 'toolUse' }
        )
      },
      fauxAssistantMessage('All work is done.')
    ], {
      initialTodos: ['Finish the work'],
      endChecks: [() => externalWorkPending ? 'The draft still requires review.' : undefined]
    })

    await prepared.agent.prompt('Start.')
    expect(prepared.callCount()).toBe(3)
  })

  it('lets an already queued message run before adding Runtime feedback', async () => {
    let prepared: ReturnType<typeof testAgent>
    prepared = testAgent([
      () => {
        prepared.agent.followUp({
          role: 'user',
          content: [{ type: 'text', text: 'Queued user follow-up.' }],
          timestamp: Date.now()
        })
        return fauxAssistantMessage('First stop.')
      },
      (context) => {
        expect(contextText(context)).toContain('Queued user follow-up')
        expect(contextText(context)).not.toContain('The Agent cannot finish yet')
        return fauxAssistantMessage('Second stop.')
      },
      (context) => {
        expect(contextText(context)).toContain('The Agent cannot finish yet')
        return fauxAssistantMessage(
          fauxToolCall('complete_todos', { ids: ['T000001'] }),
          { stopReason: 'toolUse' }
        )
      },
      fauxAssistantMessage('Done.')
    ], { initialTodos: ['Pending work'] })

    await prepared.agent.prompt('Start.')

    expect(prepared.callCount()).toBe(4)
    expect(prepared.agent.state.messages.filter(isAgentRuntimeFeedbackMessage)).toHaveLength(1)
  })

  it('does not retry failed or aborted model turns', async () => {
    const prepared = testAgent([
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'provider failed' })
    ], { initialTodos: ['Unfinished work'] })

    await prepared.agent.prompt('Start.')
    expect(prepared.callCount()).toBe(1)
    expect(prepared.runtime.todos.pendingCount).toBe(1)
    expect(prepared.agent.state.messages.some(isAgentRuntimeFeedbackMessage)).toBe(false)
  })
})

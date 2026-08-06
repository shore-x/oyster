import { describe, expect, it } from 'vitest'
import {
  createAssistantMessageEventStream,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Api,
  type AssistantMessage,
  type Context,
  type FauxResponseStep,
  type Model,
  type Usage
} from '@earendil-works/pi-ai'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import {
  ModelConnectionFailureError,
  ModelOutputTruncatedError
} from '../src/main/ai-backends/model'
import type { ModelRuntime } from '../src/main/ai-backends/model'
import type {
  KnowledgeAgentRunInput,
  KnowledgeAgentWorkspaceStatus,
  KnowledgeReader,
  KnowledgeStatementRecord
} from '../src/main/knowledge-processing/model'
import { PiKnowledgeMaintenanceAgent } from '../src/main/knowledge-processing/pi-knowledge-agent'
import type { KnowledgeStatement, KnowledgeStatementDraft } from '../src/shared/knowledge'

const TOOL_NAMES = [
  'search_knowledge',
  'read_knowledge',
  'upsert_contribution_statement',
  'read_contribution_statement',
  'list_contribution_statements',
  'remove_contribution_statement',
  'read_evidence',
  'add_todos',
  'complete_todos',
  'list_todos'
]

class MemoryKnowledgeReader implements KnowledgeReader {
  readonly searchCalls: Array<{ query: string; limit: number; offset?: number }> = []
  readonly readCalls: string[] = []

  constructor(private readonly records: KnowledgeStatementRecord[] = []) {}

  async search(
    query: string,
    limit: number,
    offset = 0,
    signal?: AbortSignal
  ): Promise<KnowledgeStatementRecord[]> {
    signal?.throwIfAborted()
    this.searchCalls.push({ query, limit, ...(offset ? { offset } : {}) })
    return this.records.slice(offset, offset + limit)
  }

  async read(title: string, signal?: AbortSignal): Promise<KnowledgeStatement | undefined> {
    signal?.throwIfAborted()
    this.readCalls.push(title)
    return this.records.find((candidate) => candidate.title === title)
  }
}

function runInput(overrides: Partial<KnowledgeAgentRunInput> = {}): KnowledgeAgentRunInput {
  return {
    runtime: {
      model: { id: 'unconfigured-test-model' } as Model<Api>,
      streamFn: (() => { throw new Error('test must supply a Model Runtime') }) as StreamFn
    },
    systemPrompt: 'Maintain knowledge using only authorized tools.',
    evidenceLines: [
      'Project P uses the local database for durable statements.',
      'The user says the database is SQLite, not a graph database.'
    ],
    evidenceFormatVersion: 'test-v1',
    sourceRef: 'observation:test:1',
    contributionRunRef: 'test-run:1',
    runId: 'agent-run:1',
    attention: 'Track local names and their referents.',
    signal: new AbortController().signal,
    ...overrides
  }
}

function toolResponse(
  statements: KnowledgeStatementDraft[] = [],
  completedTodoIds: string[] = []
) {
  return fauxAssistantMessage([
    ...statements.map((statement) => fauxToolCall('upsert_contribution_statement', statement)),
    ...(completedTodoIds.length
      ? [fauxToolCall('complete_todos', { ids: completedTodoIds })]
      : [])
  ], { stopReason: 'toolUse' })
}

function fauxRuntime(responses: FauxResponseStep[], reasoning = false): {
  runtime: ModelRuntime
  callCount(): number
  reasoningCalls: Array<string | undefined>
} {
  const faux = fauxProvider()
  faux.setResponses(responses)
  const models = createModels()
  models.setProvider(faux.provider)
  const reasoningCalls: Array<string | undefined> = []
  return {
    runtime: {
      model: { ...faux.getModel(), reasoning },
      streamFn: (model, context, options) => {
        reasoningCalls.push(options?.reasoning)
        return models.streamSimple(model, context, options)
      }
    },
    callCount: () => faux.state.callCount,
    reasoningCalls
  }
}

function toolResults(context: Context) {
  return context.messages.flatMap((message) => message.role === 'toolResult' ? [message] : [])
}

function lastToolResult(context: Context) {
  const result = toolResults(context).at(-1)
  if (!result) throw new Error('Expected a tool result')
  return result
}

function textContent(message: ReturnType<typeof lastToolResult>): string {
  return message.content.flatMap((content) => content.type === 'text' ? [content.text] : []).join('\n')
}

function contextText(context: Context): string {
  return JSON.stringify(context.messages)
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

function waitingRuntime(model: Model<Api>): ModelRuntime {
  return {
    model,
    streamFn: (requestedModel, _context, options) => {
      const stream = createAssistantMessageEventStream()
      const abort = (): void => {
        const output: AssistantMessage = {
          role: 'assistant',
          content: [],
          api: requestedModel.api,
          provider: requestedModel.provider,
          model: requestedModel.id,
          usage: emptyUsage(),
          stopReason: 'aborted',
          errorMessage: 'aborted',
          timestamp: Date.now()
        }
        stream.push({ type: 'error', reason: 'aborted', error: output })
        stream.end(output)
      }
      if (options?.signal?.aborted) abort()
      else options?.signal?.addEventListener('abort', abort, { once: true })
      return stream
    }
  }
}

describe('PiKnowledgeMaintenanceAgent', () => {
  it('binds Host initial Todos without eagerly loading them into context', async () => {
    const workspaceUpdates: KnowledgeAgentWorkspaceStatus[] = []
    const runtime = fauxRuntime([
      (context) => {
        expect(context.tools?.map((tool) => tool.name)).toEqual(TOOL_NAMES)
        expect(contextText(context)).not.toContain('T000001')
        expect(contextText(context)).not.toContain('Investigate database')
        expect(contextText(context)).not.toContain('The user says the database is SQLite')
        return fauxAssistantMessage(fauxToolCall('list_todos', {}), { stopReason: 'toolUse' })
      },
      (context) => {
        const todoList = textContent(lastToolResult(context))
        expect(todoList).toContain('T000001 [pending]')
        expect(todoList).toContain('Investigate database at L000001:C0')
        return fauxAssistantMessage(
          fauxToolCall('read_evidence', { line: 1, offset: 0, limit: 1_000 }),
          { stopReason: 'toolUse' }
        )
      },
      (context) => {
        expect(textContent(lastToolResult(context))).toContain('Project P uses the local database')
        return toolResponse([{
          title: 'Project P 的本地数据库',
          content: '[[Project P]] 使用 SQLite 作为保存 Knowledge Statement 的本地数据库。'
        }], ['T000001'])
      },
      fauxAssistantMessage('The Draft is ready for Host review.')
    ])

    const result = await new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader()).run(runInput({
      runtime: runtime.runtime,
      initialTodos: ['Investigate database at L000001:C0'],
      onWorkspaceStatus: (status) => workspaceUpdates.push(status)
    }))

    expect(result.contribution.statements).toEqual([{
      title: 'Project P 的本地数据库',
      content: '[[Project P]] 使用 SQLite 作为保存 Knowledge Statement 的本地数据库。'
    }])
    expect(result.todos).toEqual([expect.objectContaining({
      id: 'T000001',
      status: 'completed',
      content: expect.stringContaining('database')
    })])
    expect(result.modelCallCount).toBe(4)
    expect(result.toolCalls).toEqual([
      'list_todos',
      'read_evidence',
      'upsert_contribution_statement',
      'complete_todos'
    ])
    expect(workspaceUpdates).toContainEqual(expect.objectContaining({
      todos: { total: 1, pending: 0, completed: 1 },
      draftStatementCount: 1
    }))
  })

  it('freezes the whole Draft after normal Agent completion without a submit tool', async () => {
    const runtime = fauxRuntime([fauxAssistantMessage('No durable knowledge change is needed.')])
    const result = await new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader()).run(runInput({
      runtime: runtime.runtime
    }))

    expect(result.contribution).toEqual({ runRef: 'test-run:1', statements: [] })
    expect(result.toolCalls).toEqual([])
    expect(runtime.callCount()).toBe(1)
  })

  it('does not freeze a Draft after an output-length stop', async () => {
    const runtime = fauxRuntime([
      fauxAssistantMessage('This final response is incomplete.', { stopReason: 'length' })
    ])

    await expect(new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader()).run(runInput({
      runtime: runtime.runtime
    }))).rejects.toBeInstanceOf(ModelOutputTruncatedError)
  })

  it('uses a Pi follow-up when the model stops naturally with pending Todos', async () => {
    const runtime = fauxRuntime([
      fauxAssistantMessage('I am done.'),
      (context) => {
        expect(contextText(context)).toContain('The Agent cannot finish yet')
        expect(contextText(context)).toContain('1 Todos remain pending')
        return toolResponse([], ['T000001'])
      },
      fauxAssistantMessage('All work is complete.')
    ])

    const result = await new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader()).run(runInput({
      runtime: runtime.runtime,
      initialTodos: ['Finish the internal plan']
    }))

    expect(result.modelCallCount).toBe(3)
    expect(result.todos).toEqual([{
      id: 'T000001',
      content: 'Finish the internal plan',
      status: 'completed'
    }])
  })

  it('lets the Agent add Todos and stage, inspect, replace, and remove Draft statements', async () => {
    const runtime = fauxRuntime([
      fauxAssistantMessage(fauxToolCall('add_todos', {
        todos: ['Investigate the scope identified by Project P.']
      }), { stopReason: 'toolUse' }),
      fauxAssistantMessage([
        fauxToolCall('upsert_contribution_statement', { title: 'A', content: 'First.' }),
        fauxToolCall('upsert_contribution_statement', { title: 'B', content: 'Temporary.' })
      ], { stopReason: 'toolUse' }),
      fauxAssistantMessage(
        fauxToolCall('list_contribution_statements', { limit: 1 }),
        { stopReason: 'toolUse' }
      ),
      (context) => {
        expect(textContent(lastToolResult(context))).toContain('Next offset: 1')
        return fauxAssistantMessage(
          fauxToolCall('read_contribution_statement', { title: 'A' }),
          { stopReason: 'toolUse' }
        )
      },
      (context) => {
        expect(textContent(lastToolResult(context))).toContain('First.')
        return fauxAssistantMessage([
          fauxToolCall('upsert_contribution_statement', { title: 'A', content: 'Current.' }),
          fauxToolCall('remove_contribution_statement', { title: 'B' }),
          fauxToolCall('complete_todos', { ids: ['T000001', 'T000002'] })
        ], { stopReason: 'toolUse' })
      },
      fauxAssistantMessage('Draft complete.')
    ])

    const result = await new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader()).run(runInput({
      runtime: runtime.runtime,
      initialTodos: ['Inspect the evidence']
    }))

    expect(result.contribution.statements).toEqual([{ title: 'A', content: 'Current.' }])
    expect(result.todos).toHaveLength(2)
    expect(result.todos.every((todo) => todo.status === 'completed')).toBe(true)
  })

  it('searches with pagination and reads a Statement by exact canonical title', async () => {
    const reader = new MemoryKnowledgeReader([
      { title: 'A', content: 'One.' },
      { title: 'B', content: 'Two references [[A]].' },
      { title: 'C', content: 'Three.' }
    ])
    const runtime = fauxRuntime([
      fauxAssistantMessage(
        fauxToolCall('search_knowledge', { query: 'subject', limit: 2 }),
        { stopReason: 'toolUse' }
      ),
      (context) => {
        expect(textContent(lastToolResult(context))).toContain('Next offset: 2')
        return fauxAssistantMessage(
          fauxToolCall('search_knowledge', { query: 'subject', limit: 2, offset: 2 }),
          { stopReason: 'toolUse' }
        )
      },
      (context) => {
        expect(textContent(lastToolResult(context))).toContain('标题: C')
        return fauxAssistantMessage(
          fauxToolCall('read_knowledge', { title: 'B' }),
          { stopReason: 'toolUse' }
        )
      },
      (context) => {
        expect(textContent(lastToolResult(context))).toContain('Two references [[A]].')
        return fauxAssistantMessage('No Draft changes needed.')
      }
    ])

    await new PiKnowledgeMaintenanceAgent(reader).run(runInput({ runtime: runtime.runtime }))
    expect(reader.searchCalls).toEqual([
      { query: 'subject', limit: 2 },
      { query: 'subject', limit: 2, offset: 2 }
    ])
    expect(reader.readCalls).toEqual(['B'])
  })

  it('keeps evidence reads bounded and continues from UTF-16 locations without splitting a surrogate pair', async () => {
    const runtime = fauxRuntime([
      fauxAssistantMessage(
        fauxToolCall('read_evidence', { line: 1, offset: 0, limit: 2 }),
        { stopReason: 'toolUse' }
      ),
      (context) => {
        const first = textContent(lastToolResult(context))
        expect(first).toContain('A')
        expect(first).toContain('Next: L000001:C1')
        return fauxAssistantMessage(
          fauxToolCall('read_evidence', { line: 1, offset: 1, limit: 2 }),
          { stopReason: 'toolUse' }
        )
      },
      (context) => {
        const second = textContent(lastToolResult(context))
        expect(second).toContain('😀')
        expect(second).not.toContain('�')
        return fauxAssistantMessage('Evidence checked.')
      }
    ])

    await new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader()).run(runInput({
      runtime: runtime.runtime,
      evidenceLines: ['A😀B']
    }))
  })

  it('keeps the external Todo list and Draft available after context compaction', async () => {
    const faux = fauxProvider()
    const model = { ...faux.getModel(), contextWindow: 8_000, maxTokens: 512 }
    const largeBody = 'durable detail '.repeat(2_000)
    let normalCalls = 0
    let compactionCalls = 0
    const runtime: ModelRuntime = {
      model,
      streamFn: (_requestedModel, context) => {
        const stream = createAssistantMessageEventStream()
        if (context.systemPrompt?.startsWith('You compact an agent')) {
          compactionCalls++
          stream.end(fauxAssistantMessage('A draft was staged; inspect external run state.'))
          return stream
        }
        normalCalls++
        if (normalCalls === 1) {
          stream.end(fauxAssistantMessage(
            fauxToolCall('upsert_contribution_statement', { title: 'Large draft', content: largeBody }),
            { stopReason: 'toolUse' }
          ))
          return stream
        }
        if (normalCalls === 2) {
          stream.end(fauxAssistantMessage(fauxToolCall('list_todos', {}), { stopReason: 'toolUse' }))
          return stream
        }
        if (normalCalls === 3) {
          expect(textContent(lastToolResult(context))).toContain('T000001 [pending]')
          stream.end(fauxAssistantMessage(
            fauxToolCall('list_contribution_statements', {}),
            { stopReason: 'toolUse' }
          ))
          return stream
        }
        if (normalCalls === 4) {
          expect(textContent(lastToolResult(context))).toContain('Large draft')
          stream.end(toolResponse([], ['T000001']))
          return stream
        }
        stream.end(fauxAssistantMessage('Draft complete.'))
        return stream
      }
    }

    const result = await new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader()).run(runInput({
      runtime,
      initialTodos: ['Inspect the evidence']
    }))

    expect(normalCalls).toBe(5)
    expect(compactionCalls).toBeGreaterThan(0)
    expect(result.modelCallCount).toBe(normalCalls + compactionCalls)
    expect(result.contribution.statements[0].content).toBe(largeBody)
  })

  it('has no fixed model-call, tool-call, or Draft Statement quota', async () => {
    const searches = Array.from({ length: 12 }, (_, index) => fauxAssistantMessage(
      fauxToolCall('search_knowledge', { query: `query-${index}` }),
      { stopReason: 'toolUse' }
    ))
    const statements = Array.from({ length: 64 }, (_, index) => ({
      title: `Statement ${index + 1}`,
      content: `Knowledge ${index + 1}`
    }))
    const runtime = fauxRuntime([
      ...searches,
      toolResponse(statements),
      fauxAssistantMessage('Draft complete.')
    ])

    const result = await new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader()).run(runInput({
      runtime: runtime.runtime
    }))

    expect(result.modelCallCount).toBe(14)
    expect(result.toolCalls.filter((name) => name === 'search_knowledge')).toHaveLength(12)
    expect(result.contribution.statements).toHaveLength(64)
  })

  it('lets the normal Agent recover from tool validation and Knowledge Reader failures', async () => {
    const reader: KnowledgeReader = {
      search: async () => { throw new Error('temporary search failure') },
      read: async () => undefined
    }
    const runtime = fauxRuntime([
      fauxAssistantMessage(
        fauxToolCall('read_evidence', { line: 999, offset: 0, limit: 10 }),
        { stopReason: 'toolUse' }
      ),
      fauxAssistantMessage(
        fauxToolCall('search_knowledge', { query: 'retry' }),
        { stopReason: 'toolUse' }
      ),
      fauxAssistantMessage('Recovered without a Draft change.')
    ])

    const result = await new PiKnowledgeMaintenanceAgent(reader).run(runInput({
      runtime: runtime.runtime
    }))

    expect(result.modelCallCount).toBe(3)
    expect(result.run.toolCalls).toContainEqual(expect.objectContaining({
      name: 'read_evidence', status: 'failed'
    }))
    expect(result.run.toolCalls).toContainEqual(expect.objectContaining({
      name: 'search_knowledge', status: 'failed'
    }))
  })

  it('keeps unknown model-generated tool calls visible in the generic run record', async () => {
    const runtime = fauxRuntime([
      fauxAssistantMessage(
        fauxToolCall('secret_internal_tool_name', { secret: 'do-not-log' }),
        { stopReason: 'toolUse' }
      ),
      fauxAssistantMessage('Finished.')
    ])

    const result = await new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader()).run(runInput({
      runtime: runtime.runtime
    }))

    expect(result.toolCalls).toEqual(['secret_internal_tool_name'])
    expect(result.run.toolCalls[0]).toMatchObject({
      name: 'secret_internal_tool_name',
      input: { secret: 'do-not-log' },
      status: 'failed'
    })
  })

  it('isolates diagnostic callbacks and forwards reasoning only to reasoning models', async () => {
    const supported = fauxRuntime([fauxAssistantMessage('Finished.')], true)
    const unsupported = fauxRuntime([fauxAssistantMessage('Finished.')], false)

    await expect(new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader()).run(runInput({
      runtime: supported.runtime,
      reasoningEffort: 'high',
      onRunUpdate: () => { throw new Error('trace sink failed') }
    }))).resolves.toBeDefined()
    await new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader()).run(runInput({
      runtime: unsupported.runtime,
      reasoningEffort: 'high'
    }))

    expect(supported.reasoningCalls).toEqual(['high'])
    expect(unsupported.reasoningCalls).toEqual([undefined])
  })

  it('surfaces model runtime errors as connection failures', async () => {
    const runtime = fauxRuntime([
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'provider failed' })
    ])

    await expect(new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader()).run(runInput({
      runtime: runtime.runtime
    }))).rejects.toBeInstanceOf(ModelConnectionFailureError)
  })

  it('propagates an external abort to the active Pi run', async () => {
    const controller = new AbortController()
    const model = fauxProvider().getModel()
    const run = new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader()).run(runInput({
      runtime: waitingRuntime(model),
      signal: controller.signal
    }))

    controller.abort(new Error('cancelled by test'))
    await expect(run).rejects.toThrow('cancelled by test')
  })
})

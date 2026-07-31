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
import { ModelConnectionFailureError } from '../src/main/ai-backends/model'
import type { ModelRuntime } from '../src/main/ai-backends/model'
import type {
  KnowledgeAgentRunInput,
  KnowledgeAgentTraceEvent,
  KnowledgeReader,
  KnowledgeStatementRecord
} from '../src/main/knowledge-processing/model'
import { PiKnowledgeMaintenanceAgent } from '../src/main/knowledge-processing/pi-knowledge-agent'
import type { KnowledgeStatement, KnowledgeStatementDraft } from '../src/shared/knowledge'

const TOOL_NAMES = [
  'search_knowledge',
  'read_knowledge',
  'list_statement_candidates',
  'add_statement_candidates',
  'resolve_statement_candidates',
  'upsert_contribution_statement',
  'read_contribution_statement',
  'list_contribution_statements',
  'remove_contribution_statement',
  'read_evidence',
  'submit_knowledge_contribution'
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
      streamFn: (() => {
        throw new Error('test must supply a Model Runtime')
      }) as StreamFn
    },
    systemPrompt: 'Maintain knowledge using only authorized tools.',
    statementCandidates: [],
    observationLines: [
      'Project P uses the local database for durable statements.',
      'The user says the database is SQLite, not a graph database.'
    ],
    observationFormatVersion: 'test-v1',
    sourceRef: 'observation:test:1',
    contributionRunRef: 'test-run:1',
    attention: 'Track local names and their referents.',
    signal: new AbortController().signal,
    ...overrides
  }
}

function candidate(expression = 'database') {
  return {
    expression,
    question: `What does ${expression} denote in Project P?`,
    locations: [{ line: 1, offset: 0 }]
  }
}

function finalTools(
  statements: KnowledgeStatementDraft[] = [],
  resolutions: Array<{ ref: string; resolution: string }> = []
) {
  return [
    ...statements.map((statement) => fauxToolCall('upsert_contribution_statement', statement)),
    ...(resolutions.length
      ? [fauxToolCall('resolve_statement_candidates', { resolutions })]
      : []),
    fauxToolCall('submit_knowledge_contribution', {})
  ]
}

function finalResponse(
  statements: KnowledgeStatementDraft[] = [],
  resolutions: Array<{ ref: string; resolution: string }> = []
) {
  return fauxAssistantMessage(finalTools(statements, resolutions), { stopReason: 'toolUse' })
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
  it('runs discovery adjudication with fresh workspace state and without eagerly loading raw evidence', async () => {
    const traces: KnowledgeAgentTraceEvent[] = []
    const runtime = fauxRuntime([
      (context) => {
        expect(context.tools?.map((tool) => tool.name)).toEqual(TOOL_NAMES)
        const upsertTool = context.tools?.find((tool) => tool.name === 'upsert_contribution_statement')
        expect(upsertTool?.description).toContain('title names one searchable subject')
        expect(JSON.stringify(upsertTool?.parameters)).toContain('natural noun phrase')
        expect(JSON.stringify(upsertTool?.parameters)).toContain('relationships in content')
        expect(contextText(context)).toContain('<knowledge-maintenance-workspace-status>')
        expect(contextText(context)).toContain('Candidates: 1 total; 1 open; 0 resolved.')
        expect(contextText(context)).toContain('database')
        expect(contextText(context)).not.toContain('The user says the database is SQLite')
        return fauxAssistantMessage(
          fauxToolCall('list_statement_candidates', { status: 'open' }),
          { stopReason: 'toolUse' }
        )
      },
      (context) => {
        expect(textContent(lastToolResult(context))).toContain('C000001 [open] database')
        return fauxAssistantMessage(
          fauxToolCall('read_evidence', { line: 1, offset: 0, limit: 1_000 }),
          { stopReason: 'toolUse' }
        )
      },
      (context) => {
        expect(textContent(lastToolResult(context))).toContain('Project P uses the local database')
        return finalResponse([{
          title: 'Project P 的本地数据库',
          content: '[[Project P]] 使用 SQLite 作为保存 Knowledge Statement 的本地数据库。'
        }], [{ ref: 'C000001', resolution: 'Covered by [[Project P 的本地数据库]].' }])
      }
    ])

    const result = await new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader()).run(runInput({
      runtime: runtime.runtime,
      statementCandidates: [candidate()],
      onTrace: (event) => traces.push(event)
    }))

    expect(result.contribution.statements).toEqual([{
      title: 'Project P 的本地数据库',
      content: '[[Project P]] 使用 SQLite 作为保存 Knowledge Statement 的本地数据库。'
    }])
    expect(result.statementCandidates).toEqual([expect.objectContaining({
      ref: 'C000001',
      expression: 'database',
      status: 'resolved'
    })])
    expect(result.modelCallCount).toBe(3)
    expect(result.toolCalls).toEqual([
      'list_statement_candidates',
      'read_evidence',
      'upsert_contribution_statement',
      'resolve_statement_candidates',
      'submit_knowledge_contribution'
    ])
    expect(traces).toContainEqual(expect.objectContaining({
      type: 'workspace_status',
      candidates: { total: 1, open: 0, resolved: 1 },
      draftStatementCount: 1
    }))
    expect(traces).toContainEqual(expect.objectContaining({
      type: 'model_completed',
      output: expect.stringContaining('Tool call · list_statement_candidates')
    }))
    expect(traces).toContainEqual(expect.objectContaining({
      type: 'tool_started',
      toolName: 'read_evidence',
      input: expect.stringContaining('"line": 1')
    }))
    expect(traces).toContainEqual(expect.objectContaining({
      type: 'tool_completed',
      toolName: 'read_evidence',
      output: expect.stringContaining('The user says the database is SQLite')
    }))
  })

  it('keeps a premature submission nonterminal until every open candidate is resolved', async () => {
    const runtime = fauxRuntime([
      fauxAssistantMessage(fauxToolCall('submit_knowledge_contribution', {}), { stopReason: 'toolUse' }),
      (context) => {
        expect(textContent(lastToolResult(context))).toContain('1 Statement candidates remain open')
        return finalResponse([], [{
          ref: 'C000001',
          resolution: 'No durable knowledge is supported by the evidence.'
        }])
      }
    ])

    const result = await new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader()).run(runInput({
      runtime: runtime.runtime,
      statementCandidates: [candidate()]
    }))

    expect(result.modelCallCount).toBe(2)
    expect(result.contribution.statements).toEqual([])
    expect(result.statementCandidates[0]).toMatchObject({ status: 'resolved' })
  })

  it('uses Pi follow-up when the model stops naturally before submission', async () => {
    const runtime = fauxRuntime([
      fauxAssistantMessage('I am done.'),
      (context) => {
        expect(contextText(context)).toContain('has not been submitted')
        return finalResponse([{ title: 'Recovered Statement', content: 'The harness continued the run.' }])
      }
    ])

    const result = await new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader()).run(runInput({
      runtime: runtime.runtime
    }))

    expect(result.modelCallCount).toBe(2)
    expect(result.contribution.statements[0].title).toBe('Recovered Statement')
  })

  it('lets the Agent expand the open agenda and stage, inspect, replace, and remove drafts', async () => {
    const runtime = fauxRuntime([
      fauxAssistantMessage(fauxToolCall('add_statement_candidates', {
        candidates: [{
          expression: 'Project P',
          question: 'What scope does Project P identify?',
          locations: [{ line: 1, offset: 0 }]
        }]
      }), { stopReason: 'toolUse' }),
      fauxAssistantMessage([
        fauxToolCall('upsert_contribution_statement', { title: 'A', content: 'First.' }),
        fauxToolCall('upsert_contribution_statement', { title: 'B', content: 'Temporary.' })
      ], { stopReason: 'toolUse' }),
      (context) => {
        expect(contextText(context)).toContain('Contribution Draft: 2 Statements.')
        return fauxAssistantMessage(
          fauxToolCall('list_contribution_statements', { limit: 1 }),
          { stopReason: 'toolUse' }
        )
      },
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
          fauxToolCall('remove_contribution_statement', { title: 'B' })
        ], { stopReason: 'toolUse' })
      },
      finalResponse([], [
        { ref: 'C000001', resolution: 'Covered by A.' },
        { ref: 'C000002', resolution: 'Supplies the scope needed by A.' }
      ])
    ])

    const result = await new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader()).run(runInput({
      runtime: runtime.runtime,
      statementCandidates: [candidate()]
    }))

    expect(result.contribution.statements).toEqual([{ title: 'A', content: 'Current.' }])
    expect(result.statementCandidates).toHaveLength(2)
    expect(result.statementCandidates.every((item) => item.status === 'resolved')).toBe(true)
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
        expect(textContent(lastToolResult(context))).not.toContain('ID:')
        return finalResponse()
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
        return finalResponse()
      }
    ])

    await new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader()).run(runInput({
      runtime: runtime.runtime,
      observationLines: ['A😀B']
    }))
  })

  it('keeps the external agenda and draft visible after context compaction', async () => {
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
          stream.end(fauxAssistantMessage('A draft was staged; continue adjudicating the open candidate.'))
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
        expect(contextText(context)).toContain('Candidates: 1 total; 1 open; 0 resolved.')
        expect(contextText(context)).toContain('Contribution Draft: 1 Statements.')
        stream.end(finalResponse([], [{ ref: 'C000001', resolution: 'Covered by Large draft.' }]))
        return stream
      }
    }

    const result = await new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader()).run(runInput({
      runtime,
      statementCandidates: [candidate()]
    }))

    expect(normalCalls).toBe(2)
    expect(compactionCalls).toBeGreaterThan(0)
    expect(result.modelCallCount).toBe(normalCalls + compactionCalls)
    expect(result.contribution.statements[0].content).toBe(largeBody)
  })

  it('has no fixed model-call or tool-call quota', async () => {
    const searches = Array.from({ length: 12 }, (_, index) => fauxAssistantMessage(
      fauxToolCall('search_knowledge', { query: `query-${index}` }),
      { stopReason: 'toolUse' }
    ))
    const runtime = fauxRuntime([...searches, finalResponse()])

    const result = await new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader()).run(runInput({
      runtime: runtime.runtime
    }))

    expect(result.modelCallCount).toBe(13)
    expect(result.toolCalls.filter((name) => name === 'search_knowledge')).toHaveLength(12)
  })

  it('does not impose a run-level Statement count on the Contribution Draft', async () => {
    const statements = Array.from({ length: 64 }, (_, index) => ({
      title: `Statement ${index + 1}`,
      content: `Knowledge ${index + 1}`
    }))
    const runtime = fauxRuntime([finalResponse(statements)])

    const result = await new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader()).run(runInput({
      runtime: runtime.runtime
    }))

    expect(result.contribution.statements).toHaveLength(64)
  })

  it('lets the normal Agent recover from tool validation and Knowledge Reader failures', async () => {
    const reader: KnowledgeReader = {
      search: async () => { throw new Error('temporary search failure') },
      read: async () => undefined
    }
    const traces: KnowledgeAgentTraceEvent[] = []
    const runtime = fauxRuntime([
      fauxAssistantMessage(
        fauxToolCall('read_evidence', { line: 999, offset: 0, limit: 10 }),
        { stopReason: 'toolUse' }
      ),
      fauxAssistantMessage(
        fauxToolCall('search_knowledge', { query: 'retry' }),
        { stopReason: 'toolUse' }
      ),
      finalResponse()
    ])

    const result = await new PiKnowledgeMaintenanceAgent(reader).run(runInput({
      runtime: runtime.runtime,
      onTrace: (event) => traces.push(event)
    }))

    expect(result.modelCallCount).toBe(3)
    expect(traces).toContainEqual(expect.objectContaining({
      type: 'tool_completed',
      toolName: 'read_evidence',
      status: 'failed'
    }))
    expect(traces).toContainEqual(expect.objectContaining({
      type: 'tool_completed',
      toolName: 'search_knowledge',
      status: 'failed'
    }))
  })

  it('redacts an unknown model-generated tool name from traces and continues', async () => {
    const traces: KnowledgeAgentTraceEvent[] = []
    const runtime = fauxRuntime([
      fauxAssistantMessage(
        fauxToolCall('secret_internal_tool_name', { secret: 'do-not-log' }),
        { stopReason: 'toolUse' }
      ),
      finalResponse()
    ])

    const result = await new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader()).run(runInput({
      runtime: runtime.runtime,
      onTrace: (event) => traces.push(event)
    }))

    expect(result.toolCalls).toEqual(['未知工具', 'submit_knowledge_contribution'])
    expect(JSON.stringify(traces)).not.toContain('secret_internal_tool_name')
    expect(JSON.stringify(traces)).not.toContain('do-not-log')
  })

  it('isolates diagnostic callbacks and forwards reasoning only to reasoning models', async () => {
    const response = finalResponse()
    const supported = fauxRuntime([response], true)
    const unsupported = fauxRuntime([response], false)

    await expect(new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader()).run(runInput({
      runtime: supported.runtime,
      reasoningEffort: 'high',
      onTrace: () => { throw new Error('trace sink failed') }
    }))).resolves.toBeDefined()
    await new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader()).run(runInput({
      runtime: unsupported.runtime,
      reasoningEffort: 'high'
    }))

    expect(supported.reasoningCalls).toEqual(['high'])
    expect(unsupported.reasoningCalls).toEqual([undefined])
  })

  it('rejects invalid candidate locations before starting the model', async () => {
    const prepared = fauxRuntime([finalResponse()])
    await expect(new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader()).run(runInput({
      runtime: prepared.runtime,
      statementCandidates: [{
        expression: 'database',
        question: 'What does it mean?',
        locations: [{ line: 99, offset: 0 }]
      }]
    }))).rejects.toThrow('证据位置无效')
    expect(prepared.callCount()).toBe(0)
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

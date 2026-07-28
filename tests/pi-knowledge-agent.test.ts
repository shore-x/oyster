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
import {
  PiContextCompactionOutputError,
  PiContextWindowError
} from '../src/main/agent-runtime/pi-context-compactor'
import {
  MAX_KNOWLEDGE_STATEMENT_CONTENT_LENGTH,
  type KnowledgeStatement
} from '../src/shared/knowledge'

const TOOL_NAMES = [
  'search_knowledge',
  'read_knowledge_statement',
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
    systemPrompt: 'Maintain knowledge using only authorized Oyster tools.',
    evidenceMap: 'Preference candidate at L000001-L000002.',
    evidenceMapSections: [],
    observationLines: ['RAW_SECRET prefers concise output', 'The user rejected verbose output'],
    sourceRef: 'observation:test:1',
    contributionRunRef: 'test-run:1',
    attention: 'Track explicit preferences.',
    signal: new AbortController().signal,
    ...overrides,
    observationFormatVersion: overrides.observationFormatVersion ?? 'test-v1'
  }
}

function contributionSubmission(content: string) {
  return {
    statements: [{
      title: 'Candidate knowledge',
      content
    }]
  }
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

function lastToolResult(context: Context) {
  const message = [...context.messages].reverse().find((candidate) => candidate.role === 'toolResult')
  if (!message || message.role !== 'toolResult') throw new Error('Expected a tool result')
  return message
}

function toolResults(context: Context) {
  return context.messages.flatMap((message) => message.role === 'toolResult' ? [message] : [])
}

function textContent(message: ReturnType<typeof lastToolResult>): string {
  return message.content.flatMap((content) => content.type === 'text' ? [content.text] : []).join('\n')
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

function waitingStreamFn(): StreamFn {
  return (model, _context, options) => {
    const stream = createAssistantMessageEventStream()
    const abort = (): void => {
      const output: AssistantMessage = {
        role: 'assistant',
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
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

function waitingRuntime(model: Model<Api>): ModelRuntime {
  return { model, streamFn: waitingStreamFn() }
}

describe('PiKnowledgeMaintenanceAgent', () => {
  it('forwards the configured reasoning effort through the Pi Agent loop only for a reasoning model', async () => {
    const response = fauxAssistantMessage(fauxToolCall(
      'submit_knowledge_contribution',
      contributionSubmission('Reasoned candidate')
    ), { stopReason: 'toolUse' })
    const supported = fauxRuntime([response], true)
    const unsupported = fauxRuntime([response], false)

    await new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader()).run(runInput({
      runtime: supported.runtime,
      reasoningEffort: 'high'
    }))
    await new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader()).run(runInput({
      runtime: unsupported.runtime,
      reasoningEffort: 'high'
    }))

    expect(supported.reasoningCalls).toEqual(['high'])
    expect(unsupported.reasoningCalls).toEqual([undefined])
  })

  it('uses a real four-turn Pi tool loop without putting raw Observation in the initial prompt', async () => {
    const hugeContent = `Known preference. ${'x'.repeat(80_000)}`
    const reader = new MemoryKnowledgeReader([{
      title: 'Output preference',
      content: hugeContent
    }])
    const runtime = fauxRuntime([
      (context) => {
        expect(context.systemPrompt).toBe('Maintain knowledge using only authorized Oyster tools.')
        expect(context.tools?.map((tool) => tool.name)).toEqual(TOOL_NAMES)
        expect(JSON.stringify(context.messages)).toContain('Preference candidate')
        expect(JSON.stringify(context.messages)).not.toContain('RAW_SECRET')
        return fauxAssistantMessage(
          fauxToolCall('search_knowledge', { query: 'output preference', limit: 5 }),
          { stopReason: 'toolUse' }
        )
      },
      (context) => {
        const result = textContent(lastToolResult(context))
        expect(result.length).toBeLessThanOrEqual(16 * 1_024)
        expect(result).toContain('标题: Output preference')
        expect(result).not.toContain('ID:')
        return fauxAssistantMessage(
          fauxToolCall('read_knowledge_statement', { title: 'Output preference' }),
          { stopReason: 'toolUse' }
        )
      },
      (context) => {
        const result = textContent(lastToolResult(context))
        expect(result).toContain(hugeContent)
        expect(result).not.toContain('内容因工具输出上限而截断')
        expect(result).toContain('Title: Output preference')
        expect(result).toContain('Content:')
        return fauxAssistantMessage(
          fauxToolCall('read_evidence', {
            line: 1,
            offset: 0,
            limit: 1_000
          }),
          { stopReason: 'toolUse' }
        )
      },
      (context) => {
        const result = textContent(lastToolResult(context))
        expect(result).toContain('RAW_SECRET prefers concise output\nThe user rejected verbose output')
        expect(result).not.toContain('L000001 RAW_SECRET')
        return fauxAssistantMessage(
          fauxToolCall(
            'submit_knowledge_contribution',
            contributionSubmission('# Candidate\n\nThe user prefers concise output.')
          ),
          { stopReason: 'toolUse' }
        )
      }
    ])
    const agent = new PiKnowledgeMaintenanceAgent(reader)
    const traceEvents: KnowledgeAgentTraceEvent[] = []

    const result = await agent.run(runInput({
      runtime: runtime.runtime,
      onTrace: (event) => traceEvents.push(event)
    }))

    expect(result).toEqual({
      contribution: {
        runRef: 'test-run:1',
        ...contributionSubmission('# Candidate\n\nThe user prefers concise output.')
      },
      modelCallCount: 4,
      toolCalls: TOOL_NAMES
    })
    expect(reader.searchCalls).toEqual([{ query: 'output preference', limit: 5 }])
    expect(reader.readCalls).toEqual(['Output preference'])
    expect(traceEvents.filter((event) => event.type === 'model_started')).toHaveLength(4)
    expect(traceEvents.filter((event) => event.type === 'model_completed')).toHaveLength(4)
    expect(traceEvents.filter((event) => event.type === 'tool_started')).toHaveLength(4)
    expect(traceEvents.filter((event) => event.type === 'tool_completed')).toEqual([
      expect.objectContaining({ toolName: 'search_knowledge', status: 'completed', detail: '返回 1 条候选知识' }),
      expect.objectContaining({ toolName: 'read_knowledge_statement', status: 'completed', detail: '已找到 Statement' }),
      expect.objectContaining({
        toolName: 'read_evidence',
        status: 'completed',
        detail: expect.stringMatching(/^L000001:C0-L000002:C\d+ · \d+ 字符 · EOF$/)
      }),
      expect.objectContaining({ toolName: 'submit_knowledge_contribution', status: 'completed', detail: '捕获 1 条候选 Statement' })
    ])
    expect(JSON.stringify(traceEvents)).not.toContain('RAW_SECRET')
    expect(JSON.stringify(traceEvents)).not.toContain('Known preference')
    expect(JSON.stringify(traceEvents)).not.toContain('Candidate\n\nThe user prefers')
  })

  it('lets the Agent continue a bounded knowledge search from the returned offset', async () => {
    const reader = new MemoryKnowledgeReader(Array.from({ length: 5 }, (_, index) => ({
      title: `Candidate ${index + 1}`,
      content: `Candidate knowledge ${index + 1}`
    })))
    const runtime = fauxRuntime([
      fauxAssistantMessage(fauxToolCall('search_knowledge', {
        query: 'candidate',
        limit: 2
      }), { stopReason: 'toolUse' }),
      (context) => {
        const page = textContent(lastToolResult(context))
        expect(page).toContain('Candidate 1')
        expect(page).toContain('Candidate 2')
        expect(page).not.toContain('Candidate 3')
        expect(page).toContain('Next offset: 2')
        return fauxAssistantMessage(fauxToolCall('search_knowledge', {
          query: 'candidate',
          limit: 2,
          offset: 2
        }), { stopReason: 'toolUse' })
      },
      (context) => {
        const page = textContent(lastToolResult(context))
        expect(page).toContain('Candidate 3')
        expect(page).toContain('Candidate 4')
        expect(page).toContain('Next offset: 4')
        return fauxAssistantMessage(fauxToolCall('search_knowledge', {
          query: 'candidate',
          limit: 2,
          offset: 4
        }), { stopReason: 'toolUse' })
      },
      (context) => {
        const page = textContent(lastToolResult(context))
        expect(page).toContain('Candidate 5')
        expect(page).toContain('Next offset: none')
        return fauxAssistantMessage(fauxToolCall(
          'submit_knowledge_contribution',
          contributionSubmission('Search pagination remained available to the Agent.')
        ), { stopReason: 'toolUse' })
      }
    ])

    await expect(new PiKnowledgeMaintenanceAgent(reader).run(runInput({
      runtime: runtime.runtime
    }))).resolves.toMatchObject({ modelCallCount: 4 })
    expect(reader.searchCalls).toEqual([
      { query: 'candidate', limit: 2 },
      { query: 'candidate', limit: 2, offset: 2 },
      { query: 'candidate', limit: 2, offset: 4 }
    ])
  })

  it('reads the current Statement by exact canonical title without exposing storage metadata', async () => {
    const reader = new MemoryKnowledgeReader([{
      title: 'Historical preference',
      content: 'The user preferred [[Editor A]].'
    }])
    const runtime = fauxRuntime([
      fauxAssistantMessage(
        fauxToolCall('read_knowledge_statement', { title: 'Historical preference' }),
        { stopReason: 'toolUse' }
      ),
      (context) => {
        const result = textContent(lastToolResult(context))
        expect(result).toContain('Title: Historical preference')
        expect(result).toContain('Content:\nThe user preferred [[Editor A]].')
        expect(result).not.toContain('ID:')
        expect(result).not.toContain('Origin Contribution:')
        return fauxAssistantMessage(
          fauxToolCall('submit_knowledge_contribution', { statements: [] }),
          { stopReason: 'toolUse' }
        )
      }
    ])

    await expect(new PiKnowledgeMaintenanceAgent(reader).run(runInput({
      runtime: runtime.runtime
    }))).resolves.toMatchObject({
      contribution: { statements: [] },
      toolCalls: ['read_knowledge_statement', 'submit_knowledge_contribution']
    })
    expect(reader.readCalls).toEqual(['Historical preference'])
  })

  it('can discover, read, and submit a replacement for the same canonical title', async () => {
    const reader = new MemoryKnowledgeReader([{
      title: 'Oyster Knowledge Store',
      content: 'The earlier understanding.'
    }])
    const runtime = fauxRuntime([
      fauxAssistantMessage(
        fauxToolCall('search_knowledge', { query: 'Oyster Knowledge Store' }),
        { stopReason: 'toolUse' }
      ),
      (context) => {
        expect(textContent(lastToolResult(context))).toContain('Oyster Knowledge Store')
        return fauxAssistantMessage(
          fauxToolCall('read_knowledge_statement', { title: 'Oyster Knowledge Store' }),
          { stopReason: 'toolUse' }
        )
      },
      (context) => {
        expect(textContent(lastToolResult(context))).toContain('The earlier understanding.')
        return fauxAssistantMessage(fauxToolCall('submit_knowledge_contribution', {
          statements: [{
            title: 'Oyster Knowledge Store',
            content: 'The current understanding references [[Oyster architecture]].'
          }]
        }), { stopReason: 'toolUse' })
      }
    ])

    const result = await new PiKnowledgeMaintenanceAgent(reader).run(runInput({
      runtime: runtime.runtime
    }))

    expect(result.contribution.statements).toEqual([{
      title: 'Oyster Knowledge Store',
      content: 'The current understanding references [[Oyster architecture]].'
    }])
    expect(result.toolCalls).toEqual([
      'search_knowledge',
      'read_knowledge_statement',
      'submit_knowledge_contribution'
    ])
    expect(reader.readCalls).toEqual(['Oyster Knowledge Store'])
  })

  it('does not let a failing debug trace callback change the Agent result', async () => {
    const runtime = fauxRuntime([
      fauxAssistantMessage(fauxToolCall(
        'submit_knowledge_contribution',
        contributionSubmission('Trace callback isolation')
      ), { stopReason: 'toolUse' })
    ])

    await expect(new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader()).run(runInput({
      runtime: runtime.runtime,
      onTrace: () => {
        throw new Error('trace sink failed')
      }
    }))).resolves.toMatchObject({
      contribution: { statements: [{ content: 'Trace callback isolation' }] },
      modelCallCount: 1
    })
  })

  it('does not reject a large Evidence Map or Attention through knowledge-specific character ceilings', async () => {
    const response = fauxAssistantMessage(fauxToolCall(
      'submit_knowledge_contribution',
      contributionSubmission('Accepted without a knowledge-specific input ceiling.')
    ), { stopReason: 'toolUse' })
    const prepared = fauxRuntime([response])
    prepared.runtime.model.contextWindow = 1_000_000

    await expect(new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader()).run(runInput({
      runtime: prepared.runtime,
      evidenceMap: `Root navigation\n${'map '.repeat(40_000)}`,
      attention: 'attention '.repeat(2_000)
    }))).resolves.toMatchObject({
      contribution: {
        statements: [{ content: 'Accepted without a knowledge-specific input ceiling.' }]
      },
      modelCallCount: 1
    })
  })

  it('uses generic context compaction when a normal tool loop outgrows the model context', async () => {
    const reader = new MemoryKnowledgeReader([{
      title: 'Large existing statement',
      content: 'detail '.repeat(4_000)
    }])
    const model = {
      ...fauxProvider().getModel(),
      contextWindow: 8_000,
      maxTokens: 512
    }
    let normalCalls = 0
    let compactionCalls = 0
    const runtime: ModelRuntime = {
      model,
      streamFn: (_requestedModel, context) => {
        const stream = createAssistantMessageEventStream()
        if (context.systemPrompt?.startsWith('You compact an agent')) {
          compactionCalls++
          stream.end(fauxAssistantMessage('The large statement was inspected; continue with the task.'))
          return stream
        }
        normalCalls++
        stream.end(normalCalls === 1
          ? fauxAssistantMessage(fauxToolCall(
              'read_knowledge_statement',
              { title: 'Large existing statement' }
            ), { stopReason: 'toolUse' })
          : fauxAssistantMessage(fauxToolCall(
              'submit_knowledge_contribution',
              contributionSubmission('Completed after context compaction.')
            ), { stopReason: 'toolUse' }))
        return stream
      }
    }
    const traceEvents: KnowledgeAgentTraceEvent[] = []

    const result = await new PiKnowledgeMaintenanceAgent(reader).run(runInput({
      runtime,
      onTrace: (event) => traceEvents.push(event)
    }))

    expect(normalCalls).toBe(2)
    expect(compactionCalls).toBeGreaterThan(0)
    expect(result.modelCallCount).toBe(normalCalls + compactionCalls)
    expect(result.contribution.statements[0].content).toBe('Completed after context compaction.')
    expect(traceEvents).toContainEqual(expect.objectContaining({
      type: 'model_started',
      purpose: 'context_compaction'
    }))
  })

  it('classifies a compaction provider error without exposing it in debug traces', async () => {
    const reader = new MemoryKnowledgeReader([{
      title: 'Large existing statement',
      content: 'detail '.repeat(6_000)
    }])
    const model = {
      ...fauxProvider().getModel(),
      contextWindow: 8_000,
      maxTokens: 512
    }
    let normalCalls = 0
    let compactionCalls = 0
    const runtime: ModelRuntime = {
      model,
      streamFn: (_requestedModel, context) => {
        if (context.systemPrompt?.startsWith('You compact an agent')) {
          compactionCalls++
          const stream = createAssistantMessageEventStream()
          stream.end(fauxAssistantMessage('', {
            stopReason: 'error',
            errorMessage: 'SECRET_PROVIDER_COMPACTION_FAILURE'
          }))
          return stream
        }
        const stream = createAssistantMessageEventStream()
        normalCalls++
        stream.end(normalCalls === 1
          ? fauxAssistantMessage(fauxToolCall(
              'read_knowledge_statement',
              { title: 'Large existing statement' }
            ), { stopReason: 'toolUse' })
          : fauxAssistantMessage(fauxToolCall(
              'submit_knowledge_contribution',
              contributionSubmission('Completed despite unavailable compaction.')
            ), { stopReason: 'toolUse' }))
        return stream
      }
    }
    const traceEvents: KnowledgeAgentTraceEvent[] = []

    const run = new PiKnowledgeMaintenanceAgent(reader).run(runInput({
      runtime,
      onTrace: (event) => traceEvents.push(event)
    }))

    await expect(run).rejects.toBeInstanceOf(ModelConnectionFailureError)
    expect(compactionCalls).toBeGreaterThan(0)
    expect(traceEvents).toContainEqual(expect.objectContaining({
      type: 'model_completed',
      status: 'failed',
      detail: 'context compaction failed'
    }))
    expect(JSON.stringify(traceEvents)).not.toContain('SECRET_PROVIDER_COMPACTION_FAILURE')
  })

  it('does not mark a healthy connection unavailable when a compaction summary is incomplete', async () => {
    const reader = new MemoryKnowledgeReader([{
      title: 'Large existing statement',
      content: 'detail '.repeat(6_000)
    }])
    const model = {
      ...fauxProvider().getModel(),
      contextWindow: 8_000,
      maxTokens: 512
    }
    const runtime: ModelRuntime = {
      model,
      streamFn: (_requestedModel, context) => {
        const stream = createAssistantMessageEventStream()
        stream.end(context.systemPrompt?.startsWith('You compact an agent')
          ? fauxAssistantMessage('partial summary', { stopReason: 'length' })
          : fauxAssistantMessage(fauxToolCall(
              'read_knowledge_statement',
              { title: 'Large existing statement' }
            ), { stopReason: 'toolUse' }))
        return stream
      }
    }

    const run = new PiKnowledgeMaintenanceAgent(reader).run(runInput({ runtime }))

    await expect(run).rejects.toBeInstanceOf(PiContextCompactionOutputError)
    await expect(run).rejects.not.toBeInstanceOf(ModelConnectionFailureError)
  })

  it('preserves a local context-window failure instead of misclassifying the backend connection', async () => {
    const reader = new MemoryKnowledgeReader([{
      title: 'Large existing statement',
      content: 'detail '.repeat(6_000)
    }])
    const model = {
      ...fauxProvider().getModel(),
      contextWindow: 8_000,
      maxTokens: 512
    }
    let normalCalls = 0
    const runtime: ModelRuntime = {
      model,
      streamFn: (_requestedModel, context) => {
        const stream = createAssistantMessageEventStream()
        if (context.systemPrompt?.startsWith('You compact an agent')) {
          stream.end(fauxAssistantMessage('oversized summary '.repeat(4_000)))
          return stream
        }
        normalCalls++
        stream.end(fauxAssistantMessage(fauxToolCall(
          'read_knowledge_statement',
          { title: 'Large existing statement' }
        ), { stopReason: 'toolUse' }))
        return stream
      }
    }

    const run = new PiKnowledgeMaintenanceAgent(reader).run(runInput({ runtime }))

    await expect(run).rejects.toBeInstanceOf(PiContextWindowError)
    await expect(run).rejects.not.toBeInstanceOf(ModelConnectionFailureError)
    expect(normalCalls).toBe(1)
  })

  it('redacts an unknown model-generated tool name from traces and execution summaries', async () => {
    const traceEvents: KnowledgeAgentTraceEvent[] = []
    const runtime = fauxRuntime([
      fauxAssistantMessage(
        fauxToolCall('RAW_SECRET_IN_TOOL_NAME', { copiedEvidence: 'RAW_SECRET_IN_ARGUMENTS' }),
        { stopReason: 'toolUse' }
      ),
      fauxAssistantMessage(fauxToolCall(
        'submit_knowledge_contribution',
        contributionSubmission('Recovered after an unknown tool request.')
      ), { stopReason: 'toolUse' })
    ])

    const result = await new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader()).run(runInput({
      runtime: runtime.runtime,
      onTrace: (event) => traceEvents.push(event)
    }))

    expect(result.toolCalls).toEqual(['未知工具', 'submit_knowledge_contribution'])
    expect(traceEvents).toContainEqual(expect.objectContaining({
      type: 'tool_completed',
      toolName: '未知工具',
      status: 'failed',
      detail: '工具调用失败'
    }))
    expect(JSON.stringify(traceEvents)).not.toContain('RAW_SECRET_IN_TOOL_NAME')
    expect(JSON.stringify(traceEvents)).not.toContain('RAW_SECRET_IN_ARGUMENTS')
  })

  it('reports an externally cancelled in-flight tool as cancelled', async () => {
    const controller = new AbortController()
    const traceEvents: KnowledgeAgentTraceEvent[] = []
    const runtime = fauxRuntime([
      fauxAssistantMessage(fauxToolCall('read_evidence', {
        line: 1,
        offset: 0,
        limit: 100
      }), { stopReason: 'toolUse' })
    ])

    const run = new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader()).run(runInput({
      runtime: runtime.runtime,
      signal: controller.signal,
      onTrace: (event) => {
        traceEvents.push(event)
        if (event.type === 'tool_started') controller.abort(new Error('cancel current tool'))
      }
    }))

    await expect(run).rejects.toThrow('cancel current tool')
    expect(traceEvents).toContainEqual(expect.objectContaining({
      type: 'tool_completed',
      toolName: 'read_evidence',
      status: 'cancelled',
      detail: '工具调用已取消'
    }))
    expect(JSON.stringify(traceEvents)).not.toContain('工具调用失败')
  })

  it('keeps a normal tool validation error classified as failed and does not accept sourceRef as a tool argument', async () => {
    const traceEvents: KnowledgeAgentTraceEvent[] = []
    const runtime = fauxRuntime([
      fauxAssistantMessage(fauxToolCall('read_evidence', {
        sourceRef: 'observation:outside-workspace',
        line: 1,
        offset: 0,
        limit: 100
      }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall(
        'submit_knowledge_contribution',
        contributionSubmission('Recovered after a rejected evidence read.')
      ), { stopReason: 'toolUse' })
    ])

    await new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader()).run(runInput({
      runtime: runtime.runtime,
      onTrace: (event) => traceEvents.push(event)
    }))

    expect(traceEvents).toContainEqual(expect.objectContaining({
      type: 'tool_completed',
      toolName: 'read_evidence',
      status: 'failed'
    }))
  })

  it('lets the normal Agent recover from a Knowledge Reader tool failure', async () => {
    const reader: KnowledgeReader = {
      async search() {
        throw new Error('temporary index failure')
      },
      async read() {
        return undefined
      }
    }
    const runtime = fauxRuntime([
      fauxAssistantMessage(fauxToolCall('search_knowledge', { query: 'candidate' }), {
        stopReason: 'toolUse'
      }),
      (context) => {
        expect(lastToolResult(context).isError).toBe(true)
        return fauxAssistantMessage(fauxToolCall(
          'submit_knowledge_contribution',
          contributionSubmission('Recovered from a temporary reader failure.')
        ), { stopReason: 'toolUse' })
      }
    ])

    await expect(new PiKnowledgeMaintenanceAgent(reader).run(runInput({
      runtime: runtime.runtime
    }))).resolves.toMatchObject({
      contribution: {
        statements: [{ content: 'Recovered from a temporary reader failure.' }]
      },
      modelCallCount: 2
    })
  })

  it('rejects governance fields outside the minimal Statement submission and lets the Agent retry', async () => {
    const rejected = {
      statements: [{
        title: 'Candidate knowledge',
        content: 'The submission should contain only semantic content.',
        sources: [{ sourceRef: 'observation:outside-workspace' }]
      }]
    }
    const runtime = fauxRuntime([
      fauxAssistantMessage(fauxToolCall(
        'submit_knowledge_contribution',
        rejected
      ), { stopReason: 'toolUse' }),
      (context) => {
        expect(lastToolResult(context).isError).toBe(true)
        return fauxAssistantMessage(fauxToolCall(
          'submit_knowledge_contribution',
          contributionSubmission('Accepted after removing non-semantic fields.')
        ), { stopReason: 'toolUse' })
      }
    ])

    await expect(new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader()).run(runInput({
      runtime: runtime.runtime
    }))).resolves.toMatchObject({
      contribution: {
        statements: [{ content: 'Accepted after removing non-semantic fields.' }]
      },
      modelCallCount: 2,
      toolCalls: ['submit_knowledge_contribution', 'submit_knowledge_contribution']
    })
  })

  it('uses the Store content boundary in its recoverable submit schema', async () => {
    const invalid = contributionSubmission('')
    const prepared = fauxRuntime([
      (context) => {
        const submit = context.tools?.find((tool) => tool.name === 'submit_knowledge_contribution')
        const parameters = submit?.parameters as {
          properties?: {
            statements?: {
              items?: { properties?: { content?: { maxLength?: number } } }
            }
          }
        }
        expect(parameters.properties?.statements?.items?.properties?.content?.maxLength)
          .toBe(MAX_KNOWLEDGE_STATEMENT_CONTENT_LENGTH)
        return fauxAssistantMessage(fauxToolCall(
          'submit_knowledge_contribution',
          invalid
        ), { stopReason: 'toolUse' })
      },
      (context) => {
        expect(lastToolResult(context).isError).toBe(true)
        return fauxAssistantMessage(fauxToolCall(
          'submit_knowledge_contribution',
          contributionSubmission('Accepted after reducing the Statement content.')
        ), { stopReason: 'toolUse' })
      }
    ])

    await expect(new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader()).run(runInput({
      runtime: prepared.runtime
    }))).resolves.toMatchObject({
      contribution: {
        statements: [{ content: 'Accepted after reducing the Statement content.' }]
      },
      modelCallCount: 2
    })
  })

  it('expands only an authorized local Evidence Map section before reading its raw range', async () => {
    const sectionToolNames = [
      'search_knowledge',
      'read_knowledge_statement',
      'read_evidence_map_section',
      'read_evidence',
      'submit_knowledge_contribution'
    ]
    const runtime = fauxRuntime([
      (context) => {
        const initial = JSON.stringify(context.messages)
        expect(context.tools?.map((tool) => tool.name)).toEqual(sectionToolNames)
        expect(initial).toContain('ROOT NAVIGATION')
        expect(initial).toContain('Immediate child sections: M000001, M000002')
        expect(initial).not.toContain('M000001: L000001-L000001')
        expect(initial).not.toContain('LEAF_A_SECRET')
        expect(initial).not.toContain('LEAF_B_SECRET')
        expect(initial).not.toContain('RAW_B_SECRET')
        return fauxAssistantMessage(
          fauxToolCall('read_evidence_map_section', { sectionId: 'M999999' }),
          { stopReason: 'toolUse' }
        )
      },
      (context) => {
        const denied = lastToolResult(context)
        expect(denied.isError).toBe(true)
        expect(textContent(denied)).not.toContain('LEAF_A_SECRET')
        expect(textContent(denied)).not.toContain('LEAF_B_SECRET')
        return fauxAssistantMessage(
          fauxToolCall('read_evidence_map_section', { sectionId: 'M000002' }),
          { stopReason: 'toolUse' }
        )
      },
      (context) => {
        const section = textContent(lastToolResult(context))
        expect(section).toContain('M000002')
        expect(section).toContain('L000002-L000002')
        expect(section).toContain('L000004-L000004')
        expect(section).toContain('First evidence read location: L000002:C0')
        expect(section).toContain('read_evidence({"line":2,"offset":0')
        expect(section).toContain('LEAF_B_SECRET')
        expect(section).not.toContain('LEAF_A_SECRET')
        return fauxAssistantMessage(fauxToolCall('read_evidence', {
          line: 2,
          offset: 0,
          limit: 100
        }), { stopReason: 'toolUse' })
      },
      (context) => {
        expect(textContent(lastToolResult(context))).toContain('RAW_B_SECRET')
        expect(textContent(lastToolResult(context))).not.toContain('L000002 RAW_B_SECRET')
        return fauxAssistantMessage(fauxToolCall('submit_knowledge_contribution', {
          statements: [{
            title: 'Candidate knowledge',
            content: 'Verified from the second range.'
          }]
        }), { stopReason: 'toolUse' })
      }
    ])
    const agent = new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader())

    const result = await agent.run(runInput({
      runtime: runtime.runtime,
      evidenceMap: 'ROOT NAVIGATION\nImmediate child sections: M000001, M000002',
      evidenceMapSections: [
        {
          id: 'M000001',
          selectors: ['L000001-L000001'],
          readLocation: { line: 1, offset: 0 },
          content: 'LEAF_A_SECRET'
        },
        {
          id: 'M000002',
          selectors: ['L000002-L000002', 'L000004-L000004'],
          readLocation: { line: 2, offset: 0 },
          content: 'LEAF_B_SECRET'
        }
      ],
      observationLines: ['RAW_A_SECRET', 'RAW_B_SECRET', 'UNSELECTED', 'OTHER_SELECTED']
    }))

    expect(result).toMatchObject({
      contribution: {
        statements: [{
          title: 'Candidate knowledge',
          content: 'Verified from the second range.'
        }]
      },
      modelCallCount: 4,
      toolCalls: [
        'read_evidence_map_section',
        'read_evidence_map_section',
        'read_evidence',
        'submit_knowledge_contribution'
      ]
    })
  })

  it('discloses only coverage and child navigation for an intermediate Evidence Map section', async () => {
    const selectors = Array.from({ length: 2_500 }, (_, index) => {
      const line = String(index * 2 + 1).padStart(6, '0')
      return `L${line}-L${line}`
    })
    const observationLines = Array.from({ length: 5_000 }, (_, index) => `line-${index + 1}`)
    const runtime = fauxRuntime([
      fauxAssistantMessage(
        fauxToolCall('read_evidence_map_section', { sectionId: 'M000001' }),
        { stopReason: 'toolUse' }
      ),
      (context) => {
        const section = textContent(lastToolResult(context))
        expect(section).toContain(
          'Source coverage extent (navigation only; not exact selectors): L000001-L004999'
        )
        expect(section).toContain('Immediate child sections: M000002')
        expect(section).toContain('PARENT_NAVIGATION_CONTENT')
        expect(section).not.toContain('Selected source ranges:')
        expect(section).not.toContain('L002001-L002001')
        return fauxAssistantMessage(fauxToolCall(
          'submit_knowledge_contribution',
          contributionSubmission('Intermediate map navigation remained compact.')
        ), { stopReason: 'toolUse' })
      }
    ])

    await expect(new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader()).run(runInput({
      runtime: runtime.runtime,
      evidenceMap: 'ROOT NAVIGATION\nImmediate child sections: M000001',
      evidenceMapSections: [
        {
          id: 'M000001',
          selectors,
          readLocation: { line: 1, offset: 0 },
          children: ['M000002'],
          content: 'PARENT_NAVIGATION_CONTENT'
        },
        {
          id: 'M000002',
          selectors: ['L000001-L000001'],
          readLocation: { line: 1, offset: 0 },
          content: 'LEAF_CONTENT'
        }
      ],
      observationLines
    }))).resolves.toMatchObject({
      contribution: { statements: [{ content: 'Intermediate map navigation remained compact.' }] },
      modelCallCount: 2
    })
  })

  it('does not silently truncate a leaf Evidence Map section', async () => {
    const selectors = Array.from({ length: 1_000 }, (_, index) => {
      const line = String(index * 2 + 1).padStart(6, '0')
      return `L${line}-L${line}`
    })
    const content = `MAP_START\n${'x'.repeat(24_000)}\nMAP_END`
    const runtime = fauxRuntime([
      fauxAssistantMessage(
        fauxToolCall('read_evidence_map_section', { sectionId: 'M000001' }),
        { stopReason: 'toolUse' }
      ),
      (context) => {
        const section = textContent(lastToolResult(context))
        expect(section.length).toBeGreaterThan(32 * 1_024)
        expect(section).toContain('L001999-L001999')
        expect(section).toContain(content)
        expect(section).not.toContain('内容因工具输出上限而截断')
        return fauxAssistantMessage(fauxToolCall(
          'submit_knowledge_contribution',
          contributionSubmission('The complete leaf map remained available.')
        ), { stopReason: 'toolUse' })
      }
    ])

    await expect(new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader()).run(runInput({
      runtime: runtime.runtime,
      evidenceMap: 'ROOT NAVIGATION\nImmediate child sections: M000001',
      evidenceMapSections: [{
        id: 'M000001',
        selectors,
        readLocation: { line: 1, offset: 0 },
        content
      }],
      observationLines: Array.from({ length: 2_000 }, (_, index) => `line-${index + 1}`)
    }))).resolves.toMatchObject({
      contribution: { statements: [{ content: 'The complete leaf map remained available.' }] },
      modelCallCount: 2
    })
  })

  it('requires Evidence Map section source ranges to be ordered and coalesced', async () => {
    const runtime = fauxRuntime([])
    const agent = new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader())

    await expect(agent.run(runInput({
      runtime: runtime.runtime,
      evidenceMapSections: [{
        id: 'M000001',
        selectors: ['L000001-L000001', 'L000002-L000002'],
        readLocation: { line: 1, offset: 0 },
        content: 'INVALID UNCOALESCED SECTION'
      }]
    }))).rejects.toThrow('必须按顺序且已合并')
    expect(runtime.callCount()).toBe(0)
  })

  it('requires a long-line section read location to match its character-window start', async () => {
    const runtime = fauxRuntime([])
    const agent = new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader())

    await expect(agent.run(runInput({
      runtime: runtime.runtime,
      observationLines: ['0123456789'],
      evidenceMapSections: [{
        id: 'M000001',
        selectors: ['L000001-L000001'],
        readLocation: { line: 1, offset: 0 },
        characterWindow: { startCharacter: 3, endCharacter: 8, totalCharacters: 10 },
        content: 'WINDOW STARTS AT C3'
      }]
    }))).rejects.toThrow('字符窗口无效')
    expect(runtime.callCount()).toBe(0)
  })

  it('allows only valid workspace-bound line and offset locations', async () => {
    const observationLines = Array.from({ length: 201 }, (_, index) => `secret-line-${index + 1}`)
    const runtime = fauxRuntime([
      fauxAssistantMessage([
        fauxToolCall('read_evidence', {
          line: 0,
          offset: 0,
          limit: 100
        }, { id: 'invalid-line' }),
        fauxToolCall('read_evidence', {
          line: 1,
          offset: observationLines[0].length + 1,
          limit: 100
        }, { id: 'invalid-offset' }),
        fauxToolCall('read_evidence', {
          line: 1,
          offset: 0,
          limit: 0
        }, { id: 'invalid-limit' })
      ], { stopReason: 'toolUse' }),
      (context) => {
        const invalid = toolResults(context).slice(-3)
        expect(invalid).toHaveLength(3)
        expect(invalid.every((result) => result.isError)).toBe(true)
        expect(invalid.map(textContent).join('\n')).not.toContain('secret-line-1')
        return fauxAssistantMessage(fauxToolCall('read_evidence', {
          line: 201,
          offset: 0,
          limit: 100
        }), { stopReason: 'toolUse' })
      },
      (context) => {
        const result = lastToolResult(context)
        expect(result.isError).toBe(false)
        expect(textContent(result)).toContain('L000201:C0')
        expect(textContent(result)).toContain('secret-line-201')
        expect(textContent(result)).toContain('Next: none')
        expect(textContent(result)).toContain('EOF: true')
        return fauxAssistantMessage(fauxToolCall(
          'submit_knowledge_contribution',
          contributionSubmission('No durable claim; evidence was only inspected.')
        ), { stopReason: 'toolUse' })
      }
    ])
    const agent = new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader())

    await expect(agent.run(runInput({ runtime: runtime.runtime, observationLines }))).resolves.toMatchObject({
      contribution: { statements: [{ content: 'No durable claim; evidence was only inspected.' }] },
      modelCallCount: 3
    })
  })

  it('pages one oversized raw line without a failure before submitting semantic content', async () => {
    const longLine = `${'a'.repeat(70_000)}TAIL`
    const runtime = fauxRuntime([
      fauxAssistantMessage(fauxToolCall('read_evidence', {
        line: 1,
        offset: 0,
        limit: 40_000
      }), { stopReason: 'toolUse' }),
      (context) => {
        const firstPage = lastToolResult(context)
        expect(firstPage.isError).toBe(false)
        expect(textContent(firstPage)).toContain('L000001:C0')
        expect(textContent(firstPage)).toContain('Next: L000001:C40000')
        expect(textContent(firstPage)).toContain('EOF: false')
        return fauxAssistantMessage(fauxToolCall('read_evidence', {
          line: 1,
          offset: 40_000,
          limit: 40_000
        }), { stopReason: 'toolUse' })
      },
      (context) => {
        const finalPage = lastToolResult(context)
        expect(finalPage.isError).toBe(false)
        expect(textContent(finalPage)).toContain('L000001:C40000')
        expect(textContent(finalPage)).toContain('TAIL')
        expect(textContent(finalPage)).toContain('Next: none')
        expect(textContent(finalPage)).toContain('EOF: true')
        return fauxAssistantMessage(fauxToolCall('submit_knowledge_contribution', {
          statements: [{
            title: 'Long line evidence',
            content: 'The relevant detail was verified through bounded windows.'
          }]
        }), { stopReason: 'toolUse' })
      }
    ])

    const result = await new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader()).run(runInput({
      runtime: runtime.runtime,
      observationLines: [longLine]
    }))

    expect(result.contribution.statements[0]).toEqual({
      title: 'Long line evidence',
      content: 'The relevant detail was verified through bounded windows.'
    })
  })

  it('keeps Unicode code points intact across continuation pages and reports EOF', async () => {
    const unicodeLine = 'A😀B'
    const runtime = fauxRuntime([
      fauxAssistantMessage(fauxToolCall('read_evidence', {
        line: 1,
        offset: 0,
        limit: 2
      }), { stopReason: 'toolUse' }),
      (context) => {
        const firstPage = textContent(lastToolResult(context))
        expect(firstPage).toContain('A')
        expect(firstPage).toContain('Next: L000001:C1')
        expect(firstPage).not.toContain('\ud83d')
        return fauxAssistantMessage(fauxToolCall('read_evidence', {
          line: 1,
          offset: 1,
          limit: 2
        }), { stopReason: 'toolUse' })
      },
      (context) => {
        const secondPage = textContent(lastToolResult(context))
        expect(secondPage).toContain('😀')
        expect(secondPage).toContain('Next: L000001:C3')
        return fauxAssistantMessage(fauxToolCall('read_evidence', {
          line: 1,
          offset: 3,
          limit: 2
        }), { stopReason: 'toolUse' })
      },
      (context) => {
        const finalPage = textContent(lastToolResult(context))
        expect(finalPage).toContain('B')
        expect(finalPage).toContain('Next: none')
        return fauxAssistantMessage(fauxToolCall(
          'submit_knowledge_contribution',
          contributionSubmission('Unicode evidence was read without splitting a code point.')
        ), { stopReason: 'toolUse' })
      }
    ])

    await expect(new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader()).run(runInput({
      runtime: runtime.runtime,
      observationLines: [unicodeLine]
    }))).resolves.toMatchObject({
      contribution: {
        statements: [{
          title: 'Candidate knowledge',
          content: 'Unicode evidence was read without splitting a code point.'
        }]
      },
      modelCallCount: 4
    })
  })

  it('allows repeated searches, knowledge and map reads, and overlapping evidence reads', async () => {
    const reader = new MemoryKnowledgeReader([{
      title: 'Output preference',
      content: 'The user prefers concise output.'
    }])
    const runtime = fauxRuntime([
      fauxAssistantMessage([
        fauxToolCall('search_knowledge', { query: '  Output   preference  ' }, { id: 'search-first' }),
        fauxToolCall('read_knowledge_statement', { title: 'Output preference' }, { id: 'statement-first' }),
        fauxToolCall('read_evidence_map_section', { sectionId: 'M000001' }, { id: 'map-first' }),
        fauxToolCall('read_evidence', {
          line: 1,
          offset: 0,
          limit: 40
        }, { id: 'evidence-first' })
      ], { stopReason: 'toolUse' }),
      fauxAssistantMessage([
        fauxToolCall('search_knowledge', { query: 'output preference' }, { id: 'search-repeat' }),
        fauxToolCall('read_knowledge_statement', { title: 'Output preference' }, { id: 'statement-repeat' }),
        fauxToolCall('read_evidence_map_section', { sectionId: 'M000001' }, { id: 'map-repeat' }),
        fauxToolCall('read_evidence', {
          line: 1,
          offset: 10,
          limit: 40
        }, { id: 'evidence-overlap' })
      ], { stopReason: 'toolUse' }),
      (context) => {
        const repeated = toolResults(context).slice(-4)
        expect(repeated).toHaveLength(4)
        expect(repeated.every((result) => !result.isError)).toBe(true)
        expect(textContent(repeated[0])).toContain('Output preference')
        expect(textContent(repeated[1])).toContain('The user prefers concise output.')
        expect(textContent(repeated[2])).toContain('MAP_DETAIL')
        expect(textContent(repeated[3])).toContain('prefers concise output')
        return fauxAssistantMessage(fauxToolCall(
          'submit_knowledge_contribution',
          contributionSubmission('Repeated reads remained available and the result was submitted.')
        ), { stopReason: 'toolUse' })
      }
    ])
    const agent = new PiKnowledgeMaintenanceAgent(reader)

    await expect(agent.run(runInput({
      runtime: runtime.runtime,
      evidenceMapSections: [{
        id: 'M000001',
        selectors: ['L000001-L000001'],
        readLocation: { line: 1, offset: 0 },
        content: 'MAP_DETAIL'
      }]
    }))).resolves.toMatchObject({
      contribution: { statements: [{ content: 'Repeated reads remained available and the result was submitted.' }] },
      modelCallCount: 3
    })
    expect(reader.searchCalls).toEqual([
      { query: 'Output   preference', limit: 8 },
      { query: 'output preference', limit: 8 }
    ])
    expect(reader.readCalls).toEqual(['Output preference', 'Output preference'])
  })

  it('allows individually bounded tool outputs to accumulate across the run', async () => {
    const observationLines = Array.from({ length: 3 }, () => 'x'.repeat(40_000))
    const runtime = fauxRuntime([
      fauxAssistantMessage(fauxToolCall('read_evidence', {
        line: 1,
        offset: 0,
        limit: 40_000
      }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall('read_evidence', {
        line: 2,
        offset: 0,
        limit: 40_000
      }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall('read_evidence', {
        line: 3,
        offset: 0,
        limit: 40_000
      }), { stopReason: 'toolUse' }),
      (context) => {
        const result = lastToolResult(context)
        expect(result.isError).toBe(false)
        expect(textContent(result)).toContain('Returned source characters: 40000')
        expect(textContent(result)).toContain('EOF: true')
        return fauxAssistantMessage(fauxToolCall(
          'submit_knowledge_contribution',
          contributionSubmission('All three bounded evidence pages were available before submission.')
        ), { stopReason: 'toolUse' })
      }
    ])
    const agent = new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader())

    await expect(agent.run(runInput({ runtime: runtime.runtime, observationLines }))).resolves.toMatchObject({
      contribution: { statements: [{ content: 'All three bounded evidence pages were available before submission.' }] },
      modelCallCount: 4
    })
  })

  it('continues past four model calls and submits normally', async () => {
    const responses = Array.from({ length: 4 }, (_, index) => fauxAssistantMessage(
      fauxToolCall('search_knowledge', { query: `exploration-${index}` }),
      { stopReason: 'toolUse' }
    )).concat(fauxAssistantMessage(
      fauxToolCall(
        'submit_knowledge_contribution',
        contributionSubmission('Submitted after more than four model calls.')
      ),
      { stopReason: 'toolUse' }
    ))
    const runtime = fauxRuntime(responses)
    const reader = new MemoryKnowledgeReader()
    const agent = new PiKnowledgeMaintenanceAgent(reader)

    await expect(agent.run(runInput({ runtime: runtime.runtime }))).resolves.toMatchObject({
      contribution: { statements: [{ content: 'Submitted after more than four model calls.' }] },
      modelCallCount: 5
    })
    expect(runtime.callCount()).toBe(5)
    expect(reader.searchCalls).toHaveLength(4)
  })

  it('continues past twelve tool calls and submits normally', async () => {
    const reader = new MemoryKnowledgeReader()
    const calls = Array.from({ length: 13 }, (_, index) => fauxToolCall(
      'search_knowledge',
      { query: `query-${index}` },
      { id: `call-${index}` }
    ))
    const runtime = fauxRuntime([
      fauxAssistantMessage(calls, { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall(
        'submit_knowledge_contribution',
        contributionSubmission('Submitted after more than twelve tool calls.')
      ), { stopReason: 'toolUse' })
    ])
    const agent = new PiKnowledgeMaintenanceAgent(reader)

    await expect(agent.run(runInput({ runtime: runtime.runtime }))).resolves.toMatchObject({
      contribution: { statements: [{ content: 'Submitted after more than twelve tool calls.' }] },
      modelCallCount: 2,
      toolCalls: [...Array(13).fill('search_knowledge'), 'submit_knowledge_contribution']
    })
    expect(reader.searchCalls).toHaveLength(13)
  })

  it('does not impose a run-level Statement count on the final Contribution', async () => {
    const statements = Array.from({ length: 101 }, (_, index) => ({
      title: `Candidate ${index}`,
      content: `Knowledge candidate ${index}.`
    }))
    const runtime = fauxRuntime([fauxAssistantMessage(fauxToolCall(
      'submit_knowledge_contribution',
      { statements }
    ), { stopReason: 'toolUse' })])

    const result = await new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader()).run(runInput({
      runtime: runtime.runtime
    }))

    expect(result.contribution.statements).toHaveLength(101)
  })

  it.each([
    {
      name: 'a second submission',
      calls: [
        fauxToolCall('submit_knowledge_contribution', contributionSubmission('first'), { id: 'submit-1' }),
        fauxToolCall('submit_knowledge_contribution', contributionSubmission('second'), { id: 'submit-2' })
      ],
      error: '只能提交一次'
    },
    {
      name: 'a tool after submission',
      calls: [
        fauxToolCall('submit_knowledge_contribution', contributionSubmission('first'), { id: 'submit' }),
        fauxToolCall('read_evidence', {
          line: 1,
          offset: 0,
          limit: 100
        }, { id: 'read-after-submit' })
      ],
      error: '提交 Knowledge Contribution 后不能继续调用工具'
    }
  ])('rejects $name', async ({ calls, error }) => {
    const runtime = fauxRuntime([fauxAssistantMessage(calls, { stopReason: 'toolUse' })])
    const agent = new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader())

    await expect(agent.run(runInput({ runtime: runtime.runtime }))).rejects.toThrow(error)
  })

  it('fails when the model stops without submitting or the model runtime reports an error', async () => {
    const noSubmit = fauxRuntime([fauxAssistantMessage('I am done without submitting.')])
    await expect(new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader()).run(runInput({
      runtime: noSubmit.runtime
    }))).rejects.toThrow('未提交 Knowledge Contribution')

    const modelFailure = fauxRuntime([
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'provider down' })
    ])
    const traceEvents: KnowledgeAgentTraceEvent[] = []
    const providerFailure = new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader()).run(runInput({
      runtime: modelFailure.runtime,
      onTrace: (event) => traceEvents.push(event)
    }))
    await expect(providerFailure).rejects.toBeInstanceOf(ModelConnectionFailureError)
    await expect(providerFailure).rejects.toThrow('provider down')
    expect(traceEvents).toContainEqual(expect.objectContaining({
      type: 'model_completed',
      status: 'failed'
    }))
  })

  it('propagates an external abort to the active Pi run', async () => {
    const faux = fauxProvider()
    const controller = new AbortController()
    const agent = new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader())
    const traceEvents: KnowledgeAgentTraceEvent[] = []
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const run = agent.run(runInput({
      runtime: waitingRuntime(faux.getModel()),
      signal: controller.signal,
      onTrace: (event) => {
        traceEvents.push(event)
        if (event.type === 'model_started') markStarted()
      }
    }))
    await started
    controller.abort(new Error('user cancelled'))

    await expect(run).rejects.toThrow('user cancelled')
    expect(traceEvents).toContainEqual(expect.objectContaining({
      type: 'model_completed',
      status: 'cancelled'
    }))
  })

})

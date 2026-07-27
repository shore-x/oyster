import { afterEach, describe, expect, it, vi } from 'vitest'
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

const TOOL_NAMES = [
  'search_knowledge',
  'read_knowledge_statement',
  'read_evidence',
  'submit_knowledge_contribution'
]

class MemoryKnowledgeReader implements KnowledgeReader {
  readonly searchCalls: Array<{ query: string; limit: number }> = []
  readonly readCalls: string[] = []

  constructor(private readonly records: KnowledgeStatementRecord[] = []) {}

  async search(query: string, limit: number, signal?: AbortSignal): Promise<KnowledgeStatementRecord[]> {
    signal?.throwIfAborted()
    this.searchCalls.push({ query, limit })
    return this.records.slice(0, limit)
  }

  async read(statementId: string, signal?: AbortSignal): Promise<KnowledgeStatementRecord | undefined> {
    signal?.throwIfAborted()
    this.readCalls.push(statementId)
    return this.records.find((record) => record.id === statementId)
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
      localRef: 'candidate-1',
      title: 'Candidate knowledge',
      content,
      sources: [{
        sourceRef: 'observation:test:1',
        selector: 'L000001-L000001'
      }]
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

afterEach(() => {
  vi.useRealTimers()
})

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
      id: 'statement:1',
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
        expect(result).toContain('statement:1')
        return fauxAssistantMessage(
          fauxToolCall('read_knowledge_statement', { statementId: 'statement:1' }),
          { stopReason: 'toolUse' }
        )
      },
      (context) => {
        const result = textContent(lastToolResult(context))
        expect(result.length).toBeLessThanOrEqual(32 * 1_024)
        expect(result).toContain('内容因工具输出上限而截断')
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
    expect(reader.readCalls).toEqual(['statement:1'])
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
            localRef: 'candidate-1',
            title: 'Candidate knowledge',
            content: 'Verified from the second range.',
            sources: [{
              sourceRef: 'observation:test:1',
              selector: 'L000002-L000002'
            }]
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
        statements: [{ sources: [{ selector: 'L000002-L000002' }] }]
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

  it('pages one oversized raw line without a failure and keeps L provenance on submission', async () => {
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
            localRef: 'long-line',
            title: 'Long line evidence',
            content: 'The relevant detail was verified through bounded windows.',
            sources: [{
              sourceRef: 'observation:test:1',
              selector: 'L000001-L000001'
            }]
          }]
        }), { stopReason: 'toolUse' })
      }
    ])

    const result = await new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader()).run(runInput({
      runtime: runtime.runtime,
      observationLines: [longLine]
    }))

    expect(result.contribution.statements[0].sources).toEqual([{
      sourceRef: 'observation:test:1',
      selector: 'L000001-L000001'
    }])
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
          sources: [{ sourceRef: 'observation:test:1', selector: 'L000001-L000001' }]
        }]
      },
      modelCallCount: 4
    })
  })

  it('returns recoverable tool errors for repeated searches, statements, and overlapping evidence', async () => {
    const reader = new MemoryKnowledgeReader([{
      id: 'statement:1',
      title: 'Output preference',
      content: 'The user prefers concise output.'
    }])
    const runtime = fauxRuntime([
      fauxAssistantMessage([
        fauxToolCall('search_knowledge', { query: '  Output   preference  ' }, { id: 'search-first' }),
        fauxToolCall('read_knowledge_statement', { statementId: 'statement:1' }, { id: 'statement-first' }),
        fauxToolCall('read_evidence', {
          line: 1,
          offset: 0,
          limit: 40
        }, { id: 'evidence-first' })
      ], { stopReason: 'toolUse' }),
      fauxAssistantMessage([
        fauxToolCall('search_knowledge', { query: 'output preference' }, { id: 'search-repeat' }),
        fauxToolCall('read_knowledge_statement', { statementId: 'statement:1' }, { id: 'statement-repeat' }),
        fauxToolCall('read_evidence', {
          line: 1,
          offset: 10,
          limit: 40
        }, { id: 'evidence-overlap' })
      ], { stopReason: 'toolUse' }),
      (context) => {
        const repeated = toolResults(context).slice(-3)
        expect(repeated).toHaveLength(3)
        expect(repeated.every((result) => result.isError)).toBe(true)
        expect(textContent(repeated[0])).toContain('重复搜索已拒绝')
        expect(textContent(repeated[1])).toContain('已读取')
        expect(textContent(repeated[2])).toContain('重叠')
        return fauxAssistantMessage(fauxToolCall(
          'submit_knowledge_contribution',
          contributionSubmission('Recovered from duplicate reads and submitted.')
        ), { stopReason: 'toolUse' })
      }
    ])
    const agent = new PiKnowledgeMaintenanceAgent(reader)

    await expect(agent.run(runInput({ runtime: runtime.runtime }))).resolves.toMatchObject({
      contribution: { statements: [{ content: 'Recovered from duplicate reads and submitted.' }] },
      modelCallCount: 3
    })
    expect(reader.searchCalls).toEqual([{ query: 'Output   preference', limit: 8 }])
    expect(reader.readCalls).toEqual(['statement:1'])
  })

  it('enforces a cumulative tool-output budget before the next model context grows too large', async () => {
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
        expect(result.isError).toBe(true)
        expect(textContent(result)).toContain('工具输出累计最多 98304 个字符')
        return fauxAssistantMessage(fauxToolCall(
          'submit_knowledge_contribution',
          contributionSubmission('Submitted within the cumulative output budget.')
        ), { stopReason: 'toolUse' })
      }
    ])
    const agent = new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader())

    await expect(agent.run(runInput({ runtime: runtime.runtime, observationLines }))).resolves.toMatchObject({
      contribution: { statements: [{ content: 'Submitted within the cumulative output budget.' }] },
      modelCallCount: 4
    })
  })

  it('fails before making a fifth model call', async () => {
    const responses = Array.from({ length: 4 }, () => fauxAssistantMessage(
      fauxToolCall('search_knowledge', { query: 'again' }),
      { stopReason: 'toolUse' }
    ))
    const runtime = fauxRuntime(responses)
    const agent = new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader())

    await expect(agent.run(runInput({ runtime: runtime.runtime }))).rejects.toThrow('最多允许 4 次模型调用')
    expect(runtime.callCount()).toBe(4)
  })

  it('executes at most twelve requested tools', async () => {
    const reader = new MemoryKnowledgeReader()
    const calls = Array.from({ length: 13 }, (_, index) => fauxToolCall(
      'search_knowledge',
      { query: `query-${index}` },
      { id: `call-${index}` }
    ))
    const runtime = fauxRuntime([
      fauxAssistantMessage(calls, { stopReason: 'toolUse' })
    ])
    const agent = new PiKnowledgeMaintenanceAgent(reader)

    await expect(agent.run(runInput({ runtime: runtime.runtime }))).rejects.toThrow('最多允许 12 次工具调用')
    expect(reader.searchCalls).toHaveLength(12)
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

  it('aborts an active run after five minutes', async () => {
    vi.useFakeTimers()
    const faux = fauxProvider()
    const agent = new PiKnowledgeMaintenanceAgent(new MemoryKnowledgeReader())
    const traceEvents: KnowledgeAgentTraceEvent[] = []
    const assertion = expect(agent.run(runInput({
      runtime: waitingRuntime(faux.getModel()),
      onTrace: (event) => traceEvents.push(event)
    }))).rejects.toThrow('运行超时（5 分钟）')

    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await assertion
    expect(traceEvents).toContainEqual(expect.objectContaining({
      type: 'model_completed',
      status: 'failed'
    }))
  })
})

import { describe, expect, it, vi } from 'vitest'
import type { AiBackendSnapshot, AiConnection } from '../src/shared/ai-backends'
import type { ProcessingStageId } from '../src/shared/knowledge-processing'
import type {
  ModelGenerationRequest,
  ModelRuntime
} from '../src/main/ai-backends/model'
import { ModelContextOverflowError } from '../src/main/ai-backends/model'
import type { ObservationView } from '../src/main/observation/model'
import {
  KnowledgeProcessingService,
  type KnowledgeProcessingServiceOptions
} from '../src/main/knowledge-processing/knowledge-processing-service'
import { MAX_OBSERVATION_SEGMENT_SELECTOR_BYTES } from '../src/main/knowledge-processing/evidence-map-planner'
import type {
  AiBackendPort,
  KnowledgeAgentRunInput,
  KnowledgeAgentRunResult,
  KnowledgeAgentRuntime,
  KnowledgeProcessingRepository
} from '../src/main/knowledge-processing/model'
import {
  KNOWLEDGE_MAINTENANCE_AGENT_PROMPT,
  OBSERVATION_PREPROCESSOR_PROMPT
} from '../src/main/knowledge-processing/prompts'
import { InMemoryKnowledgeProcessingRepository } from '../src/main/knowledge-processing/repository'

function modelConnection(
  id: string,
  model = id,
  reasoningEfforts: NonNullable<AiConnection['modelConfig']>['reasoningEfforts'] = [],
  contextWindowTokens?: number
): AiConnection {
  return {
    id,
    adapterId: 'openai-compatible',
    backendKind: 'api',
    providerId: 'openai_compatible',
    displayName: `Model ${id}`,
    credentialMode: 'oyster_keychain',
    status: 'ready',
    models: [{
      id: model,
      displayName: model,
      reasoningEfforts: reasoningEfforts ?? [],
      ...(contextWindowTokens ? { contextWindowTokens, maxOutputTokens: 4_096 } : {})
    }],
    defaultModelId: model,
    modelConfig: {
      providerId: 'openai_compatible',
      protocol: 'openai_responses',
      baseUrl: `https://${id}.example.test/v1`,
      model,
      hasApiKey: true,
      reasoningEfforts
    }
  }
}

function agentConnection(): AiConnection {
  return {
    id: 'runtime:codex',
    adapterId: 'codex',
    backendKind: 'coding_plan',
    providerId: 'openai_codex',
    displayName: 'OpenAI Codex',
    credentialMode: 'provider_runtime',
    status: 'ready',
    models: [{
      id: 'codex-small',
      displayName: 'Codex small',
      reasoningEfforts: ['low', 'medium', 'high']
    }],
    defaultModelId: 'codex-small'
  }
}

function modelRuntime(modelId: string): ModelRuntime {
  return {
    model: { id: modelId } as ModelRuntime['model'],
    streamFn: (() => {
      throw new Error('fake stream is not called directly')
    }) as ModelRuntime['streamFn']
  }
}

class FakeAiBackend implements AiBackendPort {
  readonly generationCalls: Array<{
    connectionId: string
    modelId: string
    request: ModelGenerationRequest
  }> = []
  readonly runtimeCalls: Array<{ connectionId: string; modelId: string }> = []
  readonly runtimeHealthTracking: boolean[] = []
  generationHandler?: (
    connectionId: string,
    modelId: string,
    request: ModelGenerationRequest
  ) => Promise<{ text: string }>

  constructor(readonly connections: AiConnection[]) {}

  snapshot(): AiBackendSnapshot {
    return { options: [], connections: structuredClone(this.connections) }
  }

  subscribe(_listener: (snapshot: AiBackendSnapshot) => void): () => void {
    return () => undefined
  }

  async generateWithModel(
    connectionId: string,
    modelId: string,
    request: ModelGenerationRequest
  ): Promise<{ text: string }> {
    this.generationCalls.push({ connectionId, modelId, request })
    request.signal?.throwIfAborted()
    if (this.generationHandler) return this.generationHandler(connectionId, modelId, request)
    return { text: '# Evidence Map\n\nCandidate evidence.' }
  }

  async withModelRuntime<T>(
    connectionId: string,
    modelId: string,
    operation: (runtime: ModelRuntime) => Promise<T>,
    options?: { trackHealth?: boolean }
  ): Promise<T> {
    this.runtimeCalls.push({ connectionId, modelId })
    this.runtimeHealthTracking.push(Boolean(options?.trackHealth))
    const connection = this.connections.find((candidate) => candidate.id === connectionId)
    if (!connection?.models.some((model) => model.id === modelId)) throw new Error('未找到 Model')
    return operation(modelRuntime(modelId))
  }
}

class FakeKnowledgeAgent implements KnowledgeAgentRuntime {
  readonly calls: KnowledgeAgentRunInput[] = []
  handler?: (input: KnowledgeAgentRunInput) => Promise<KnowledgeAgentRunResult>

  async run(input: KnowledgeAgentRunInput): Promise<KnowledgeAgentRunResult> {
    this.calls.push(input)
    input.signal.throwIfAborted()
    if (this.handler) return this.handler(input)
    input.onTrace?.({ type: 'model_started', callNumber: 1 })
    input.onTrace?.({
      type: 'model_completed',
      callNumber: 1,
      status: 'completed',
      detail: 'stop=toolUse · tokens=120'
    })
    input.onTrace?.({ type: 'tool_started', toolCallId: 'read-1', toolName: 'read_evidence' })
    input.onTrace?.({
      type: 'tool_completed',
      toolCallId: 'read-1',
      toolName: 'read_evidence',
      status: 'completed',
      detail: 'L000001-L000001 · 1 行'
    })
    input.onTrace?.({ type: 'model_started', callNumber: 2 })
    input.onTrace?.({
      type: 'model_completed',
      callNumber: 2,
      status: 'completed',
      detail: 'stop=toolUse · tokens=80'
    })
    input.onTrace?.({
      type: 'tool_started',
      toolCallId: 'submit-1',
      toolName: 'submit_knowledge_contribution'
    })
    input.onTrace?.({
      type: 'tool_completed',
      toolCallId: 'submit-1',
      toolName: 'submit_knowledge_contribution',
      status: 'completed',
      detail: '捕获 1 条候选 Statement'
    })
    return {
      contribution: {
        runRef: input.contributionRunRef,
        statements: [{
          localRef: 'candidate-1',
          title: 'Candidate',
          content: 'Candidate Knowledge Statement',
          sources: [{ sourceRef: input.sourceRef, selector: 'L000001-L000001' }]
        }]
      },
      modelCallCount: 2,
      toolCalls: ['read_evidence', 'submit_knowledge_contribution']
    }
  }
}

function createService(options: {
  repository?: KnowledgeProcessingRepository
  connections?: AiConnection[]
  agent?: FakeKnowledgeAgent
  serviceOptions?: KnowledgeProcessingServiceOptions
} = {}) {
  const repository = options.repository ?? new InMemoryKnowledgeProcessingRepository()
  const backend = new FakeAiBackend(options.connections ?? [agentConnection(), modelConnection('model:a'), modelConnection('model:b')])
  const agent = options.agent ?? new FakeKnowledgeAgent()
  const service = new KnowledgeProcessingService(repository, backend, agent, options.serviceOptions)
  return { service, repository, backend, agent }
}

async function configure(
  service: KnowledgeProcessingService,
  stageId: ProcessingStageId,
  connectionId = 'model:a',
  instructionsOverride: string | null = null,
  modelId = connectionId
): Promise<void> {
  await service.saveStage({ stageId, connectionId, modelId, instructionsOverride })
}

function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const rejectFromSignal = (): void => reject(signal.reason ?? new Error('aborted'))
    if (signal.aborted) rejectFromSignal()
    else signal.addEventListener('abort', rejectFromSignal, { once: true })
  })
}

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('KnowledgeProcessingService', () => {
  it('exposes both fixed stages with their actual default and effective prompts', async () => {
    const { service } = createService()
    await service.initialize()

    const snapshot = service.snapshot()
    expect(snapshot.stages).toHaveLength(2)
    expect(snapshot.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'observation_preprocessor',
        defaultInstructions: OBSERVATION_PREPROCESSOR_PROMPT,
        effectiveInstructions: OBSERVATION_PREPROCESSOR_PROMPT,
        isCustomized: false
      }),
      expect.objectContaining({
        id: 'knowledge_maintenance_agent',
        defaultInstructions: KNOWLEDGE_MAINTENANCE_AGENT_PROMPT,
        effectiveInstructions: KNOWLEDGE_MAINTENANCE_AGENT_PROMPT,
        isCustomized: false
      })
    ]))
  })

  it('uses product-agnostic English defaults that follow the source language', () => {
    for (const prompt of [OBSERVATION_PREPROCESSOR_PROMPT, KNOWLEDGE_MAINTENANCE_AGENT_PROMPT]) {
      expect(prompt).not.toContain('Oyster')
      expect(prompt).not.toMatch(/[\u3400-\u9fff]/u)
      expect(prompt).toContain('primary language of the original')
      expect(prompt).toContain('preserving important original terms')
    }

    expect(OBSERVATION_PREPROCESSOR_PROMPT).toContain('Output only the Evidence Map as Markdown.')
    expect(KNOWLEDGE_MAINTENANCE_AGENT_PROMPT).toContain('submit_knowledge_contribution')
  })

  it('persists prompt overrides and restores the default by removing the override', async () => {
    const repository = new InMemoryKnowledgeProcessingRepository()
    const first = createService({ repository })
    await first.service.initialize()

    let snapshot = await first.service.saveStage({
      stageId: 'observation_preprocessor',
      connectionId: 'model:a',
      modelId: 'model:a',
      instructionsOverride: '  custom preprocessor instructions  '
    })
    expect(snapshot.stages[0]).toMatchObject({
      connectionId: 'model:a',
      modelId: 'model:a',
      effectiveInstructions: 'custom preprocessor instructions',
      isCustomized: true
    })

    const restarted = createService({ repository })
    await restarted.service.initialize()
    expect(restarted.service.snapshot().stages[0]).toMatchObject({
      connectionId: 'model:a',
      modelId: 'model:a',
      effectiveInstructions: 'custom preprocessor instructions',
      isCustomized: true
    })

    snapshot = await restarted.service.saveStage({
      stageId: 'observation_preprocessor',
      connectionId: 'model:a',
      modelId: 'model:a',
      instructionsOverride: null
    })
    expect(snapshot.stages[0]).toMatchObject({
      effectiveInstructions: OBSERVATION_PREPROCESSOR_PROMPT,
      isCustomized: false
    })
    expect(await repository.load()).toEqual({
      stages: [{
        stageId: 'observation_preprocessor',
        connectionId: 'model:a',
        modelId: 'model:a'
      }]
    })
  })

  it('does not impose a separate fixed character ceiling on editable stage prompts', async () => {
    const repository = new InMemoryKnowledgeProcessingRepository()
    const { service } = createService({ repository })
    await service.initialize()
    const instructions = `Maintain the configured role.\n${'context '.repeat(3_000)}`.trim()

    const snapshot = await service.saveStage({
      stageId: 'knowledge_maintenance_agent',
      connectionId: 'model:a',
      modelId: 'model:a',
      instructionsOverride: instructions
    })

    expect(instructions.length).toBeGreaterThan(20_000)
    expect(snapshot.stages.find((stage) => stage.id === 'knowledge_maintenance_agent'))
      .toMatchObject({ effectiveInstructions: instructions, isCustomized: true })
    await expect(repository.load()).resolves.toMatchObject({
      stages: [expect.objectContaining({ instructionsOverride: instructions })]
    })
  })

  it('persists a supported per-stage reasoning effort and passes it through both runtimes', async () => {
    const connection = modelConnection('model:reasoning', 'reasoning-model', ['low', 'high'])
    const repository = new InMemoryKnowledgeProcessingRepository()
    const { service, backend, agent } = createService({ repository, connections: [connection] })
    await service.initialize()

    await service.saveStage({
      stageId: 'observation_preprocessor',
      connectionId: connection.id,
      modelId: 'reasoning-model',
      instructionsOverride: null,
      reasoningEffort: 'low'
    })
    await service.saveStage({
      stageId: 'knowledge_maintenance_agent',
      connectionId: connection.id,
      modelId: 'reasoning-model',
      instructionsOverride: null,
      reasoningEffort: 'high'
    })

    expect(service.snapshot().stages.map((stage) => stage.reasoningEffort)).toEqual(['low', 'high'])
    const preprocessing = await service.runObservationPreprocessor({ observation: 'Observation' })
    await service.runKnowledgeMaintenance({ preprocessingRunId: preprocessing.runId })

    expect(backend.generationCalls[0].request.reasoningEffort).toBe('low')
    expect(agent.calls[0].reasoningEffort).toBe('high')
    expect(preprocessing.execution.reasoningEffort).toBe('low')
    expect(await repository.load()).toMatchObject({
      stages: [
        { stageId: 'observation_preprocessor', reasoningEffort: 'low' },
        { stageId: 'knowledge_maintenance_agent', reasoningEffort: 'high' }
      ]
    })

    await expect(service.saveStage({
      stageId: 'observation_preprocessor',
      connectionId: connection.id,
      modelId: 'reasoning-model',
      instructionsOverride: null,
      reasoningEffort: 'medium'
    })).rejects.toThrow('不支持')
  })

  it('isolates damaged configuration without hiding model connections or overwriting the file', async () => {
    let saveCount = 0
    const repository: KnowledgeProcessingRepository = {
      load: async () => { throw new Error('invalid JSON') },
      save: async () => { saveCount += 1 }
    }
    const { service } = createService({ repository })

    await expect(service.initialize()).resolves.toBeUndefined()
    expect(service.snapshot()).toMatchObject({
      connections: [{ id: 'runtime:codex' }, { id: 'model:a' }, { id: 'model:b' }],
      configurationError: expect.stringContaining('invalid JSON')
    })
    await expect(service.saveStage({
      stageId: 'observation_preprocessor',
      connectionId: 'model:a',
      modelId: 'model:a',
      instructionsOverride: null
    })).rejects.toThrow('不可修改')
    expect(saveCount).toBe(0)
  })

  it('lists both Coding Plan and API Connections and validates each selected model', async () => {
    const { service, backend } = createService()
    await service.initialize()

    expect(service.snapshot().connections.map((connection) => connection.id)).toEqual([
      'runtime:codex',
      'model:a',
      'model:b'
    ])
    await expect(service.saveStage({
      stageId: 'knowledge_maintenance_agent',
      connectionId: 'runtime:codex',
      modelId: 'codex-small',
      instructionsOverride: null
    })).resolves.toMatchObject({
      stages: expect.arrayContaining([
        expect.objectContaining({
          id: 'knowledge_maintenance_agent',
          connectionId: 'runtime:codex',
          modelId: 'codex-small'
        })
      ])
    })
    await expect(service.saveStage({
      stageId: 'knowledge_maintenance_agent',
      connectionId: 'runtime:codex',
      modelId: 'not-a-codex-model',
      instructionsOverride: null
    })).rejects.toThrow('不属于该 Connection')

    await configure(service, 'observation_preprocessor', 'model:a')
    backend.connections.splice(backend.connections.findIndex((item) => item.id === 'model:a'), 1)
    expect(service.snapshot().stages[0]).toMatchObject({
      connectionId: 'model:a',
      modelId: 'model:a'
    })
    await expect(service.runObservationPreprocessor({ observation: 'test' }))
      .rejects.toThrow('已配置的 Model Connection 不再可用')
  })

  it('never falls back when the explicitly selected Model or reasoning effort disappears', async () => {
    const connection = modelConnection('model:dynamic', 'selected', ['high'])
    connection.models.push({
      id: 'fallback',
      displayName: 'Fallback',
      reasoningEfforts: []
    })
    connection.defaultModelId = 'fallback'
    const { service, backend } = createService({ connections: [connection] })
    await service.initialize()
    await service.saveStage({
      stageId: 'observation_preprocessor',
      connectionId: connection.id,
      modelId: 'selected',
      instructionsOverride: null,
      reasoningEffort: 'high'
    })

    connection.models.splice(connection.models.findIndex((model) => model.id === 'selected'), 1)
    expect(service.snapshot().stages[0]).toMatchObject({
      connectionId: connection.id,
      modelId: 'selected',
      reasoningEffort: 'high'
    })
    await expect(service.runObservationPreprocessor({ observation: 'test' }))
      .rejects.toThrow('系统不会自动回退到其他 Model')
    expect(backend.generationCalls).toHaveLength(0)

    connection.models.unshift({
      id: 'selected',
      displayName: 'Selected',
      reasoningEfforts: []
    })
    await expect(service.runObservationPreprocessor({ observation: 'test' }))
      .rejects.toThrow('系统不会自动改用模型默认值')
    expect(backend.generationCalls).toHaveLength(0)
  })

  it('requires each stage to have an explicitly saved Connection and Model', async () => {
    const { service, backend, agent } = createService()
    await service.initialize()

    await expect(service.runObservationPreprocessor({ observation: 'test' }))
      .rejects.toThrow('先为该阶段选择并保存')
    await expect(service.runKnowledgeMaintenance({ preprocessingRunId: 'missing' }))
      .rejects.toThrow('先为该阶段选择并保存')
    expect(backend.generationCalls).toHaveLength(0)
    expect(backend.runtimeCalls).toHaveLength(0)
    expect(agent.calls).toHaveLength(0)
  })

  it('sends the effective System Prompt, numbered observation, and attention to the selected model', async () => {
    const { service, backend } = createService()
    await service.initialize()
    await configure(service, 'observation_preprocessor', 'model:b', 'custom system prompt')

    const result = await service.runObservationPreprocessor({
      observation: 'first line\rsecond line\r\nthird line',
      attention: '  decisions only  '
    })

    expect(result.runId).toBeTruthy()
    expect(result.sourceRef).toBe(`workspace:${result.runId}:observation`)
    expect(result.execution).toMatchObject({
      connectionId: 'model:b',
      model: 'model:b',
      backendKind: 'api',
      runtime: 'direct_model_call',
      modelCallCount: 1
    })
    expect(backend.generationCalls).toHaveLength(1)
    expect(backend.generationCalls[0].connectionId).toBe('model:b')
    expect(backend.generationCalls[0].modelId).toBe('model:b')
    expect(backend.generationCalls[0].request.systemPrompt).toBe('custom system prompt')
    expect(backend.generationCalls[0].request.prompt).toContain('Operator attention:\ndecisions only')
    expect(backend.generationCalls[0].request.prompt).toContain(`Source reference: ${result.sourceRef}`)
    expect(backend.generationCalls[0].request.prompt).toContain(
      'L000001 | first line\nL000002 | second line\nL000003 | third line'
    )
    expect(result.segmentCount).toBe(1)
  })

  it('lets the selected model context budget, rather than a fixed Attention length, govern preprocessing', async () => {
    const connection = modelConnection('model:attention', 'attention-model', [], 100_000)
    const { service, backend } = createService({ connections: [connection] })
    await service.initialize()
    await configure(service, 'observation_preprocessor', connection.id, null, 'attention-model')
    const attention = 'important context '.repeat(700)

    await expect(service.runObservationPreprocessor({
      observation: 'one fact',
      attention
    })).resolves.toMatchObject({ segmentCount: 1 })

    expect(attention.length).toBeGreaterThan(10_000)
    expect(backend.generationCalls[0].request.prompt).toContain(attention.trim())
  })

  it('keeps the Evidence Map complete while bounding its debug trace copy', async () => {
    const { service, backend } = createService()
    await service.initialize()
    await configure(service, 'observation_preprocessor')
    const completeOutput = 'x'.repeat(10_000)
    backend.generationHandler = async () => ({ text: completeOutput })

    const result = await service.runObservationPreprocessor({ observation: 'one line' })

    expect(result.evidenceMap).toContain('Selected source ranges: L000001-L000001')
    expect(result.evidenceMap).toContain('First evidence read location: L000001:C0')
    expect(result.evidenceMap).toContain('First bounded read call: read_evidence({"line":1,"offset":0,"limit":16384})')
    expect(result.evidenceMap).toContain(completeOutput)
    expect(result.debugTrace.preprocessing?.calls[0]).toMatchObject({
      status: 'completed',
      outputTruncated: true
    })
    expect(result.debugTrace.preprocessing?.calls[0].output).toHaveLength(8 * 1_024)
    expect(result.debugTrace.preprocessing?.calls[0].output?.endsWith('…')).toBe(true)
  })

  it('splits sparse selectors and keeps exact leaf locators out of the bounded root navigation', async () => {
    const connection = modelConnection('model:large-context', 'large-context', [], 400_000)
    const { service, backend, agent } = createService({ connections: [connection] })
    await service.initialize()
    await configure(
      service,
      'observation_preprocessor',
      connection.id,
      null,
      'large-context'
    )
    await configure(
      service,
      'knowledge_maintenance_agent',
      connection.id,
      null,
      'large-context'
    )
    backend.generationHandler = async () => ({ text: 'M'.repeat(20_000) })
    // The serialized Observation plus selectors fits the normal 120 KB material
    // budget; the per-section selector boundary must still prevent one huge root.
    const rawLines = Array.from({ length: 3_999 }, (_, index) => index % 2 === 0 ? 'x' : '')
    const view: ObservationView = {
      formatVersion: 'sparse-test-v1',
      rawLines,
      units: rawLines.flatMap((content, index) => content
        ? [{
            lineNumber: index + 1,
            content,
            startCharacter: 0,
            endCharacter: content.length,
            totalCharacters: content.length
          }]
        : [])
    }

    const result = await service.runObservationPreprocessorView(view)

    expect(result.segmentCount).toBeGreaterThan(1)
    expect(result.evidenceMap.length).toBeLessThan(32 * 1_024)
    expect(result.evidenceMap).toContain('M'.repeat(20_000))
    expect(result.evidenceMap).not.toContain('Selected source ranges:')
    const mergeCalls = backend.generationCalls.filter(
      (call) => call.request.prompt.includes('BEGIN_EVIDENCE_MAP_MATERIALS')
    )
    expect(mergeCalls.length).toBeGreaterThan(0)
    expect(mergeCalls.every((call) => (
      call.request.prompt.includes('Source coverage extent:')
      && call.request.prompt.includes('Exact selected ranges remain attached')
      && !call.request.prompt.includes('Selected source ranges:')
    ))).toBe(true)

    await service.runKnowledgeMaintenance({ preprocessingRunId: result.runId })
    const exactLeafSelectors = agent.calls[0].evidenceMapSections
      .filter((section) => !section.children)
      .flatMap((section) => section.selectors)
    expect(agent.calls[0].evidenceMapSections
      .filter((section) => !section.children)
      .every((section) => (
        Buffer.byteLength(section.selectors.join(', '), 'utf8')
          <= MAX_OBSERVATION_SEGMENT_SELECTOR_BYTES
      ))).toBe(true)
    expect(exactLeafSelectors).toHaveLength(rawLines.filter(Boolean).length)
    expect(exactLeafSelectors[0]).toBe('L000001-L000001')
    expect(exactLeafSelectors.at(-1)).toBe('L003999-L003999')
  })

  it('maps a long Observation in independent global ranges and assembles a bounded navigation map', async () => {
    const { service, backend, agent } = createService({
      serviceOptions: {
        evidenceMapPlanner: {
          segmentBytes: 55,
          adjacentContextBytes: 18,
          mergeBytes: 1_000
        }
      }
    })
    await service.initialize()
    await configure(service, 'observation_preprocessor', 'model:b', 'custom system prompt')
    await configure(service, 'knowledge_maintenance_agent', 'runtime:codex', null, 'codex-small')
    const progress: Array<ReturnType<typeof service.snapshot>['preprocessingProgress']> = []
    const debugTraces: Array<ReturnType<typeof service.snapshot>['debugTraces'][number]> = []
    service.subscribe((snapshot) => {
      progress.push(snapshot.preprocessingProgress)
      const trace = snapshot.debugTraces.find((candidate) => candidate.origin === 'stage_debug')
      if (trace) debugTraces.push(trace)
    })
    backend.generationHandler = async (_connectionId, _modelId, request) => {
      const prompt = request.prompt
      if (prompt.includes('BEGIN_EVIDENCE_MAP_MATERIALS')) return { text: 'ROOT NAVIGATION' }
      if (prompt.includes('source ranges L000001-L000002')) return { text: 'LEAF A' }
      if (prompt.includes('source ranges L000003-L000004')) return { text: 'LEAF B' }
      throw new Error('unexpected preprocessing prompt')
    }

    const result = await service.runObservationPreprocessor({
      observation: 'line-one\nline-two\nline-three\nline-four',
      attention: 'preserve corrections'
    })

    expect(result).toMatchObject({
      segmentCount: 2,
      execution: { modelCallCount: 3 }
    })
    expect(result.evidenceMap).toContain('ROOT NAVIGATION')
    expect(result.evidenceMap).toContain('- Root map section: M000003')
    expect(result.evidenceMap).toContain('- Immediate child sections: M000001, M000002')
    expect(backend.generationCalls).toHaveLength(3)
    const firstPrompt = backend.generationCalls[0].request.prompt
    const secondPrompt = backend.generationCalls[1].request.prompt
    const mergePrompt = backend.generationCalls[2].request.prompt
    expect(firstPrompt).toContain('L000001 | line-one\nL000002 | line-two')
    expect(secondPrompt).toContain('BEGIN_ADJACENT_CONTEXT\nL000002 | line-two')
    expect(secondPrompt).toContain('BEGIN_AUTHORIZED_OBSERVATION\nL000003 | line-three\nL000004 | line-four')
    expect(mergePrompt).toContain('LEAF A')
    expect(mergePrompt).toContain('LEAF B')
    expect(mergePrompt).not.toContain('line-one')
    expect(backend.generationCalls.every((call) => call.connectionId === 'model:b')).toBe(true)
    expect(backend.generationCalls.every((call) => call.request.systemPrompt === 'custom system prompt')).toBe(true)
    expect(progress).toEqual(expect.arrayContaining([
      { phase: 'mapping', completedSegments: 0, totalSegments: 2 },
      { phase: 'mapping', completedSegments: 2, totalSegments: 2 },
      { phase: 'assembling', completedSegments: 2, totalSegments: 2 }
    ]))
    expect(result.debugTrace).toMatchObject({
      id: result.runId,
      origin: 'stage_debug',
      status: 'completed',
      preprocessing: {
        phase: 'completed',
        completedSegments: 2,
        totalSegments: 2,
        calls: [
          { sequence: 1, kind: 'segment_map', selectors: ['L000001-L000002'], status: 'completed', output: 'LEAF A' },
          { sequence: 2, kind: 'segment_map', selectors: ['L000003-L000004'], status: 'completed', output: 'LEAF B' },
          { sequence: 3, kind: 'navigation_merge', selectors: ['L000001-L000004'], status: 'completed', output: 'ROOT NAVIGATION' }
        ]
      }
    })
    expect(debugTraces.some((trace) => trace.preprocessing?.calls.some(
      (call) => call.status === 'completed' && call.output === 'LEAF A'
    ))).toBe(true)

    await service.runKnowledgeMaintenance({ preprocessingRunId: result.runId })
    expect(agent.calls[0].evidenceMap).toBe(result.evidenceMap)
    expect(agent.calls[0].evidenceMapSections).toEqual([
      {
        id: 'M000001',
        selectors: ['L000001-L000002'],
        readLocation: { line: 1, offset: 0 },
        content: 'LEAF A'
      },
      {
        id: 'M000002',
        selectors: ['L000003-L000004'],
        readLocation: { line: 3, offset: 0 },
        content: 'LEAF B'
      },
      {
        id: 'M000003',
        selectors: ['L000001-L000004'],
        readLocation: { line: 1, offset: 0 },
        content: 'ROOT NAVIGATION',
        children: ['M000001', 'M000002']
      }
    ])
  })

  it('processes an external Observation above the former 120000-byte read limit with default budgets', async () => {
    const { service, backend } = createService()
    await service.initialize()
    await configure(service, 'observation_preprocessor')
    backend.generationHandler = async (_connectionId, _modelId, request) => ({
      text: request.prompt.includes('BEGIN_EVIDENCE_MAP_MATERIALS')
        ? 'ROOT FOR LARGE SESSION'
        : 'LOCAL MAP'
    })
    const observation = `${'a'.repeat(70_000)}\n${'b'.repeat(70_000)}`

    const result = await service.runObservationPreprocessor(
      { observation },
      undefined,
      { sourceRef: 'raw:test-large@sha256:revision' }
    )

    expect(result.segmentCount).toBeGreaterThan(2)
    expect(result.execution.modelCallCount).toBeGreaterThan(result.segmentCount)
    expect(backend.generationCalls).toHaveLength(result.execution.modelCallCount)
    expect(backend.generationCalls[0].request.prompt).toContain('L000001 C0:')
    expect(backend.generationCalls.some((call) => call.request.prompt.includes('L000002 C0:'))).toBe(true)
    expect(result.evidenceMap).toContain('ROOT FOR LARGE SESSION')
  })

  it('bounds every complete preprocessing request by the selected model context window', async () => {
    const connection = modelConnection('model:bounded', 'bounded', [], 32_768)
    const { service, backend } = createService({ connections: [connection] })
    await service.initialize()
    await configure(service, 'observation_preprocessor', connection.id, 'short system', 'bounded')
    backend.generationHandler = async (_connectionId, _modelId, request) => ({
      text: request.prompt.includes('BEGIN_EVIDENCE_MAP_MATERIALS') ? 'ROOT' : 'LOCAL'
    })

    const result = await service.runObservationPreprocessor({
      observation: `中文${'😀abc'.repeat(20_000)}`,
      attention: 'preserve details'
    })

    const maximumInputBytes = 32_768 - 4_096 - 4_096
    expect(result.segmentCount).toBeGreaterThan(1)
    expect(backend.generationCalls.every((call) => (
      Buffer.byteLength(call.request.systemPrompt ?? '', 'utf8')
        + Buffer.byteLength(call.request.prompt, 'utf8')
    ) <= maximumInputBytes)).toBe(true)
    expect(backend.generationCalls.every((call) => (
      typeof call.request.maxOutputTokens === 'number'
      && call.request.maxOutputTokens > 0
      && call.request.maxOutputTokens <= 4_096
    ))).toBe(true)
  })

  it('automatically replans smaller segments after a provider reports context overflow', async () => {
    const connection = modelConnection('model:adaptive', 'adaptive')
    const { service, backend } = createService({ connections: [connection] })
    await service.initialize()
    await configure(service, 'observation_preprocessor', connection.id, null, 'adaptive')
    let overflowed = false
    backend.generationHandler = async (_connectionId, _modelId, request) => {
      if (!overflowed) {
        overflowed = true
        throw new ModelContextOverflowError('provider context overflow')
      }
      return { text: request.prompt.includes('BEGIN_EVIDENCE_MAP_MATERIALS') ? 'ROOT' : 'LOCAL' }
    }

    const result = await service.runObservationPreprocessor({ observation: 'x'.repeat(30_000) })

    expect(result.segmentCount).toBeGreaterThan(2)
    expect(result.execution.modelCallCount).toBe(backend.generationCalls.length)
    expect(result.debugTrace.preprocessing?.calls[0]).toMatchObject({
      status: 'failed',
      error: '观察预处理模型调用失败'
    })
    expect(result.debugTrace.status).toBe('completed')
  })

  it('publishes each preprocessing call and its output while the remaining calls are still running', async () => {
    const { service, backend } = createService({
      serviceOptions: {
        evidenceMapPlanner: {
          segmentBytes: 32,
          adjacentContextBytes: 16,
          mergeBytes: 1_000
        }
      }
    })
    await service.initialize()
    await configure(service, 'observation_preprocessor')
    const responses = [deferred<{ text: string }>(), deferred<{ text: string }>(), deferred<{ text: string }>()]
    backend.generationHandler = async () => responses[backend.generationCalls.length - 1].promise

    const running = service.runObservationPreprocessor({ observation: 'line-1\nline-2' })
    await vi.waitFor(() => {
      expect(service.snapshot().debugTraces[0]?.preprocessing).toMatchObject({
        totalSegments: 2,
        calls: [{ sequence: 1, status: 'running' }]
      })
    })

    responses[0].resolve({ text: 'FIRST LIVE OUTPUT' })
    await vi.waitFor(() => {
      expect(service.snapshot().debugTraces[0]?.preprocessing?.calls).toMatchObject([
        { sequence: 1, status: 'completed', output: 'FIRST LIVE OUTPUT' },
        { sequence: 2, status: 'running' }
      ])
    })

    responses[1].resolve({ text: 'SECOND LIVE OUTPUT' })
    await vi.waitFor(() => {
      expect(service.snapshot().debugTraces[0]?.preprocessing?.calls).toMatchObject([
        { sequence: 1, status: 'completed' },
        { sequence: 2, status: 'completed', output: 'SECOND LIVE OUTPUT' },
        { sequence: 3, kind: 'navigation_merge', status: 'running' }
      ])
    })

    responses[2].resolve({ text: 'LIVE ROOT' })
    await expect(running).resolves.toMatchObject({
      debugTrace: {
        status: 'completed',
        preprocessing: { calls: [{}, {}, { output: 'LIVE ROOT', status: 'completed' }] }
      }
    })
  })

  it('does not let a throwing snapshot listener change preprocessing results', async () => {
    const { service } = createService()
    await service.initialize()
    await configure(service, 'observation_preprocessor')
    service.subscribe(() => {
      throw new Error('renderer snapshot sink failed')
    })

    await expect(service.runObservationPreprocessor({ observation: 'safe run' })).resolves.toMatchObject({
      evidenceMap: expect.stringContaining('Candidate evidence'),
      debugTrace: { status: 'completed' }
    })
  })

  it('recursively assembles navigation when all local maps do not fit one merge call', async () => {
    const { service, backend } = createService({
      serviceOptions: {
        evidenceMapPlanner: {
          segmentBytes: 39,
          adjacentContextBytes: 11,
          mergeBytes: 600
        }
      }
    })
    await service.initialize()
    await configure(service, 'observation_preprocessor')
    backend.generationHandler = async (_connectionId, _modelId, request) => {
      if (!request.prompt.includes('BEGIN_EVIDENCE_MAP_MATERIALS')) {
        return { text: `LEAF ${backend.generationCalls.length}` }
      }
      return { text: backend.generationCalls.length === 4 ? 'MID' : 'ROOT' }
    }

    const result = await service.runObservationPreprocessor({ observation: 'a\nb\nc\nd\ne' })

    expect(result).toMatchObject({
      segmentCount: 3,
      execution: { modelCallCount: 5 }
    })
    expect(result.evidenceMap).toContain('ROOT')
    expect(result.evidenceMap).toContain('- Root map section: M000005')
    expect(result.evidenceMap).toContain('- Immediate child sections: M000004, M000003')
    expect(backend.generationCalls.filter(
      (call) => call.request.prompt.includes('BEGIN_EVIDENCE_MAP_MATERIALS')
    )).toHaveLength(2)
  })

  it('automatically segments a manual Observation instead of imposing a total character limit', async () => {
    const { service, backend } = createService()
    await service.initialize()
    await configure(service, 'observation_preprocessor')
    backend.generationHandler = async (_connectionId, _modelId, request) => ({
      text: request.prompt.includes('BEGIN_EVIDENCE_MAP_MATERIALS') ? 'ROOT' : 'LOCAL'
    })

    const result = await service.runObservationPreprocessor({ observation: 'x'.repeat(120_001) })

    expect(result.segmentCount).toBeGreaterThan(1)
    expect(backend.generationCalls).toHaveLength(result.execution.modelCallCount)
    expect(backend.generationCalls[0].request.prompt).toContain('L000001 C0:')
    expect(service.snapshot().runningStageIds).toEqual([])
  })

  it('preprocesses a selective view while keeping the complete raw revision for Agent evidence reads', async () => {
    const { service, backend, agent } = createService()
    await service.initialize()
    await configure(service, 'observation_preprocessor')
    await configure(service, 'knowledge_maintenance_agent')
    const rawLines = [
      '{"type":"session_meta","payload":{"base_instructions":"runtime-only"}}',
      '{"type":"response_item","payload":{"type":"message","role":"user","content":"Keep the explicit rejection."}}',
      '{"type":"turn_context","payload":{"runtime_only":true}}',
      `{"type":"response_item","payload":{"type":"function_call_output","output":"${'DO_NOT_SEND_FULL_TOOL_OUTPUT'.repeat(500)}"}}`
    ]
    const view: ObservationView = {
      formatVersion: 'codex-jsonl-v3-test',
      rawLines,
      units: [
        {
          lineNumber: 2,
          content: rawLines[1],
          startCharacter: 0,
          endCharacter: rawLines[1].length,
          totalCharacters: rawLines[1].length,
          recordContext: 'Codex · record=message · role=user'
        },
        {
          lineNumber: 4,
          content: rawLines[3],
          startCharacter: 0,
          endCharacter: rawLines[3].length,
          totalCharacters: rawLines[3].length,
          modelContent: '{"kind":"tool_result","outcome":"success","rawDetailAvailable":true}',
          recordContext: 'Codex · record=tool_result'
        }
      ]
    }

    const result = await service.runObservationPreprocessorView(view)
    const modelPrompt = backend.generationCalls[0].request.prompt

    expect(modelPrompt).toContain('L000002')
    expect(modelPrompt).toContain('exact source ranges L000002-L000002, L000004-L000004')
    expect(modelPrompt).not.toContain('exact source ranges L000002-L000004')
    expect(modelPrompt).toContain('Keep the explicit rejection.')
    expect(modelPrompt).toContain('rawDetailAvailable')
    expect(modelPrompt).not.toContain('base_instructions')
    expect(modelPrompt).not.toContain('DO_NOT_SEND_FULL_TOOL_OUTPUT')
    expect(result.debugTrace.preprocessing?.view).toMatchObject({
      formatVersion: 'codex-jsonl-v3-test',
      sourceLineCount: 4,
      selectedLineCount: 2,
      selectedUnitCount: 2
    })
    expect(result.debugTrace.preprocessing?.view?.modelMaterialBytes)
      .toBeLessThan(result.debugTrace.preprocessing!.view!.selectedSourceBytes)
    expect(result.debugTrace.preprocessing?.calls[0].selectors).toEqual([
      'L000002-L000002',
      'L000004-L000004'
    ])

    await service.runKnowledgeMaintenance({ preprocessingRunId: result.runId })
    expect(agent.calls[0].observationLines).toEqual(rawLines)
  })

  it('losslessly splits one oversized physical line before model calls', async () => {
    const { service, backend, agent } = createService({
      serviceOptions: {
        evidenceMapPlanner: {
          segmentBytes: 5_000,
          adjacentContextBytes: 1_000,
          mergeBytes: 10_000
        }
      }
    })
    await service.initialize()
    await configure(service, 'observation_preprocessor')
    await configure(service, 'knowledge_maintenance_agent')
    backend.generationHandler = async (_connectionId, _modelId, request) => ({
      text: request.prompt.includes('BEGIN_EVIDENCE_MAP_MATERIALS') ? 'ROOT' : 'LOCAL'
    })

    const observation = '1234567890'.repeat(1_200)
    const result = await service.runObservationPreprocessor({ observation })

    expect(result.segmentCount).toBeGreaterThan(1)
    expect(backend.generationCalls.filter(
      (call) => call.request.prompt.includes('BEGIN_AUTHORIZED_OBSERVATION')
    ).every((call) => call.request.prompt.includes('L000001 C'))).toBe(true)
    await service.runKnowledgeMaintenance({ preprocessingRunId: result.runId })
    const windows = agent.calls[0].evidenceMapSections.flatMap(
      (section) => section.characterWindow && !section.children ? [section.characterWindow] : []
    )
    const readLocations = agent.calls[0].evidenceMapSections
      .filter((section) => section.characterWindow && !section.children)
      .map((section) => section.readLocation)
    expect(windows.length).toBe(result.segmentCount)
    expect(windows[0].startCharacter).toBe(0)
    expect(windows.at(-1)?.endCharacter).toBe(observation.length)
    expect(windows.every((window, index) => (
      index === 0 || window.startCharacter === windows[index - 1].endCharacter
    ))).toBe(true)
    expect(readLocations).toEqual(windows.map((window) => ({
      line: 1,
      offset: window.startCharacter
    })))
    expect(service.snapshot().runningStageIds).toEqual([])
    expect(service.snapshot().preprocessingProgress).toBeUndefined()
  })

  it('processes more than 32 segments without a run-level segment or call ceiling', async () => {
    const { service, backend } = createService({
      serviceOptions: {
        evidenceMapPlanner: {
          segmentBytes: 30,
          adjacentContextBytes: 2,
          mergeBytes: 1_000
        }
      }
    })
    await service.initialize()
    await configure(service, 'observation_preprocessor')
    backend.generationHandler = async () => ({ text: 'MAP' })

    const result = await service.runObservationPreprocessor({
      observation: Array.from({ length: 33 }, () => '12345').join('\n')
    })

    expect(result.segmentCount).toBe(33)
    expect(result.execution.modelCallCount).toBeGreaterThan(33)
    expect(backend.generationCalls).toHaveLength(result.execution.modelCallCount)
    expect(service.snapshot().runningStageIds).toEqual([])
    expect(service.snapshot().preprocessingProgress).toBeUndefined()
  })

  it('does not publish a partial workspace when a later segment fails', async () => {
    const { service, backend, agent } = createService({
      serviceOptions: {
        evidenceMapPlanner: {
          segmentBytes: 32,
          adjacentContextBytes: 16,
          mergeBytes: 1_000
        }
      }
    })
    await service.initialize()
    await configure(service, 'observation_preprocessor')
    await configure(service, 'knowledge_maintenance_agent')
    let failedRunId = ''
    backend.generationHandler = async (_connectionId, _modelId, request) => {
      failedRunId ||= request.prompt.match(/Source reference: workspace:([^:]+):observation/)?.[1] ?? ''
      if (backend.generationCalls.length === 1) return { text: 'FIRST LEAF' }
      throw new Error('segment two failed')
    }

    await expect(service.runObservationPreprocessor({
      observation: 'line-1\nline-2\nline-3'
    })).rejects.toThrow('segment two failed')

    expect(failedRunId).toBeTruthy()
    expect(backend.generationCalls).toHaveLength(2)
    await expect(service.runKnowledgeMaintenance({ preprocessingRunId: failedRunId }))
      .rejects.toThrow('工作区已不存在')
    expect(agent.calls).toHaveLength(0)
    expect(service.snapshot().runningStageIds).toEqual([])
    expect(service.snapshot().preprocessingProgress).toBeUndefined()
    expect(service.snapshot().debugTraces.find((trace) => trace.origin === 'stage_debug'))
      .toMatchObject({
        status: 'failed',
        preprocessing: {
          completedSegments: 1,
          calls: [
            { status: 'completed', output: 'FIRST LEAF' },
            { status: 'failed', error: '观察预处理模型调用失败' }
          ]
        }
      })
  })

  it('propagates cancellation to a later segment and skips navigation assembly', async () => {
    const { service, backend } = createService({
      serviceOptions: {
        evidenceMapPlanner: {
          segmentBytes: 32,
          adjacentContextBytes: 16,
          mergeBytes: 1_000
        }
      }
    })
    await service.initialize()
    await configure(service, 'observation_preprocessor')
    let secondStarted!: () => void
    const enteredSecondSegment = new Promise<void>((resolve) => { secondStarted = resolve })
    backend.generationHandler = async (_connectionId, _modelId, request) => {
      if (backend.generationCalls.length === 1) return { text: 'FIRST LEAF' }
      secondStarted()
      return rejectWhenAborted(request.signal!)
    }

    const running = service.runObservationPreprocessor({ observation: 'line-1\nline-2' })
    await enteredSecondSegment
    service.cancelRun('observation_preprocessor')

    await expect(running).rejects.toThrow('用户取消')
    expect(backend.generationCalls).toHaveLength(2)
    expect(backend.generationCalls.some((call) => call.request.prompt.includes('BEGIN_EVIDENCE_MAP_MATERIALS')))
      .toBe(false)
    expect(service.snapshot().runningStageIds).toEqual([])
    expect(service.snapshot().preprocessingProgress).toBeUndefined()
    expect(service.snapshot().debugTraces.find((trace) => trace.origin === 'stage_debug'))
      .toMatchObject({
        status: 'cancelled',
        preprocessing: {
          calls: [
            { status: 'completed', output: 'FIRST LEAF' },
            { status: 'cancelled' }
          ]
        }
      })
  })

  it('does not impose a fixed whole-run deadline on long preprocessing jobs', async () => {
    vi.useFakeTimers()
    try {
      const { service, backend } = createService()
      await service.initialize()
      await configure(service, 'observation_preprocessor')
      backend.generationHandler = async (_connectionId, _modelId, request) => (
        rejectWhenAborted(request.signal!)
      )

      const running = service.runObservationPreprocessor({ observation: 'one line' })
      expect(backend.generationCalls).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(31 * 60_000)
      expect(service.snapshot().runningStageIds).toContain('observation_preprocessor')
      service.cancelRun('observation_preprocessor')
      await expect(running).rejects.toThrow('用户取消')
      expect(service.snapshot().runningStageIds).toEqual([])
      expect(service.snapshot().preprocessingProgress).toBeUndefined()
      expect(service.snapshot().debugTraces.find((trace) => trace.origin === 'stage_debug'))
        .toMatchObject({
          status: 'cancelled',
          preprocessing: { calls: [{ status: 'cancelled' }] }
        })
    } finally {
      vi.useRealTimers()
    }
  })

  it('passes only a valid temporary preprocessing workspace to the Agent and does not persist results', async () => {
    const repository = new InMemoryKnowledgeProcessingRepository()
    const { service, backend, agent } = createService({ repository })
    await service.initialize()
    await configure(service, 'observation_preprocessor', 'model:a')
    await configure(
      service,
      'knowledge_maintenance_agent',
      'runtime:codex',
      'custom maintainer prompt',
      'codex-small'
    )

    await expect(service.runKnowledgeMaintenance({ preprocessingRunId: 'unknown' }))
      .rejects.toThrow('工作区已不存在')
    expect(agent.calls).toHaveLength(0)

    const preprocessing = await service.runObservationPreprocessor({
      observation: 'alpha\nbeta',
      attention: 'original attention'
    })
    const stateBeforeMaintenance = await repository.load()
    const maintenance = await service.runKnowledgeMaintenance({
      preprocessingRunId: preprocessing.runId,
      attention: 'maintenance attention'
    })

    expect(backend.runtimeCalls).toEqual([{
      connectionId: 'runtime:codex',
      modelId: 'codex-small'
    }])
    expect(backend.runtimeHealthTracking).toEqual([true])
    expect(agent.calls).toHaveLength(1)
    expect(agent.calls[0]).toMatchObject({
      systemPrompt: 'custom maintainer prompt',
      evidenceMap: preprocessing.evidenceMap,
      observationLines: ['alpha', 'beta'],
      sourceRef: preprocessing.sourceRef,
      attention: 'maintenance attention',
      runtime: { model: { id: 'codex-small' } }
    })
    expect(maintenance).toMatchObject({
      preprocessingRunId: preprocessing.runId,
      contribution: {
        statements: [{ title: 'Candidate' }]
      },
      execution: {
        connectionId: 'runtime:codex',
        backendKind: 'coding_plan',
        model: 'codex-small',
        runtime: 'pi_agent_core',
        modelCallCount: 2,
        toolCalls: ['read_evidence', 'submit_knowledge_contribution']
      },
      debugTrace: {
        id: preprocessing.runId,
        origin: 'stage_debug',
        status: 'completed',
        maintenance: {
          modelCallCount: 2,
          toolCallCount: 2,
          events: [
            { kind: 'model_call', label: '模型轮次 1', status: 'completed' },
            { kind: 'tool_call', label: '读取原始观察证据', status: 'completed', detail: 'L000001-L000001 · 1 行' },
            { kind: 'model_call', label: '模型轮次 2', status: 'completed' },
            { kind: 'tool_call', label: '提交 Knowledge Contribution', status: 'completed', detail: '捕获 1 条候选 Statement' }
          ]
        }
      }
    })
    expect(await repository.load()).toEqual(stateBeforeMaintenance)

    service.dispose()
    await expect(service.runKnowledgeMaintenance({ preprocessingRunId: preprocessing.runId }))
      .rejects.toThrow('工作区已不存在')
  })

  it('keeps only the Workspace owned by the current visible stage-debug result', async () => {
    const { service, agent } = createService()
    await service.initialize()
    await configure(service, 'observation_preprocessor')
    await configure(service, 'knowledge_maintenance_agent')
    const first = await service.runObservationPreprocessor({ observation: 'workspace-first' })
    const second = await service.runObservationPreprocessor({ observation: 'workspace-second' })

    await expect(service.runKnowledgeMaintenance({
      preprocessingRunId: first.runId
    })).rejects.toThrow('工作区已不存在')
    await expect(service.runKnowledgeMaintenance({
      preprocessingRunId: second.runId
    })).resolves.toMatchObject({ preprocessingRunId: second.runId })
    expect(agent.calls.at(-1)?.observationLines).toEqual(['workspace-second'])
  })

  it('releases a full-chain Workspace when its exclusive run ends before maintenance', async () => {
    const { service } = createService()
    await service.initialize()
    await configure(service, 'observation_preprocessor')
    await configure(service, 'knowledge_maintenance_agent')
    const lease = service.acquireExclusiveRun()
    const preprocessing = await service.runObservationPreprocessor(
      { observation: 'temporary full-chain workspace' },
      undefined,
      { lease }
    )

    service.releaseExclusiveRun(lease)

    await expect(service.runKnowledgeMaintenance({
      preprocessingRunId: preprocessing.runId
    })).rejects.toThrow('工作区已不存在')
  })

  it('pairs same-name Knowledge Agent tool events by their internal tool call ID', async () => {
    const { service, agent } = createService()
    await service.initialize()
    await configure(service, 'observation_preprocessor')
    await configure(service, 'knowledge_maintenance_agent')
    const preprocessing = await service.runObservationPreprocessor({ observation: 'evidence' })
    agent.handler = async (input) => {
      input.onTrace?.({ type: 'model_started', callNumber: 1 })
      input.onTrace?.({
        type: 'model_completed',
        callNumber: 1,
        status: 'completed',
        detail: 'stop=toolUse · tokens=10'
      })
      input.onTrace?.({ type: 'tool_started', toolCallId: 'first', toolName: 'read_evidence' })
      input.onTrace?.({ type: 'tool_started', toolCallId: 'second', toolName: 'read_evidence' })
      input.onTrace?.({
        type: 'tool_completed',
        toolCallId: 'first',
        toolName: 'read_evidence',
        status: 'completed',
        detail: 'FIRST RESULT'
      })
      input.onTrace?.({
        type: 'tool_completed',
        toolCallId: 'second',
        toolName: 'read_evidence',
        status: 'completed',
        detail: 'SECOND RESULT'
      })
      return {
        contribution: {
          runRef: input.contributionRunRef,
          statements: [{
            localRef: 'candidate',
            title: 'Candidate',
            content: 'Candidate content',
            sources: [{ sourceRef: input.sourceRef, selector: 'L000001-L000001' }]
          }]
        },
        modelCallCount: 1,
        toolCalls: ['read_evidence', 'read_evidence']
      }
    }

    const result = await service.runKnowledgeMaintenance({ preprocessingRunId: preprocessing.runId })
    const toolEvents = result.debugTrace.maintenance?.events.filter(
      (event) => event.kind === 'tool_call'
    )
    expect(toolEvents).toMatchObject([
      { id: 'tool-call-1', detail: 'FIRST RESULT', status: 'completed' },
      { id: 'tool-call-2', detail: 'SECOND RESULT', status: 'completed' }
    ])
    expect(JSON.stringify(toolEvents)).not.toContain('first')
    expect(JSON.stringify(toolEvents)).not.toContain('second')
  })

  it('protects each stage from concurrent runs and propagates cancellation', async () => {
    const { service, backend, agent } = createService()
    await service.initialize()
    await configure(service, 'observation_preprocessor')
    await configure(service, 'knowledge_maintenance_agent')

    backend.generationHandler = async (_connectionId, _modelId, request) => rejectWhenAborted(request.signal!)
    const preprocessingRun = service.runObservationPreprocessor({ observation: 'wait' })
    expect(service.snapshot().runningStageIds).toContain('observation_preprocessor')
    await expect(service.runObservationPreprocessor({ observation: 'second' }))
      .rejects.toThrow('正在运行')
    service.cancelRun('observation_preprocessor')
    await expect(preprocessingRun).rejects.toThrow('用户取消')
    expect(service.snapshot().runningStageIds).not.toContain('observation_preprocessor')

    backend.generationHandler = undefined
    const preprocessing = await service.runObservationPreprocessor({ observation: 'ready' })
    agent.handler = async (input) => rejectWhenAborted(input.signal)
    const maintenanceRun = service.runKnowledgeMaintenance({ preprocessingRunId: preprocessing.runId })
    expect(service.snapshot().runningStageIds).toContain('knowledge_maintenance_agent')
    await expect(service.runKnowledgeMaintenance({ preprocessingRunId: preprocessing.runId }))
      .rejects.toThrow('正在运行')
    service.cancelRun('knowledge_maintenance_agent')
    await expect(maintenanceRun).rejects.toThrow('用户取消')
    expect(service.snapshot().runningStageIds).not.toContain('knowledge_maintenance_agent')
  })

  it('rejects cross-stage concurrency before it can replace the active debug trace', async () => {
    const { service, backend } = createService()
    await service.initialize()
    await configure(service, 'observation_preprocessor')
    await configure(service, 'knowledge_maintenance_agent')
    const ready = await service.runObservationPreprocessor({ observation: 'ready workspace' })
    backend.generationHandler = async (_connectionId, _modelId, request) => (
      rejectWhenAborted(request.signal!)
    )

    const activePreprocessing = service.runObservationPreprocessor({ observation: 'active run' })
    await expect(service.runKnowledgeMaintenance({ preprocessingRunId: ready.runId }))
      .rejects.toThrow('已有知识加工阶段正在运行')
    expect(service.snapshot().debugTraces.find((trace) => trace.origin === 'stage_debug'))
      .toMatchObject({
        status: 'running',
        currentStageId: 'observation_preprocessor'
      })

    service.cancelRun('observation_preprocessor')
    await expect(activePreprocessing).rejects.toThrow('用户取消')
  })

  it('never falls back when the explicitly selected Connection fails', async () => {
    const { service, backend, agent } = createService()
    await service.initialize()
    await configure(service, 'observation_preprocessor', 'model:b')
    backend.generationHandler = async (connectionId) => {
      throw new Error(`${connectionId} unavailable`)
    }

    await expect(service.runObservationPreprocessor({ observation: 'test' }))
      .rejects.toThrow('model:b unavailable')
    expect(backend.generationCalls.map((call) => call.connectionId)).toEqual(['model:b'])
    expect(backend.runtimeCalls).toEqual([])
    expect(agent.calls).toHaveLength(0)
  })

  it('binds a confirmed run to the Connection that was shown to the user', async () => {
    const { service, backend } = createService()
    await service.initialize()
    await configure(service, 'observation_preprocessor', 'model:a')

    await expect(service.runObservationPreprocessor(
      { observation: 'test' },
      'model:b'
    )).rejects.toThrow('确认后 Model Connection 已发生变化')
    expect(backend.generationCalls).toHaveLength(0)
  })
})

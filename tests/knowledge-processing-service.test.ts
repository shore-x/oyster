import { describe, expect, it } from 'vitest'
import type { AiBackendSnapshot, AiConnection } from '../src/shared/ai-backends'
import type { ProcessingStageId } from '../src/shared/knowledge-processing'
import type {
  ModelGenerationRequest,
  ModelRuntime
} from '../src/main/ai-backends/model'
import { KnowledgeProcessingService } from '../src/main/knowledge-processing/knowledge-processing-service'
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
  reasoningEfforts: NonNullable<AiConnection['modelConfig']>['reasoningEfforts'] = []
): AiConnection {
  return {
    id,
    adapterId: 'openai-compatible',
    backendKind: 'api',
    providerId: 'openai_compatible',
    displayName: `Model ${id}`,
    credentialMode: 'oyster_keychain',
    status: 'ready',
    models: [{ id: model, displayName: model, reasoningEfforts: reasoningEfforts ?? [] }],
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
} = {}) {
  const repository = options.repository ?? new InMemoryKnowledgeProcessingRepository()
  const backend = new FakeAiBackend(options.connections ?? [agentConnection(), modelConnection('model:a'), modelConnection('model:b')])
  const agent = options.agent ?? new FakeKnowledgeAgent()
  const service = new KnowledgeProcessingService(repository, backend, agent)
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
    expect(service.snapshot().stages[0].connectionId).toBeUndefined()
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
  })

  it('rejects oversized observations before reserving a stage or calling a model', async () => {
    const { service, backend } = createService()
    await service.initialize()
    await configure(service, 'observation_preprocessor')

    await expect(service.runObservationPreprocessor({ observation: 'x'.repeat(120_001) }))
      .rejects.toThrow('120000')
    expect(backend.generationCalls).toHaveLength(0)
    expect(service.snapshot().runningStageIds).toEqual([])
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
      }
    })
    expect(await repository.load()).toEqual(stateBeforeMaintenance)

    service.dispose()
    await expect(service.runKnowledgeMaintenance({ preprocessingRunId: preprocessing.runId }))
      .rejects.toThrow('工作区已不存在')
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

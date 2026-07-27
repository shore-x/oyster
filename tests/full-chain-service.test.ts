import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiBackendSnapshot, AiConnection } from '../src/shared/ai-backends'
import type { AvailableSessionSummary } from '../src/shared/discovery'
import type {
  ModelGenerationRequest,
  ModelRuntime
} from '../src/main/ai-backends/model'
import type { DiscoveryService } from '../src/main/discovery/discovery-service'
import { CodexHistoryAdapter } from '../src/main/discovery/adapters'
import {
  KnowledgeFullChainService,
  type KnowledgeAgentFactory,
  type KnowledgeFullChainBindings
} from '../src/main/knowledge-processing/full-chain-service'
import {
  KnowledgeProcessingService,
  type KnowledgeProcessingServiceOptions
} from '../src/main/knowledge-processing/knowledge-processing-service'
import type {
  AiBackendPort,
  KnowledgeAgentRunInput,
  KnowledgeAgentRunResult,
  KnowledgeAgentRuntime,
  KnowledgeReader
} from '../src/main/knowledge-processing/model'
import { InMemoryKnowledgeProcessingRepository } from '../src/main/knowledge-processing/repository'
import { SqliteKnowledgeStoreManager } from '../src/main/knowledge-store/knowledge-store-manager'

const temporaryDirectories: string[] = []
const cleanupTasks: Array<() => void> = []

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason?: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function modelConnection(id: string): AiConnection {
  return {
    id,
    adapterId: 'openai-compatible',
    backendKind: 'api',
    providerId: 'openai_compatible',
    displayName: `Model ${id}`,
    credentialMode: 'oyster_keychain',
    status: 'ready',
    models: [{
      id: `${id}-small`,
      displayName: `${id}-small`,
      reasoningEfforts: ['low', 'medium']
    }],
    defaultModelId: `${id}-small`,
    modelConfig: {
      providerId: 'openai_compatible',
      protocol: 'openai_responses',
      baseUrl: `https://${id}.example.test/v1`,
      model: `${id}-small`,
      hasApiKey: true,
      reasoningEfforts: ['low', 'medium']
    }
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
  readonly connections = [modelConnection('model:preprocessor'), modelConnection('model:maintainer')]
  readonly generationCalls: Array<{
    connectionId: string
    modelId: string
    request: ModelGenerationRequest
  }> = []
  generationHandler?: (
    connectionId: string,
    modelId: string,
    request: ModelGenerationRequest
  ) => Promise<{ text: string }>

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
    return { text: '# Evidence Map\n\n- Explicit preference at L000001-L000002.' }
  }

  async withModelRuntime<T>(
    connectionId: string,
    modelId: string,
    operation: (runtime: ModelRuntime) => Promise<T>
  ): Promise<T> {
    const connection = this.connections.find((candidate) => candidate.id === connectionId)
    if (!connection?.models.some((model) => model.id === modelId)) {
      throw new Error('Missing test Model')
    }
    return operation(modelRuntime(modelId))
  }
}

class StaticAgent implements KnowledgeAgentRuntime {
  constructor(
    private readonly runHandler: (input: KnowledgeAgentRunInput) => Promise<KnowledgeAgentRunResult>
  ) {}

  run(input: KnowledgeAgentRunInput): Promise<KnowledgeAgentRunResult> {
    return this.runHandler(input)
  }
}

interface FakeDiscoveryOptions {
  artifactId?: string
  content?: string
}

function fakeDiscovery(options: FakeDiscoveryOptions = {}): {
  service: DiscoveryService
  session: AvailableSessionSummary
  content: string
} {
  const artifactId = options.artifactId ?? 'artifact-session-1'
  const content = options.content ?? [
    '{"role":"user","content":"Please keep summaries concise."}',
    '{"role":"assistant","content":"Understood."}',
    '{"role":"user","content":"Do not omit explicit rejections."}'
  ].join('\n')
  const revision = sha256(`revision\0${content}`)
  const contentHash = sha256(content)
  const observationView = new CodexHistoryAdapter().createObservationView(content)
  const session: AvailableSessionSummary = {
    artifactId,
    sourceId: 'source:codex',
    agentType: 'codex',
    sourceDisplayName: 'OpenAI Codex',
    externalId: 'session-1',
    title: 'Knowledge test session',
    updatedAt: '2026-07-26T00:00:00.000Z',
    sizeBytes: Buffer.byteLength(content),
    revision
  }
  const service = {
    listAvailableSessions: (): AvailableSessionSummary[] => [structuredClone(session)],
    readAvailableSession: async (
      input: { artifactId: string; expectedRevision: string },
      maxBytes?: number
    ) => {
      if (input.artifactId !== artifactId) throw new Error('Unknown test artifact')
      if (input.expectedRevision !== revision) throw new Error('The Session revision has changed')
      const sizeBytes = Buffer.byteLength(content)
      if (maxBytes !== undefined && sizeBytes > maxBytes) throw new Error('Raw evidence exceeds maximum size')
      return { artifactId, revision, contentHash, sizeBytes, content, observationView }
    }
  } as unknown as DiscoveryService
  return { service, session, content }
}

function normalAgentFactory(options: {
  titlePrefix?: string
  observeReader?: (reader: KnowledgeReader) => Promise<void>
} = {}): KnowledgeAgentFactory {
  return (reader) => new StaticAgent(async (input) => {
    await options.observeReader?.(reader)
    input.signal.throwIfAborted()
    const prefix = options.titlePrefix ?? 'Current'
    return {
      contribution: {
        runRef: input.contributionRunRef,
        statements: [
          {
            localRef: 'explicit-preference',
            title: `${prefix} summary preference`,
            content: 'The user explicitly prefers concise summaries.',
            sources: [{ sourceRef: input.sourceRef, selector: 'L000001-L000001' }]
          },
          {
            localRef: 'preservation-rule',
            title: `${prefix} preservation rule`,
            content: 'Explicit rejections must be preserved when maintaining knowledge.',
            relations: [{
              relation: 'derived_from',
              target: { kind: 'draft', localRef: 'explicit-preference' }
            }]
          }
        ]
      },
      modelCallCount: 2,
      toolCalls: ['search_knowledge', 'submit_knowledge_contribution']
    }
  })
}

interface Harness {
  backend: FakeAiBackend
  processing: KnowledgeProcessingService
  manager: SqliteKnowledgeStoreManager
  discovery: ReturnType<typeof fakeDiscovery>
  bindings: KnowledgeFullChainBindings
  createFullChain(factory?: KnowledgeAgentFactory): KnowledgeFullChainService
}

async function createHarness(
  discovery = fakeDiscovery(),
  serviceOptions?: KnowledgeProcessingServiceOptions
): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'oyster-full-chain-'))
  temporaryDirectories.push(directory)
  const manager = await SqliteKnowledgeStoreManager.open(join(directory, 'knowledge'))
  const backend = new FakeAiBackend()
  const processing = new KnowledgeProcessingService(
    new InMemoryKnowledgeProcessingRepository(),
    backend,
    new StaticAgent(async () => {
      throw new Error('The full chain must use the Sandbox-bound Agent runtime')
    }),
    serviceOptions
  )
  await processing.initialize()
  await processing.saveStage({
    stageId: 'observation_preprocessor',
    connectionId: 'model:preprocessor',
    modelId: 'model:preprocessor-small',
    instructionsOverride: null
  })
  await processing.saveStage({
    stageId: 'knowledge_maintenance_agent',
    connectionId: 'model:maintainer',
    modelId: 'model:maintainer-small',
    instructionsOverride: null
  })
  const bindings: KnowledgeFullChainBindings = {
    preprocessor: processing.runBinding('observation_preprocessor'),
    maintainer: processing.runBinding('knowledge_maintenance_agent')
  }

  cleanupTasks.push(() => processing.dispose())
  cleanupTasks.push(() => manager.close())
  return {
    backend,
    processing,
    manager,
    discovery,
    bindings,
    createFullChain: (factory = normalAgentFactory()) => new KnowledgeFullChainService(
      discovery.service,
      processing,
      manager,
      factory
    )
  }
}

function runInput(session: AvailableSessionSummary): {
  artifactId: string
  expectedRevision: string
  attention: string
} {
  return {
    artifactId: session.artifactId,
    expectedRevision: session.revision,
    attention: 'Preserve explicit preferences and rejections.'
  }
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = (): void => reject(signal.reason ?? new Error('aborted'))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

afterEach(async () => {
  for (const cleanup of cleanupTasks.splice(0).reverse()) cleanup()
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => rm(directory, { recursive: true, force: true })
  ))
})

describe('KnowledgeFullChainService', () => {
  it('commits multiple Statements to the Sandbox, reads them back, and leaves production unchanged', async () => {
    const harness = await createHarness()
    const baseline = harness.manager.production.commit({
      runRef: 'production:baseline',
      statements: [{
        localRef: 'baseline',
        title: 'Production baseline',
        content: 'This knowledge predates the test run.',
        sources: [{ sourceRef: 'raw:production-baseline' }]
      }]
    })
    let baselineVisibleToAgent = false
    const fullChain = harness.createFullChain(normalAgentFactory({
      observeReader: async (reader) => {
        baselineVisibleToAgent = (await reader.search('Production baseline', 8))[0]?.id
          === baseline.statements[0].id
      }
    }))

    const result = await fullChain.run(runInput(harness.discovery.session), harness.bindings)

    expect(baselineVisibleToAgent).toBe(true)
    expect(result.commit.statements).toHaveLength(2)
    expect(result.knowledge.createdStatementIds).toEqual(result.commit.statements.map((item) => item.id))
    expect(result.knowledge.statements).toEqual(expect.arrayContaining([
      expect.objectContaining({
        statement: expect.objectContaining({ title: 'Current summary preference' }),
        sources: [expect.objectContaining({
          sourceRef: result.sourceRef,
          selector: 'L000001-L000001'
        })]
      }),
      expect.objectContaining({
        statement: expect.objectContaining({ title: 'Current preservation rule' }),
        outgoingRelations: [expect.objectContaining({ relation: 'derived_from' })]
      })
    ]))

    const sandbox = await harness.manager.openSandbox(result.sandbox.id)
    expect(sandbox.listStatements({ includeRevised: true }).map((item) => item.title)).toEqual(
      expect.arrayContaining([
        'Production baseline',
        'Current summary preference',
        'Current preservation rule'
      ])
    )
    expect(harness.manager.production.listStatements({ includeRevised: true }).map((item) => item.title))
      .toEqual(['Production baseline'])
    expect(harness.manager.production.getContributionByRunRef(result.maintenance.contribution.runRef))
      .toBeUndefined()
  })

  it('keeps global provenance through segmented preprocessing and Sandbox commit', async () => {
    const discovery = fakeDiscovery({
      content: 'line-one\nline-two\nline-three\nline-four'
    })
    const harness = await createHarness(discovery, {
      evidenceMapPlanner: {
        segmentBytes: 64,
        adjacentContextBytes: 32,
        mergeBytes: 1_000
      }
    })
    harness.backend.generationHandler = async (_connectionId, _modelId, request) => {
      if (request.prompt.includes('BEGIN_EVIDENCE_MAP_MATERIALS')) {
        return { text: 'ROOT NAVIGATION' }
      }
      if (request.prompt.includes('L000001-L000002')) return { text: 'LEAF A' }
      if (request.prompt.includes('L000003-L000004')) return { text: 'LEAF B' }
      throw new Error('unexpected preprocessing prompt')
    }
    const fullChain = harness.createFullChain(() => new StaticAgent(async (input) => {
      expect(input.evidenceMap).toContain('ROOT NAVIGATION')
      expect(input.evidenceMapSections).toEqual([
        { id: 'M000001', selectors: ['L000001-L000002'], content: 'LEAF A' },
        { id: 'M000002', selectors: ['L000003-L000004'], content: 'LEAF B' },
        {
          id: 'M000003',
          selectors: ['L000001-L000004'],
          content: 'ROOT NAVIGATION',
          children: ['M000001', 'M000002']
        }
      ])
      return {
        contribution: {
          runRef: input.contributionRunRef,
          statements: [{
            localRef: 'last-range',
            title: 'Last range knowledge',
            content: 'Knowledge grounded in the final global range.',
            sources: [{ sourceRef: input.sourceRef, selector: 'L000004-L000004' }]
          }]
        },
        modelCallCount: 1,
        toolCalls: ['submit_knowledge_contribution']
      }
    }))
    const fullChainTraceSnapshots: Array<ReturnType<typeof harness.processing.snapshot>['debugTraces'][number]> = []
    harness.processing.subscribe((snapshot) => {
      const trace = snapshot.debugTraces.find((candidate) => candidate.origin === 'full_chain')
      if (trace) fullChainTraceSnapshots.push(trace)
    })

    const result = await fullChain.run(runInput(discovery.session), harness.bindings)

    expect(result.preprocessing).toMatchObject({
      segmentCount: 2,
      execution: { modelCallCount: 3 }
    })
    expect(result.maintenance.debugTrace).toMatchObject({
      id: result.runId,
      origin: 'full_chain',
      status: 'completed',
      preprocessing: {
        totalSegments: 2,
        calls: [
          { kind: 'segment_map', output: 'LEAF A' },
          { kind: 'segment_map', output: 'LEAF B' },
          { kind: 'navigation_merge', output: 'ROOT NAVIGATION' }
        ]
      },
      maintenance: { modelCallCount: 1 }
    })
    expect(result.preprocessing.debugTrace).toEqual(result.maintenance.debugTrace)
    const currentRunTraces = fullChainTraceSnapshots.filter((trace) => trace.id === result.runId)
    expect(currentRunTraces.at(-1)?.status).toBe('completed')
    expect(currentRunTraces.slice(0, -1).every((trace) => trace.status === 'running')).toBe(true)
    expect(harness.backend.generationCalls).toHaveLength(3)
    expect(result.knowledge.statements[0].sources).toEqual([
      expect.objectContaining({
        sourceRef: result.sourceRef,
        selector: 'L000004-L000004'
      })
    ])
    expect(harness.manager.production.listStatements({ includeRevised: true })).toEqual([])
  })

  it('creates a fresh isolated Sandbox for every repeated run', async () => {
    const harness = await createHarness()
    const firstService = harness.createFullChain(normalAgentFactory({ titlePrefix: 'First run' }))
    const first = await firstService.run(runInput(harness.discovery.session), harness.bindings)
    const secondService = harness.createFullChain(normalAgentFactory({ titlePrefix: 'Second run' }))
    const second = await secondService.run(runInput(harness.discovery.session), harness.bindings)

    expect(second.sandbox.id).not.toBe(first.sandbox.id)
    const firstStore = await harness.manager.openSandbox(first.sandbox.id)
    const secondStore = await harness.manager.openSandbox(second.sandbox.id)
    const firstTitles = firstStore.listStatements({ includeRevised: true }).map((item) => item.title)
    const secondTitles = secondStore.listStatements({ includeRevised: true }).map((item) => item.title)

    expect(firstTitles).toEqual(expect.arrayContaining([
      'First run summary preference',
      'First run preservation rule'
    ]))
    expect(firstTitles).not.toContain('Second run summary preference')
    expect(secondTitles).toEqual(expect.arrayContaining([
      'Second run summary preference',
      'Second run preservation rule'
    ]))
    expect(secondTitles).not.toContain('First run summary preference')
    expect(harness.manager.production.listStatements({ includeRevised: true })).toEqual([])
  })

  it('rejects a stale Session revision before creating a Sandbox', async () => {
    const discovery = fakeDiscovery()
    const harness = await createHarness(discovery)
    const fullChain = harness.createFullChain()
    harness.processing.beginFullChainDebugTrace({ id: 'previous-full-chain', origin: 'full_chain' })
    harness.processing.completeFullChainDebugTrace({ id: 'previous-full-chain', origin: 'full_chain' })

    await expect(fullChain.run({
      ...runInput(discovery.session),
      expectedRevision: '0'.repeat(64)
    }, harness.bindings)).rejects.toThrow('Session 已失效或版本已变化')

    expect(await harness.manager.listSandboxes()).toEqual([])
    expect(harness.manager.production.listStatements({ includeRevised: true })).toEqual([])
    expect(harness.processing.snapshot().debugTraces.find((trace) => trace.origin === 'full_chain'))
      .toMatchObject({
        id: expect.not.stringMatching(/^previous-full-chain$/),
        status: 'failed',
        currentStageId: 'observation_preprocessor'
      })
  })

  it('rejects an Agent-forged sourceRef and removes the partially created Sandbox', async () => {
    const harness = await createHarness()
    const forgedFactory: KnowledgeAgentFactory = () => new StaticAgent(async (input) => ({
      contribution: {
        runRef: input.contributionRunRef,
        statements: [{
          localRef: 'forged',
          title: 'Forged provenance',
          content: 'This must not be committed.',
          sources: [{
            sourceRef: `raw:another-session@sha256:${'f'.repeat(64)}`,
            selector: 'L000001-L000001'
          }]
        }]
      },
      modelCallCount: 1,
      toolCalls: ['submit_knowledge_contribution']
    }))
    const fullChain = harness.createFullChain(forgedFactory)

    await expect(fullChain.run(runInput(harness.discovery.session), harness.bindings))
      .rejects.toThrow('当前运行之外的 Observation')

    expect(await harness.manager.listSandboxes()).toEqual([])
    expect(harness.manager.production.listStatements({ includeRevised: true })).toEqual([])
    expect(harness.processing.snapshot().debugTraces.find((trace) => trace.origin === 'full_chain'))
      .toMatchObject({
        status: 'failed',
        currentStageId: 'knowledge_maintenance_agent'
      })
  })

  it('preserves the processing error and failed trace when Sandbox cleanup also fails', async () => {
    const harness = await createHarness()
    const reflectedSecret = 'provider reflected RAW_SESSION_SECRET'
    harness.backend.generationHandler = async () => {
      throw new Error(reflectedSecret)
    }
    const discard = vi.spyOn(harness.manager, 'discardSandbox').mockRejectedValue(
      new Error('cleanup failed')
    )

    try {
      await expect(harness.createFullChain().run(
        runInput(harness.discovery.session),
        harness.bindings
      )).rejects.toThrow(reflectedSecret)
      const trace = harness.processing.snapshot().debugTraces.find(
        (candidate) => candidate.origin === 'full_chain'
      )
      expect(trace).toMatchObject({ status: 'failed' })
      expect(JSON.stringify(trace)).not.toContain('RAW_SESSION_SECRET')
      expect(JSON.stringify(trace)).not.toContain('cleanup failed')
    } finally {
      discard.mockRestore()
    }
  })

  it('makes the full-chain lease and manual processing stages mutually exclusive', async () => {
    const harness = await createHarness()
    const enteredFullChainPreprocessing = deferred<void>()
    const releaseFullChainPreprocessing = deferred<void>()
    harness.backend.generationHandler = async (_connectionId, _modelId, request) => {
      enteredFullChainPreprocessing.resolve(undefined)
      await Promise.race([
        releaseFullChainPreprocessing.promise,
        waitForAbort(request.signal!)
      ])
      return { text: '# Evidence Map\n\nFull-chain evidence.' }
    }
    const fullChain = harness.createFullChain()
    const fullChainRun = fullChain.run(runInput(harness.discovery.session), harness.bindings)
    await enteredFullChainPreprocessing.promise

    await expect(harness.processing.runObservationPreprocessor({ observation: 'manual observation' }))
      .rejects.toThrow('完整链路正在运行')
    releaseFullChainPreprocessing.resolve(undefined)
    await expect(fullChainRun).resolves.toMatchObject({ commit: { statements: expect.any(Array) } })

    const enteredManualPreprocessing = deferred<void>()
    const releaseManualPreprocessing = deferred<void>()
    harness.backend.generationHandler = async (_connectionId, _modelId, request) => {
      enteredManualPreprocessing.resolve(undefined)
      await Promise.race([
        releaseManualPreprocessing.promise,
        waitForAbort(request.signal!)
      ])
      return { text: '# Evidence Map\n\nManual evidence.' }
    }
    const manualRun = harness.processing.runObservationPreprocessor({ observation: 'manual observation' })
    await enteredManualPreprocessing.promise

    await expect(fullChain.run(runInput(harness.discovery.session), harness.bindings))
      .rejects.toThrow('已有知识加工运行正在占用工作区')
    releaseManualPreprocessing.resolve(undefined)
    await expect(manualRun).resolves.toMatchObject({ evidenceMap: expect.stringContaining('Manual evidence') })
  })

  it('propagates cancellation, releases the lease, and discards the active Sandbox', async () => {
    const harness = await createHarness()
    const enteredPreprocessing = deferred<void>()
    harness.backend.generationHandler = async (_connectionId, _modelId, request) => {
      enteredPreprocessing.resolve(undefined)
      return waitForAbort(request.signal!)
    }
    const fullChain = harness.createFullChain()
    const running = fullChain.run(runInput(harness.discovery.session), harness.bindings)
    await enteredPreprocessing.promise

    fullChain.cancel()

    await expect(running).rejects.toThrow('用户取消')
    expect(fullChain.isRunning()).toBe(false)
    expect(harness.processing.snapshot().runningStageIds).toEqual([])
    expect(await harness.manager.listSandboxes()).toEqual([])
    expect(harness.manager.production.listStatements({ includeRevised: true })).toEqual([])
    expect(harness.processing.snapshot().debugTraces.find((trace) => trace.origin === 'full_chain'))
      .toMatchObject({
        status: 'cancelled',
        currentStageId: 'observation_preprocessor'
      })

    harness.backend.generationHandler = undefined
    await expect(harness.processing.runObservationPreprocessor({ observation: 'lease was released' }))
      .resolves.toMatchObject({ evidenceMap: expect.stringContaining('Evidence Map') })
  })
})

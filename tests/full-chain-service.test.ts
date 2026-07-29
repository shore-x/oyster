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
  SqliteKnowledgeFullChainRunRepository,
  type KnowledgeFullChainRunHistory
} from '../src/main/knowledge-processing/full-chain-run-repository'
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

function candidateBatch(
  expression = 'summaries',
  question = 'What does “summaries” refer to in this Session?',
  line = 1,
  offset = 0
): string {
  return JSON.stringify({
    candidates: [{
      expression,
      question,
      locations: [{ line, offset }]
    }]
  })
}

function resolvedStatementCandidates(input: KnowledgeAgentRunInput) {
  return input.statementCandidates.map((candidate, index) => ({
    ref: `C${String(index + 1).padStart(6, '0')}`,
    expression: candidate.expression,
    question: candidate.question,
    evidenceLocations: candidate.locations.map(({ line, offset }) => (
      `L${String(line).padStart(6, '0')}:C${offset}`
    )),
    status: 'resolved' as const,
    resolution: 'Covered by the submitted Knowledge Contribution.'
  }))
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
    return { text: candidateBatch() }
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
      return { artifactId, revision, contentHash, sizeBytes, observationView }
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
            title: `${prefix} summary preference`,
            content: 'The user explicitly prefers concise summaries.'
          },
          {
            title: `${prefix} preservation rule`,
            content: `Explicit rejections must be preserved when maintaining [[${prefix} summary preference]].`
          }
        ]
      },
      statementCandidates: resolvedStatementCandidates(input),
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
  createFullChain(
    factory?: KnowledgeAgentFactory,
    history?: KnowledgeFullChainRunHistory
  ): KnowledgeFullChainService
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
    createFullChain: (factory = normalAgentFactory(), history) => new KnowledgeFullChainService(
      discovery.service,
      processing,
      manager,
      factory,
      history
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
  it('persists a completed immutable Run snapshot with its exact configuration', async () => {
    const harness = await createHarness()
    const records = new Map<string, Parameters<KnowledgeFullChainRunHistory['save']>[0]>()
    const history: KnowledgeFullChainRunHistory = {
      save: (record) => { records.set(record.runId, structuredClone(record)) },
      list: () => [...records.values()].map((record) => ({
        runId: record.runId,
        completedAt: record.result.completedAt,
        durationMs: record.result.durationMs,
        sourceDisplayName: record.result.session.sourceDisplayName,
        statementCount: record.result.knowledge.statements.length,
        candidateCount: record.result.maintenance.statementCandidates.length,
        preprocessorModel: record.result.preprocessing.execution.model,
        maintainerModel: record.result.maintenance.execution.model
      })),
      read: (runId) => records.get(runId)
    }
    const fullChain = harness.createFullChain(undefined, history)

    const result = await fullChain.run(runInput(harness.discovery.session), harness.bindings)

    expect(fullChain.listRuns()).toHaveLength(1)
    expect(fullChain.readRun(result.runId)).toMatchObject({
      runId: result.runId,
      attention: 'Preserve explicit preferences and rejections.',
      configuration: {
        preprocessor: harness.bindings.preprocessor,
        maintainer: harness.bindings.maintainer
      },
      result: { runId: result.runId }
    })
  })

  it('does not report success when the completed Run snapshot cannot be persisted', async () => {
    const harness = await createHarness()
    const history: KnowledgeFullChainRunHistory = {
      save: () => { throw new Error('history unavailable') },
      list: () => [],
      read: () => undefined
    }
    const fullChain = harness.createFullChain(undefined, history)

    await expect(fullChain.run(runInput(harness.discovery.session), harness.bindings))
      .rejects.toThrow('history unavailable')
    expect(await harness.manager.listSandboxes()).toEqual([])
  })

  it('imports a persisted result after Sandbox cleanup and allows clear-and-reimport by title', async () => {
    const harness = await createHarness()
    const records = new Map<string, Parameters<KnowledgeFullChainRunHistory['save']>[0]>()
    const history: KnowledgeFullChainRunHistory = {
      save: (record) => { records.set(record.runId, structuredClone(record)) },
      list: () => [],
      read: (runId) => records.get(runId)
    }
    harness.manager.production.commit({
      runRef: 'production:existing',
      statements: [{
        title: 'Current summary preference',
        content: 'An older understanding.'
      }]
    })
    const fullChain = harness.createFullChain(undefined, history)
    const result = await fullChain.run(runInput(harness.discovery.session), harness.bindings)
    await fullChain.discardSandbox(result.sandbox.id)
    expect(await harness.manager.listSandboxes()).toEqual([])

    const firstImport = await fullChain.importRun(result.runId)
    expect(firstImport.createdTitles).toEqual(['Current preservation rule'])
    expect(firstImport.updatedTitles).toEqual(['Current summary preference'])
    expect(harness.manager.production.getStatement('Current summary preference')?.content)
      .toBe('The user explicitly prefers concise summaries.')

    const secondImport = await fullChain.importRun(result.runId)
    expect(secondImport.createdTitles).toEqual([])
    expect(secondImport.updatedTitles).toEqual([
      'Current summary preference',
      'Current preservation rule'
    ])
    expect(secondImport.contribution.runRef).not.toBe(firstImport.contribution.runRef)

    await fullChain.clearKnowledge()
    expect(harness.manager.production.listStatements()).toEqual([])
    expect(fullChain.readRun(result.runId)).toBeDefined()

    const thirdImport = await fullChain.importRun(result.runId)
    expect(thirdImport.createdTitles).toEqual([
      'Current summary preference',
      'Current preservation rule'
    ])
    expect(harness.manager.production.getStatement('Current summary preference')?.content)
      .toBe('The user explicitly prefers concise summaries.')
  })

  it('imports a completed result after reopening the SQLite history repository', async () => {
    const harness = await createHarness()
    const directory = await mkdtemp(join(tmpdir(), 'oyster-full-chain-history-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'history.sqlite')
    let history = await SqliteKnowledgeFullChainRunRepository.open(databasePath)
    const fullChain = harness.createFullChain(undefined, history)

    const result = await fullChain.run(runInput(harness.discovery.session), harness.bindings)
    await fullChain.discardSandbox(result.sandbox.id)
    history.close()

    history = await SqliteKnowledgeFullChainRunRepository.open(databasePath)
    try {
      const restartedService = harness.createFullChain(undefined, history)
      const imported = await restartedService.importRun(result.runId)
      expect(imported.createdTitles).toEqual([
        'Current summary preference',
        'Current preservation rule'
      ])
      expect(harness.manager.production.getStatement('Current preservation rule')?.content)
        .toContain('[[Current summary preference]]')
    } finally {
      history.close()
    }
  })

  it('commits multiple Statements to the Sandbox, reads them back, and leaves production unchanged', async () => {
    const harness = await createHarness()
    const baseline = harness.manager.production.commit({
      runRef: 'production:baseline',
      statements: [{
        title: 'Production baseline',
        content: 'This knowledge predates the test run.'
      }]
    })
    let baselineVisibleToAgent = false
    const fullChain = harness.createFullChain(normalAgentFactory({
      observeReader: async (reader) => {
        baselineVisibleToAgent = (await reader.search('Production baseline', 8))[0]?.title
          === baseline.statements[0].title
      }
    }))

    const result = await fullChain.run(runInput(harness.discovery.session), harness.bindings)

    expect(baselineVisibleToAgent).toBe(true)
    expect(result.commit.statements).toHaveLength(2)
    expect(result.knowledge.writtenStatementTitles).toEqual(result.commit.statements.map((item) => item.title))
    expect(result.knowledge.statements).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: 'Current summary preference'
      }),
      expect.objectContaining({
        title: 'Current preservation rule',
        content: expect.stringContaining('[[Current summary preference]]')
      })
    ]))
    expect(result.preprocessing.statementCandidates).toEqual([
      {
        expression: 'summaries',
        question: 'What does “summaries” refer to in this Session?',
        locations: [{ line: 1, offset: 0 }]
      }
    ])
    expect(result.maintenance.statementCandidates).toEqual([
      expect.objectContaining({
        ref: 'C000001',
        expression: 'summaries',
        evidenceLocations: ['L000001:C0'],
        status: 'resolved'
      })
    ])

    const sandbox = await harness.manager.openSandbox(result.sandbox.id)
    expect(sandbox.listStatements().map((item) => item.title)).toEqual(
      expect.arrayContaining([
        'Production baseline',
        'Current summary preference',
        'Current preservation rule'
      ])
    )
    expect(harness.manager.production.listStatements().map((item) => item.title))
      .toEqual(['Production baseline'])
    expect(harness.manager.production.getContributionByRunRef(result.maintenance.contribution.runRef))
      .toBeUndefined()
  })

  it('clears production knowledge and discards completed Sandboxes as one reset operation', async () => {
    const harness = await createHarness()
    harness.manager.production.commit({
      runRef: 'production:clear-me',
      statements: [
        { title: 'First baseline', content: 'First baseline body.' },
        { title: 'Second baseline', content: 'Second baseline body.' }
      ]
    })
    const fullChain = harness.createFullChain()
    await fullChain.run(runInput(harness.discovery.session), harness.bindings)
    expect(await harness.manager.listSandboxes()).toHaveLength(1)

    await expect(fullChain.clearKnowledge()).resolves.toEqual({
      deletedStatementCount: 2,
      deletedContributionCount: 1
    })

    expect(harness.manager.production.listStatements()).toEqual([])
    expect(harness.manager.production.getContributionByRunRef('production:clear-me')).toBeUndefined()
    expect(await harness.manager.listSandboxes()).toEqual([])
  })

  it('updates an existing title inside the Sandbox without changing production', async () => {
    const harness = await createHarness()
    harness.manager.production.commit({
      runRef: 'production:existing-statement',
      statements: [{
        title: 'Oyster Knowledge Store',
        content: 'The earlier understanding.'
      }]
    })
    const fullChain = harness.createFullChain(() => new StaticAgent(async (input) => ({
      contribution: {
        runRef: input.contributionRunRef,
        statements: [{
          title: 'Oyster Knowledge Store',
          content: 'The current understanding references [[Oyster architecture]].'
        }]
      },
      statementCandidates: resolvedStatementCandidates(input),
      modelCallCount: 1,
      toolCalls: [
        'search_knowledge',
        'read_knowledge_statement',
        'submit_knowledge_contribution'
      ]
    })))

    const result = await fullChain.run(runInput(harness.discovery.session), harness.bindings)

    expect(result.commit.createdTitles).toEqual([])
    expect(result.commit.updatedTitles).toEqual(['Oyster Knowledge Store'])
    expect(result.knowledge.statements).toEqual([{
      title: 'Oyster Knowledge Store',
      content: 'The current understanding references [[Oyster architecture]].'
    }])
    const sandbox = await harness.manager.openSandbox(result.sandbox.id)
    expect(sandbox.getStatement('Oyster Knowledge Store')?.content)
      .toBe('The current understanding references [[Oyster architecture]].')
    expect(harness.manager.production.getStatement('Oyster Knowledge Store')?.content)
      .toBe('The earlier understanding.')
  })

  it('keeps global candidate locations through segmented discovery, Agent agenda, and Sandbox commit', async () => {
    const discovery = fakeDiscovery({
      content: 'line-one\nline-two\nline-three\nline-four'
    })
    const harness = await createHarness(discovery, {
      observationSegmentPlanner: {
        segmentBytes: 80,
        adjacentContextBytes: 32
      }
    })
    harness.backend.generationHandler = async (_connectionId, _modelId, request) => {
      if (request.prompt.includes('L000001-L000002')) {
        return { text: candidateBatch('line-one', 'What does line-one denote?', 1) }
      }
      if (request.prompt.includes('L000003-L000004')) {
        return { text: candidateBatch('line-four', 'What does line-four denote?', 4) }
      }
      throw new Error('unexpected preprocessing prompt')
    }
    const fullChain = harness.createFullChain(() => new StaticAgent(async (input) => {
      expect(input.statementCandidates).toEqual([
        {
          expression: 'line-one',
          question: 'What does line-one denote?',
          locations: [{ line: 1, offset: 0 }]
        },
        {
          expression: 'line-four',
          question: 'What does line-four denote?',
          locations: [{ line: 4, offset: 0 }]
        }
      ])
      return {
        contribution: {
          runRef: input.contributionRunRef,
          statements: [{
            title: 'Last range knowledge',
            content: 'Knowledge grounded in the final global range.'
          }]
        },
        statementCandidates: resolvedStatementCandidates(input),
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
      statementCandidates: [
        { expression: 'line-one', locations: [{ line: 1, offset: 0 }] },
        { expression: 'line-four', locations: [{ line: 4, offset: 0 }] }
      ],
      execution: { modelCallCount: 2 }
    })
    expect(result.maintenance.debugTrace).toMatchObject({
      id: result.runId,
      origin: 'full_chain',
      status: 'completed',
      preprocessing: {
        totalSegments: 2,
        calls: [
          {
            kind: 'candidate_discovery',
            selectors: ['L000001-L000002'],
            readLocation: { line: 1, offset: 0 },
            output: candidateBatch('line-one', 'What does line-one denote?', 1)
          },
          {
            kind: 'candidate_discovery',
            selectors: ['L000003-L000004'],
            readLocation: { line: 3, offset: 0 },
            output: candidateBatch('line-four', 'What does line-four denote?', 4)
          }
        ]
      },
      maintenance: { modelCallCount: 1 }
    })
    expect(result.preprocessing.debugTrace).toEqual(result.maintenance.debugTrace)
    const currentRunTraces = fullChainTraceSnapshots.filter((trace) => trace.id === result.runId)
    expect(currentRunTraces.at(-1)?.status).toBe('completed')
    expect(currentRunTraces.slice(0, -1).every((trace) => trace.status === 'running')).toBe(true)
    expect(harness.backend.generationCalls).toHaveLength(2)
    expect(result.maintenance.statementCandidates).toEqual([
      expect.objectContaining({
        expression: 'line-one',
        evidenceLocations: ['L000001:C0'],
        status: 'resolved'
      }),
      expect.objectContaining({
        expression: 'line-four',
        evidenceLocations: ['L000004:C0'],
        status: 'resolved'
      })
    ])
    expect(result.knowledge.statements[0]).toEqual({
      title: 'Last range knowledge',
      content: 'Knowledge grounded in the final global range.'
    })
    expect(harness.manager.production.listStatements()).toEqual([])
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
    const firstTitles = firstStore.listStatements().map((item) => item.title)
    const secondTitles = secondStore.listStatements().map((item) => item.title)

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
    expect(harness.manager.production.listStatements()).toEqual([])
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
    expect(harness.manager.production.listStatements()).toEqual([])
    expect(harness.processing.snapshot().debugTraces.find((trace) => trace.origin === 'full_chain'))
      .toMatchObject({
        id: expect.not.stringMatching(/^previous-full-chain$/),
        status: 'failed',
        currentStageId: 'observation_preprocessor'
      })
  })

  it('rejects duplicate canonical titles and removes the partially created Sandbox', async () => {
    const harness = await createHarness()
    const forgedFactory: KnowledgeAgentFactory = () => new StaticAgent(async (input) => ({
      contribution: {
        runRef: input.contributionRunRef,
        statements: [
          { title: 'Duplicate title', content: 'First body.' },
          { title: ' Duplicate title ', content: 'Second body.' }
        ]
      },
      statementCandidates: resolvedStatementCandidates(input),
      modelCallCount: 1,
      toolCalls: ['submit_knowledge_contribution']
    }))
    const fullChain = harness.createFullChain(forgedFactory)

    await expect(fullChain.run(runInput(harness.discovery.session), harness.bindings))
      .rejects.toThrow('canonical title 重复')

    expect(await harness.manager.listSandboxes()).toEqual([])
    expect(harness.manager.production.listStatements()).toEqual([])
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
      return { text: '{"candidates":[]}' }
    }
    const fullChain = harness.createFullChain()
    const fullChainRun = fullChain.run(runInput(harness.discovery.session), harness.bindings)
    await enteredFullChainPreprocessing.promise

    await expect(fullChain.clearKnowledge()).rejects.toThrow('完整链路正在运行')
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
      return { text: '{"candidates":[]}' }
    }
    const manualRun = harness.processing.runObservationPreprocessor({ observation: 'manual observation' })
    await enteredManualPreprocessing.promise

    await expect(fullChain.clearKnowledge()).rejects.toThrow('已有知识加工运行正在占用工作区')
    await expect(fullChain.run(runInput(harness.discovery.session), harness.bindings))
      .rejects.toThrow('已有知识加工运行正在占用工作区')
    releaseManualPreprocessing.resolve(undefined)
    await expect(manualRun).resolves.toMatchObject({ statementCandidates: [] })
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
    expect(harness.manager.production.listStatements()).toEqual([])
    expect(harness.processing.snapshot().debugTraces.find((trace) => trace.origin === 'full_chain'))
      .toMatchObject({
        status: 'cancelled',
        currentStageId: 'observation_preprocessor'
      })

    harness.backend.generationHandler = undefined
    await expect(harness.processing.runObservationPreprocessor({ observation: 'lease was released' }))
      .resolves.toMatchObject({
        statementCandidates: [{
          expression: 'summaries',
          locations: [{ line: 1, offset: 0 }]
        }]
      })
  })
})

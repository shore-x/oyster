import { createRoot } from 'solid-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AvailableSessionSummary,
  DiscoveryApi,
  DiscoverySnapshot
} from '../src/shared/discovery'
import type {
  KnowledgeFullChainResult,
  KnowledgeMaintenanceResult,
  KnowledgeProcessingDebugTrace,
  KnowledgeProcessingApi,
  KnowledgeProcessingSnapshot,
  ObservationPreprocessingResult
} from '../src/shared/knowledge-processing'
import { createKnowledgeProcessingController } from '../src/renderer/src/knowledge-processing-controller'

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const SNAPSHOT: KnowledgeProcessingSnapshot = {
  stages: [],
  connections: [],
  runningStageIds: [],
  debugTraces: []
}

function discoverySnapshot(
  sessionCount = 0,
  lastScannedAt?: string,
  sessionCatalogVersion = 0
): DiscoverySnapshot {
  return {
    sources: [{
      id: 'source-1',
      agentType: 'codex',
      displayName: 'Codex',
      rootPath: '/external/codex',
      discoveryState: 'found',
      scanState: 'ready',
      fileCount: sessionCount,
      sessionCount,
      instructionFileCount: 0,
      totalBytes: 0,
      invalidFileCount: 0,
      lastScannedAt
    }],
    runs: [],
    sessionCatalogVersion
  }
}

function debugTrace(
  id: string,
  stageId: 'observation_preprocessor' | 'knowledge_maintenance_agent'
): KnowledgeProcessingDebugTrace {
  return {
    id,
    origin: 'stage_debug',
    status: 'completed',
    currentStageId: stageId,
    startedAt: '2026-07-26T00:00:00.000Z',
    completedAt: '2026-07-26T00:00:01.000Z',
    ...(stageId === 'observation_preprocessor'
      ? { preprocessing: { phase: 'completed' as const, completedSegments: 1, totalSegments: 1, calls: [] } }
      : { maintenance: { modelCallCount: 2, toolCallCount: 1, events: [] } })
  }
}

function preprocessingResult(runId = 'preprocess-1'): ObservationPreprocessingResult {
  return {
    stageId: 'observation_preprocessor',
    runId,
    statementCandidates: [{
      expression: 'Candidate',
      question: 'What does Candidate mean in this context?',
      locations: [{ line: 1, offset: 0 }]
    }],
    sourceRef: `workspace:${runId}:observation`,
    segmentCount: 1,
    debugTrace: debugTrace(runId, 'observation_preprocessor'),
    durationMs: 10,
    completedAt: '2026-07-26T00:00:00.000Z',
    execution: {
      connectionId: 'model:fixture',
      connectionName: 'Fixture',
      backendKind: 'api',
      providerId: 'openai_compatible',
      model: 'fixture-model',
      runtime: 'direct_model_call',
      modelCallCount: 1,
      toolCalls: []
    }
  }
}

function maintenanceResult(): KnowledgeMaintenanceResult {
  return {
    stageId: 'knowledge_maintenance_agent',
    preprocessingRunId: 'preprocess-1',
    contribution: {
      runRef: 'maintenance-run-1',
      statements: [{
        title: 'Candidate',
        content: 'Candidate content'
      }]
    },
    statementCandidates: [{
      ref: 'C000001',
      expression: 'Candidate',
      question: 'What does Candidate mean in this context?',
      evidenceLocations: ['L000001:C0'],
      status: 'resolved',
      resolution: 'Represented by [[Candidate]].'
    }],
    debugTrace: debugTrace('preprocess-1', 'knowledge_maintenance_agent'),
    durationMs: 20,
    completedAt: '2026-07-26T00:00:01.000Z',
    execution: {
      connectionId: 'model:fixture',
      connectionName: 'Fixture',
      backendKind: 'api',
      providerId: 'openai_compatible',
      model: 'fixture-model',
      runtime: 'pi_agent_core',
      modelCallCount: 2,
      toolCalls: ['submit_knowledge_contribution']
    }
  }
}

function fullChainResult(): KnowledgeFullChainResult {
  const session = {
    artifactId: 'artifact-1',
    sourceId: 'source-1',
    agentType: 'codex' as const,
    sourceDisplayName: 'Codex',
    externalId: 'session-1',
    title: 'Session one',
    sizeBytes: 120,
    revision: 'a'.repeat(64)
  }
  const preprocessing = preprocessingResult()
  const maintenance = maintenanceResult()
  return {
    runId: 'full-chain-1',
    session,
    sandbox: { id: 'sandbox-1', baselineCreatedAt: '2026-07-26T00:00:00.000Z' },
    sourceRef: 'raw-evidence:artifact-1',
    preprocessing,
    maintenance,
    commit: {
      contribution: { runRef: 'full-chain-1', createdAt: '2026-07-26T00:00:01.000Z' },
      statements: [],
      createdTitles: [],
      updatedTitles: []
    },
    knowledge: { writtenStatementTitles: [], statements: [] },
    durationMs: 30,
    completedAt: '2026-07-26T00:00:01.000Z'
  }
}

function installApi(
  overrides: Partial<KnowledgeProcessingApi> = {},
  sessions: AvailableSessionSummary[] = [],
  discoveryOverrides: Partial<DiscoveryApi> = {}
): KnowledgeProcessingApi {
  const api: KnowledgeProcessingApi = {
    getSnapshot: async () => SNAPSHOT,
    saveStage: async () => SNAPSHOT,
    runObservationPreprocessor: async () => preprocessingResult(),
    runSessionPreprocessor: async () => preprocessingResult(),
    runKnowledgeMaintenance: async () => maintenanceResult(),
    runFullChain: async () => fullChainResult(),
    listFullChainRuns: async () => [],
    readFullChainRun: async () => undefined,
    importFullChainRun: async () => ({
      contribution: { runRef: 'import:fixture', createdAt: '2026-07-26T00:00:02.000Z' },
      statements: [],
      createdTitles: [],
      updatedTitles: []
    }),
    cancelFullChain: async () => undefined,
    discardSandbox: async () => undefined,
    cancelRun: async () => undefined,
    subscribe: () => () => undefined,
    ...overrides
  }
  const discovery: DiscoveryApi = {
    getSnapshot: async () => discoverySnapshot(sessions.length),
    listAvailableSessions: async () => sessions,
    detectAgents: async () => discoverySnapshot(sessions.length),
    scanSource: async () => discoverySnapshot(sessions.length),
    cancelRun: async () => discoverySnapshot(sessions.length),
    chooseSourceRoot: async () => discoverySnapshot(sessions.length),
    subscribe: () => () => undefined,
    ...discoveryOverrides
  }
  vi.stubGlobal('window', {
    oyster: {
      knowledgeProcessing: api,
      discovery
    }
  })
  return api
}

afterEach(() => vi.unstubAllGlobals())

describe('knowledge processing controller', () => {
  it('invalidates both derived results when processing inputs change', async () => {
    installApi()
    await createRoot(async (dispose) => {
      try {
        const controller = createKnowledgeProcessingController()
        await controller.runObservationPreprocessor({ observation: 'Observation' })
        await controller.runKnowledgeMaintenance({ preprocessingRunId: 'preprocess-1' })
        expect(controller.preprocessingResult()?.runId).toBe('preprocess-1')
        expect(controller.maintenanceResult()?.contribution.statements[0]?.title).toBe('Candidate')

        controller.invalidateInputResults()
        expect(controller.preprocessingResult()).toBeUndefined()
        expect(controller.maintenanceResult()).toBeUndefined()
      } finally {
        dispose()
      }
    })
  })

  it('removes an older contribution after replacement preprocessing succeeds', async () => {
    let preprocessingCalls = 0
    installApi({
      runObservationPreprocessor: async () => {
        preprocessingCalls += 1
        if (preprocessingCalls === 1) return preprocessingResult()
        return preprocessingResult('preprocess-2')
      }
    })

    await createRoot(async (dispose) => {
      try {
        const controller = createKnowledgeProcessingController()
        await controller.runObservationPreprocessor({ observation: 'First' })
        await controller.runKnowledgeMaintenance({ preprocessingRunId: 'preprocess-1' })

        await controller.runObservationPreprocessor({ observation: 'Second' })
        expect(controller.preprocessingResult()?.runId).toBe('preprocess-2')
        expect(controller.maintenanceResult()).toBeUndefined()
      } finally {
        dispose()
      }
    })
  })

  it('preprocesses the exact available Session revision selected by the user', async () => {
    const runSessionPreprocessor = vi.fn(async () => preprocessingResult('session-preprocess'))
    installApi({ runSessionPreprocessor })

    await createRoot(async (dispose) => {
      try {
        const controller = createKnowledgeProcessingController()
        await controller.runKnowledgeMaintenance({ preprocessingRunId: 'preprocess-1' })
        await controller.runSessionPreprocessor({
          artifactId: 'artifact-1',
          expectedRevision: 'a'.repeat(64),
          attention: 'Focus on explicit decisions'
        })

        expect(runSessionPreprocessor).toHaveBeenCalledWith({
          artifactId: 'artifact-1',
          expectedRevision: 'a'.repeat(64),
          attention: 'Focus on explicit decisions'
        })
        expect(controller.preprocessingResult()?.runId).toBe('session-preprocess')
        expect(controller.maintenanceResult()).toBeUndefined()
      } finally {
        dispose()
      }
    })
  })

  it('keeps a valid contribution when a later maintenance confirmation is cancelled', async () => {
    let maintenanceCalls = 0
    installApi({
      runKnowledgeMaintenance: async () => {
        maintenanceCalls += 1
        return maintenanceCalls === 1 ? maintenanceResult() : undefined
      }
    })

    await createRoot(async (dispose) => {
      try {
        const controller = createKnowledgeProcessingController()
        await controller.runKnowledgeMaintenance({ preprocessingRunId: 'preprocess-1' })
        await controller.runKnowledgeMaintenance({ preprocessingRunId: 'preprocess-1' })

        expect(controller.maintenanceResult()?.contribution.statements[0]?.title).toBe('Candidate')
      } finally {
        dispose()
      }
    })
  })

  it('keeps a completed sandbox result until that sandbox is explicitly discarded', async () => {
    const discardSandbox = vi.fn(async () => undefined)
    installApi({ discardSandbox })

    await createRoot(async (dispose) => {
      try {
        const controller = createKnowledgeProcessingController()
        await controller.runFullChain({
          artifactId: 'artifact-1',
          expectedRevision: 'a'.repeat(64)
        })

        expect(controller.fullChainResult()?.sandbox.id).toBe('sandbox-1')
        await controller.discardSandbox('sandbox-1')

        expect(discardSandbox).toHaveBeenCalledWith('sandbox-1')
        expect(controller.fullChainResult()).toBeUndefined()
      } finally {
        dispose()
      }
    })
  })

  it('loads and opens persisted full-chain history', async () => {
    const result = fullChainResult()
    const record = {
      formatVersion: 1 as const,
      runId: result.runId,
      configuration: {
        preprocessor: { connectionId: 'model:fixture', modelId: 'fixture-model', instructions: 'Preprocess.' },
        maintainer: { connectionId: 'model:fixture', modelId: 'fixture-model', instructions: 'Maintain.' }
      },
      result
    }
    const summary = {
      runId: result.runId,
      completedAt: result.completedAt,
      durationMs: result.durationMs,
      sessionTitle: result.session.title,
      sourceDisplayName: result.session.sourceDisplayName,
      statementCount: 0,
      candidateCount: 1,
      preprocessorModel: 'fixture-model',
      maintainerModel: 'fixture-model'
    }
    installApi({
      listFullChainRuns: async () => [summary],
      readFullChainRun: async () => record
    })

    await createRoot(async (dispose) => {
      try {
        const controller = createKnowledgeProcessingController()
        await controller.loadFullChainRuns()
        expect(controller.fullChainRuns()).toEqual([summary])

        await expect(controller.readFullChainRun(result.runId)).resolves.toEqual(record)
        expect(controller.selectedFullChainRun()).toEqual(record)

      } finally {
        dispose()
      }
    })
  })

  it('keeps the last selected history record when reads finish out of order', async () => {
    const firstResult = { ...fullChainResult(), runId: 'full-chain-first' }
    const secondResult = { ...fullChainResult(), runId: 'full-chain-second' }
    const firstRecord = {
      formatVersion: 1 as const,
      runId: firstResult.runId,
      configuration: {
        preprocessor: { connectionId: 'model:fixture', modelId: 'fixture-model', instructions: 'Preprocess.' },
        maintainer: { connectionId: 'model:fixture', modelId: 'fixture-model', instructions: 'Maintain.' }
      },
      result: firstResult
    }
    const secondRecord = {
      ...firstRecord,
      runId: secondResult.runId,
      result: secondResult
    }
    const firstRead = deferred<typeof firstRecord | undefined>()
    const secondRead = deferred<typeof secondRecord | undefined>()
    installApi({
      readFullChainRun: (runId) => runId === firstRecord.runId
        ? firstRead.promise
        : secondRead.promise
    })

    await createRoot(async (dispose) => {
      try {
        const controller = createKnowledgeProcessingController()
        const pendingFirst = controller.readFullChainRun(firstRecord.runId)
        const pendingSecond = controller.readFullChainRun(secondRecord.runId)

        secondRead.resolve(secondRecord)
        await pendingSecond
        firstRead.resolve(firstRecord)
        await pendingFirst

        expect(controller.selectedFullChainRun()?.runId).toBe(secondRecord.runId)
        expect(controller.isLoadingFullChainRun(secondRecord.runId)).toBe(false)
      } finally {
        dispose()
      }
    })
  })

  it('imports any persisted full-chain result into production and reports the write', async () => {
    const commit = {
      contribution: { runRef: 'import:full-chain-1', createdAt: '2026-07-26T00:00:02.000Z' },
      statements: [{ title: 'Candidate', content: 'Imported candidate content.' }],
      createdTitles: ['Candidate'],
      updatedTitles: []
    }
    const importFullChainRun = vi.fn(async () => commit)
    installApi({ importFullChainRun })

    await createRoot(async (dispose) => {
      try {
        const controller = createKnowledgeProcessingController()
        await expect(controller.importFullChainRun('full-chain-1')).resolves.toEqual(commit)
        expect(importFullChainRun).toHaveBeenCalledWith('full-chain-1')
        expect(controller.fullChainImportResult()).toEqual({
          runId: 'full-chain-1',
          commit
        })
        expect(controller.isImportingFullChainRun('full-chain-1')).toBe(false)
      } finally {
        dispose()
      }
    })
  })

  it('drops a completed sandbox result when the knowledge reset discards its Store', async () => {
    installApi()

    await createRoot(async (dispose) => {
      try {
        const controller = createKnowledgeProcessingController()
        await controller.runFullChain({
          artifactId: 'artifact-1',
          expectedRevision: 'a'.repeat(64)
        })

        expect(controller.fullChainResult()).toBeDefined()
        controller.resetFullChainResult()
        expect(controller.fullChainResult()).toBeUndefined()
      } finally {
        dispose()
      }
    })
  })

  it('loads only the available Session summaries exposed by Discovery', async () => {
    const session = fullChainResult().session
    installApi({}, [session])

    await createRoot(async (dispose) => {
      try {
        const controller = createKnowledgeProcessingController()
        await controller.loadAvailableSessions()

        expect(controller.availableSessions()).toEqual([session])
        expect(controller.sessionsLoading()).toBe(false)
      } finally {
        dispose()
      }
    })
  })

  it('reloads available Sessions when the Discovery catalog changes', async () => {
    const sessions: AvailableSessionSummary[] = []
    let discoveryListener: ((snapshot: DiscoverySnapshot) => void) | undefined
    installApi({}, sessions, {
      getSnapshot: async () => discoverySnapshot(0, '2026-07-26T00:00:00.000Z'),
      subscribe: (listener) => {
        discoveryListener = listener
        return () => { discoveryListener = undefined }
      }
    })

    let disposeRoot!: () => void
    const controller = createRoot((dispose) => {
      disposeRoot = dispose
      return createKnowledgeProcessingController()
    })
    try {
      await vi.waitFor(() => expect(controller.sessionsLoading()).toBe(false))
      expect(controller.availableSessions()).toEqual([])

      sessions.push(fullChainResult().session)
      discoveryListener?.(discoverySnapshot(1, '2026-07-26T00:01:00.000Z'))

      await vi.waitFor(() => expect(controller.availableSessions()).toEqual(sessions))
    } finally {
      disposeRoot()
    }
  })

  it('reloads Session revisions after a targeted refresh without a full source scan', async () => {
    const initial = fullChainResult().session
    const sessions: AvailableSessionSummary[] = [initial]
    let discoveryListener: ((snapshot: DiscoverySnapshot) => void) | undefined
    installApi({}, sessions, {
      getSnapshot: async () => discoverySnapshot(1, '2026-07-26T00:00:00.000Z', 0),
      subscribe: (listener) => {
        discoveryListener = listener
        return () => { discoveryListener = undefined }
      }
    })

    let disposeRoot!: () => void
    const controller = createRoot((dispose) => {
      disposeRoot = dispose
      return createKnowledgeProcessingController()
    })
    try {
      await vi.waitFor(() => expect(controller.availableSessions()).toEqual([initial]))
      const grown = {
        ...initial,
        revision: 'b'.repeat(64),
        sizeBytes: initial.sizeBytes + 128
      }
      sessions[0] = grown
      discoveryListener?.(discoverySnapshot(1, '2026-07-26T00:00:00.000Z', 1))

      await vi.waitFor(() => expect(controller.availableSessions()).toEqual([grown]))
    } finally {
      disposeRoot()
    }
  })

})

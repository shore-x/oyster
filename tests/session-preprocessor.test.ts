import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { AvailableSessionSummary } from '../src/shared/discovery'
import type { ObservationPreprocessingResult } from '../src/shared/knowledge-processing'
import type { DiscoveryService } from '../src/main/discovery/discovery-service'
import { CodexHistoryAdapter } from '../src/main/discovery/adapters'
import { SessionPreprocessor } from '../src/main/knowledge-processing/session-preprocessor'
import type {
  KnowledgeProcessingService,
  ProcessingStageRunBinding
} from '../src/main/knowledge-processing/knowledge-processing-service'

const ARTIFACT_ID = 'artifact-session-1'
const CONTENT = [
  '{"role":"user","content":"Please keep summaries concise."}',
  '{"role":"assistant","content":"Understood."}'
].join('\n')

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function session(content = CONTENT): AvailableSessionSummary {
  return {
    artifactId: ARTIFACT_ID,
    sourceId: 'source:codex',
    agentType: 'codex',
    sourceDisplayName: 'OpenAI Codex',
    externalId: 'session-1',
    title: 'Available Session',
    updatedAt: '2026-07-26T00:00:00.000Z',
    sizeBytes: Buffer.byteLength(content),
    revision: sha256(`revision\0${content}`)
  }
}

function preprocessingResult(sourceRef: string): ObservationPreprocessingResult {
  return {
    stageId: 'observation_preprocessor',
    runId: 'preprocessing-run-1',
    evidenceMap: '# Evidence Map\n\n- Concise summaries are preferred.',
    sourceRef,
    segmentCount: 1,
    debugTrace: {
      id: 'preprocessing-run-1',
      origin: 'stage_debug',
      status: 'completed',
      currentStageId: 'observation_preprocessor',
      startedAt: '2026-07-26T00:00:00.000Z',
      completedAt: '2026-07-26T00:00:01.000Z',
      preprocessing: {
        phase: 'completed',
        completedSegments: 1,
        totalSegments: 1,
        calls: []
      }
    },
    durationMs: 1,
    completedAt: '2026-07-26T00:00:01.000Z',
    execution: {
      connectionId: 'model:preprocessor',
      connectionName: 'Preprocessor model',
      backendKind: 'api',
      providerId: 'openai_compatible',
      model: 'small-model',
      runtime: 'direct_model_call',
      modelCallCount: 1,
      toolCalls: [],
      reasoningEffort: 'low'
    }
  }
}

function createHarness(options: {
  content?: string
  sessions?: AvailableSessionSummary[]
} = {}) {
  const content = options.content ?? CONTENT
  const availableSession = session(content)
  const sessions = options.sessions ?? [availableSession]
  const contentHash = sha256(content)
  const observationView = new CodexHistoryAdapter().createObservationView(content)
  const listAvailableSessions = vi.fn(() => structuredClone(sessions))
  const readAvailableSession = vi.fn(async (
    input: { artifactId: string; expectedRevision: string }
  ) => {
    if (input.artifactId !== availableSession.artifactId) throw new Error('Unknown Session')
    if (input.expectedRevision !== availableSession.revision) throw new Error('Stale Session')
    const sizeBytes = Buffer.byteLength(content)
    return {
      artifactId: availableSession.artifactId,
      revision: availableSession.revision,
      contentHash,
      sizeBytes,
      observationView
    }
  })
  const discovery = {
    listAvailableSessions,
    readAvailableSession
  } as unknown as DiscoveryService

  const runObservationPreprocessorView = vi.fn(async (
    _view: typeof observationView,
    _attention: string | undefined,
    _expectedConnectionId: string | undefined,
    options: { sourceRef?: string }
  ) => preprocessingResult(options.sourceRef!))
  const processing = { runObservationPreprocessorView } as unknown as KnowledgeProcessingService

  return {
    availableSession,
    contentHash,
    listAvailableSessions,
    readAvailableSession,
    runObservationPreprocessorView,
    service: new SessionPreprocessor(discovery, processing)
  }
}

const binding: ProcessingStageRunBinding = {
  connectionId: 'model:preprocessor',
  modelId: 'small-model',
  instructions: 'Create an Evidence Map.',
  reasoningEffort: 'low'
}

describe('SessionPreprocessor', () => {
  it('loads the exact Session revision and passes its evidence, provenance, and attention to preprocessing', async () => {
    const harness = createHarness()
    const attention = 'Preserve explicit preferences and rejections.'
    const sourceRef = `raw:${ARTIFACT_ID}@sha256:${harness.contentHash}`

    const result = await harness.service.run({
      artifactId: ARTIFACT_ID,
      expectedRevision: harness.availableSession.revision,
      attention
    }, binding)

    expect(harness.listAvailableSessions).toHaveBeenCalledOnce()
    expect(harness.readAvailableSession).toHaveBeenCalledWith({
      artifactId: ARTIFACT_ID,
      expectedRevision: harness.availableSession.revision
    })
    expect(harness.runObservationPreprocessorView).toHaveBeenCalledWith(
      expect.objectContaining({ formatVersion: 'codex-jsonl-v4' }),
      attention,
      undefined,
      {
      binding,
      sourceRef
      }
    )
    expect(result.sourceRef).toBe(sourceRef)
  })

  it.each([
    {
      name: 'a stale revision',
      artifactId: ARTIFACT_ID,
      expectedRevision: '0'.repeat(64)
    },
    {
      name: 'a missing Session',
      artifactId: 'artifact-session-missing',
      expectedRevision: session().revision
    }
  ])('rejects $name before reading evidence or invoking preprocessing', async ({
    artifactId,
    expectedRevision
  }) => {
    const harness = createHarness()

    await expect(harness.service.run({ artifactId, expectedRevision }, binding))
      .rejects.toThrow()

    expect(harness.readAvailableSession).not.toHaveBeenCalled()
    expect(harness.runObservationPreprocessorView).not.toHaveBeenCalled()
  })

  it('allows an external Session above the former single-call limit to reach segmented preprocessing', async () => {
    const content = `${'event\n'.repeat(20_001)}final`
    expect(Buffer.byteLength(content)).toBeGreaterThan(120_000)
    const harness = createHarness({ content })

    await expect(harness.service.run({
      artifactId: harness.availableSession.artifactId,
      expectedRevision: harness.availableSession.revision
    }, binding)).resolves.toMatchObject({ segmentCount: 1 })

    expect(harness.readAvailableSession).toHaveBeenCalledWith(expect.any(Object))
    expect(harness.runObservationPreprocessorView).toHaveBeenCalledWith(
      expect.objectContaining({ formatVersion: 'codex-jsonl-v4' }),
      undefined,
      undefined,
      expect.objectContaining({ sourceRef: expect.stringMatching(/^raw:/) })
    )
  })

  it('does not reject a selected Session above the former 16 MiB limit', async () => {
    const content = 'x'.repeat(16 * 1024 * 1024 + 1)
    const harness = createHarness({ content })

    await expect(harness.service.run({
      artifactId: harness.availableSession.artifactId,
      expectedRevision: harness.availableSession.revision
    }, binding)).resolves.toMatchObject({ sourceRef: `raw:${ARTIFACT_ID}@sha256:${harness.contentHash}` })

    expect(harness.readAvailableSession).toHaveBeenCalledWith(expect.any(Object))
    expect(harness.runObservationPreprocessorView).toHaveBeenCalledWith(
      expect.objectContaining({ formatVersion: 'codex-jsonl-v4' }),
      undefined,
      undefined,
      expect.objectContaining({ sourceRef: expect.stringMatching(/^raw:/) })
    )
  })
})

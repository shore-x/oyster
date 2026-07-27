import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { AvailableSessionSummary } from '../src/shared/discovery'
import type { ObservationPreprocessingResult } from '../src/shared/knowledge-processing'
import type { DiscoveryService } from '../src/main/discovery/discovery-service'
import {
  MAX_SESSION_OBSERVATION_BYTES
} from '../src/main/knowledge-processing/session'
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
  const listAvailableSessions = vi.fn(() => structuredClone(sessions))
  const readAvailableSession = vi.fn(async (
    input: { artifactId: string; expectedRevision: string },
    maxBytes: number
  ) => {
    if (input.artifactId !== availableSession.artifactId) throw new Error('Unknown Session')
    if (input.expectedRevision !== availableSession.revision) throw new Error('Stale Session')
    const sizeBytes = Buffer.byteLength(content)
    if (sizeBytes > maxBytes) throw new Error('Raw evidence exceeds maximum size')
    return {
      artifactId: availableSession.artifactId,
      revision: availableSession.revision,
      contentHash,
      sizeBytes,
      content
    }
  })
  const discovery = {
    listAvailableSessions,
    readAvailableSession
  } as unknown as DiscoveryService

  const runObservationPreprocessor = vi.fn(async (
    _input: { observation: string; attention?: string },
    _expectedConnectionId: string | undefined,
    options: { sourceRef?: string }
  ) => preprocessingResult(options.sourceRef!))
  const processing = { runObservationPreprocessor } as unknown as KnowledgeProcessingService

  return {
    availableSession,
    contentHash,
    listAvailableSessions,
    readAvailableSession,
    runObservationPreprocessor,
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
    }, MAX_SESSION_OBSERVATION_BYTES)
    expect(harness.runObservationPreprocessor).toHaveBeenCalledWith({
      observation: CONTENT,
      attention
    }, undefined, {
      binding,
      sourceRef
    })
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
    expect(harness.runObservationPreprocessor).not.toHaveBeenCalled()
  })

  it('rejects raw evidence above the byte limit without invoking preprocessing', async () => {
    const content = 'x'.repeat(MAX_SESSION_OBSERVATION_BYTES + 1)
    const harness = createHarness({ content })

    await expect(harness.service.run({
      artifactId: harness.availableSession.artifactId,
      expectedRevision: harness.availableSession.revision
    }, binding)).rejects.toThrow('Raw evidence exceeds maximum size')

    expect(harness.readAvailableSession).toHaveBeenCalledWith(
      expect.any(Object),
      MAX_SESSION_OBSERVATION_BYTES
    )
    expect(harness.runObservationPreprocessor).not.toHaveBeenCalled()
  })
})

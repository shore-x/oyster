import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AiBackendSnapshot, AiConnection } from '../src/shared/ai-backends'
import type { AvailableSessionSummary } from '../src/shared/discovery'
import type { ModelGenerationRequest, ModelRuntime } from '../src/main/ai-backends/model'
import type { DiscoveryService } from '../src/main/discovery/discovery-service'
import {
  KnowledgeFullChainService,
  type KnowledgeFullChainBindings
} from '../src/main/knowledge-processing/full-chain-service'
import type { KnowledgeFullChainRunHistory } from '../src/main/knowledge-processing/full-chain-run-repository'
import { KnowledgeProcessingService } from '../src/main/knowledge-processing/knowledge-processing-service'
import type {
  AiBackendPort,
  KnowledgeMaintainerRuntime,
  KnowledgeReviewerRunInput,
  KnowledgeReviewerRuntime,
  RepositoryAgentRunResult
} from '../src/main/knowledge-processing/model'
import { InMemoryKnowledgeProcessingRepository } from '../src/main/knowledge-processing/repository'
import type { KnowledgeFullChainRunRecord } from '../src/shared/knowledge-processing'
import { completedAgentRun } from './agent-run-fixture'
import {
  ProcessingRepository,
  REVIEW_MARKER_COMMENT,
  REVIEW_MARKER_END,
  REVIEW_MARKER_START
} from '../src/main/knowledge-processing/processing-repository'
import {
  FixtureKnowledgeMaintainerRuntime,
  FixtureKnowledgeReviewerRuntime
} from '../src/main/knowledge-processing/fixture'
import { runArtifactGit } from '../src/main/artifacts/git-runtime'

const temporaryDirectories: string[] = []

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function connection(): AiConnection {
  return {
    id: 'model:collaboration',
    adapterId: 'openai-compatible',
    backendKind: 'api',
    providerId: 'openai_compatible',
    displayName: 'Collaboration Model',
    credentialMode: 'oyster_keychain',
    status: 'ready',
    models: [{ id: 'collaboration', displayName: 'Collaboration', reasoningEfforts: [] }],
    defaultModelId: 'collaboration',
    modelConfig: {
      providerId: 'openai_compatible',
      protocol: 'openai_responses',
      baseUrl: 'https://example.test/v1',
      model: 'collaboration',
      hasApiKey: true,
      reasoningEfforts: []
    }
  }
}

class FakeBackend implements AiBackendPort {
  snapshot(): AiBackendSnapshot {
    return {
      options: [],
      connections: [connection()],
      defaultLlm: { connectionId: 'model:collaboration', modelId: 'collaboration' }
    }
  }

  subscribe(): () => void {
    return () => undefined
  }

  async generateWithModel(
    _connectionId: string,
    _modelId: string,
    _request: ModelGenerationRequest
  ): Promise<{ text: string }> {
    throw new Error('not used')
  }

  async withModelRuntime<T>(
    _connectionId: string,
    _modelId: string,
    operation: (runtime: ModelRuntime) => Promise<T>
  ): Promise<T> {
    return operation({
      model: { id: 'collaboration', contextWindow: 128_000 } as ModelRuntime['model'],
      streamFn: (() => { throw new Error('not used') }) as ModelRuntime['streamFn']
    })
  }
}

function fakeDiscovery() {
  const content = '{"role":"user","content":"Keep summaries concise."}'
  const revision = sha256(`revision\0${content}`)
  const session: AvailableSessionSummary = {
    sourceRecordId: 'source-record-session-1',
    sourceId: 'source:codex',
    agentType: 'codex',
    sourceDisplayName: 'OpenAI Codex',
    externalId: 'session-1',
    title: 'Knowledge test session',
    sizeBytes: Buffer.byteLength(content),
    revision
  }
  const service = {
    listAvailableSessions: () => [structuredClone(session)],
    readAvailableSession: async (input: { sourceRecordId: string; expectedRevision: string }) => {
      if (input.sourceRecordId !== session.sourceRecordId || input.expectedRevision !== revision) {
        throw new Error('The Session revision has changed')
      }
      return {
        sourceRecordId: session.sourceRecordId,
        revision,
        contentHash: sha256(content),
        sizeBytes: Buffer.byteLength(content),
        rawEvidence: {
          formatVersion: 'codex-jsonl-raw-v1',
          lines: [content],
          skillHints: []
        },
        canonicalActivity: {
          formatVersion: 'codex-canonical-activity-v1',
          items: [{
            kind: 'user_message' as const,
            content: 'Keep summaries concise.',
            rawRanges: [{
              start: { line: 1, offset: 0 },
              end: { line: 1, offset: content.length }
            }]
          }],
          attachments: []
        }
      }
    }
  } as unknown as DiscoveryService
  return { service, session }
}

function inMemoryHistory(): {
  history: KnowledgeFullChainRunHistory
  records: KnowledgeFullChainRunRecord[]
} {
  const records: KnowledgeFullChainRunRecord[] = []
  return {
    records,
    history: {
      save: (record) => records.push(structuredClone(record)),
      list: () => [],
      read: (runId) => records.find((record) => record.runId === runId)
    }
  }
}

const BINDINGS: KnowledgeFullChainBindings = {
  maintainer: {
    connectionId: 'model:collaboration',
    modelId: 'collaboration',
    instructions: 'Maintain the repository.'
  },
  reviewer: {
    connectionId: 'model:collaboration',
    modelId: 'collaboration',
    instructions: 'Review the repository.'
  }
}

async function harness(
  maintainer: KnowledgeMaintainerRuntime = new FixtureKnowledgeMaintainerRuntime(),
  reviewer: KnowledgeReviewerRuntime = new FixtureKnowledgeReviewerRuntime()
) {
  const directory = await mkdtemp(join(tmpdir(), 'oyster-full-chain-'))
  temporaryDirectories.push(directory)
  const collaborations = new ProcessingRepository(join(directory, 'repository'))
  const processing = new KnowledgeProcessingService(
    new InMemoryKnowledgeProcessingRepository({
      stages: [
        { stageId: 'knowledge_maintenance_agent' },
        { stageId: 'knowledge_reviewer_agent' }
      ]
    }),
    new FakeBackend(),
    collaborations,
    maintainer,
    reviewer
  )
  await processing.initialize()
  const discovery = fakeDiscovery()
  const { history, records } = inMemoryHistory()
  return {
    processing,
    collaborations,
    discovery,
    records,
    service: new KnowledgeFullChainService(
      discovery.service,
      processing,
      collaborations,
      history
    )
  }
}

class RequestChangesOnceReviewer implements KnowledgeReviewerRuntime {
  calls = 0
  private readonly approval = new FixtureKnowledgeReviewerRuntime()

  async run(input: KnowledgeReviewerRunInput): Promise<RepositoryAgentRunResult> {
    this.calls += 1
    if (this.calls > 1) return this.approval.run(input)

    const statementPath = join(
      input.run.repositoryPath,
      'knowledge',
      'knowledge-processing.md'
    )
    const current = await readFile(statementPath, 'utf8')
    const marker = [
      REVIEW_MARKER_START,
      current.trimEnd(),
      REVIEW_MARKER_COMMENT,
      'Explain that the approved revision remains unmerged.',
      REVIEW_MARKER_END,
      ''
    ].join('\n')
    await writeFile(statementPath, marker, 'utf8')
    const workPath = input.run.workPath
    await writeFile(
      workPath,
      `${await readFile(workPath, 'utf8')}\n- [ ] Resolve the Reviewer request.\n`,
      'utf8'
    )
    await runArtifactGit(['add', '--', 'knowledge', 'artifacts'], input.run.repositoryPath)
    await runArtifactGit([
      'commit', '--quiet', '--no-gpg-sign', '-m', 'review: request unmerged explanation'
    ], input.run.repositoryPath)
    const run = completedAgentRun(input.runId, ['read', 'edit', 'bash'], 1, 'knowledge_reviewer_agent')
    input.onRunUpdate?.(run)
    return { run, modelCallCount: 1, toolCalls: run.toolCalls.map((call) => call.name) }
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => rm(directory, { recursive: true, force: true })
  ))
})

describe('KnowledgeFullChainService', () => {
  it('runs Maintainer then Reviewer on a real branch and stores a V7 unmerged result', async () => {
    const { service, processing, collaborations, discovery, records } = await harness()
    const baseRevision = await collaborations.currentRevision()
    const result = await service.run({
      sourceRecordId: discovery.session.sourceRecordId,
      expectedRevision: discovery.session.revision
    }, BINDINGS)

    expect(result.maintenanceRuns).toHaveLength(1)
    expect(result.reviewRuns).toEqual([
      expect.objectContaining({ outcome: 'approved', reviewedRevision: result.maintenanceRuns[0].revision })
    ])
    expect(result.approvedRevision).toBe(result.reviewRuns[0].revision)
    expect(result.knowledge.map((statement) => statement.title)).toEqual([
      'Knowledge Maintenance Agent',
      'Knowledge Reviewer',
      '知识加工链路'
    ])
    expect(result.changedPaths).toEqual(expect.arrayContaining([
      'knowledge/knowledge-processing.md',
      'knowledge/knowledge-maintainer.md',
      'knowledge/knowledge-reviewer.md'
    ]))
    expect(await collaborations.currentRevision()).toBe(baseRevision)
    await expect(readFile(result.run.workPath, 'utf8')).resolves.toContain('Reviewer approved revision')
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      formatVersion: 7,
      status: 'completed',
      result: { approvedRevision: result.approvedRevision }
    })
    expect(records[0].agentRuns).toHaveLength(2)
    expect(processing.snapshot().debugTraces.map((trace) => trace.run.agentId)).toEqual([
      'knowledge_maintenance_agent',
      'knowledge_reviewer_agent'
    ])
  })

  it('alternates Reviewer feedback and Maintainer repair before approval', async () => {
    const reviewer = new RequestChangesOnceReviewer()
    const { service, processing, collaborations, discovery } = await harness(
      new FixtureKnowledgeMaintainerRuntime(),
      reviewer
    )
    const baseRevision = await collaborations.currentRevision()
    const result = await service.run({
      sourceRecordId: discovery.session.sourceRecordId,
      expectedRevision: discovery.session.revision,
      attention: 'Keep the Git state explicit.'
    }, BINDINGS)

    expect(result.maintenanceRuns).toHaveLength(2)
    expect(result.reviewRuns.map((review) => review.outcome)).toEqual([
      'changes_requested',
      'approved'
    ])
    expect(result.reviewRuns[0].markerPaths).toEqual(['knowledge/knowledge-processing.md'])
    expect(result.maintenanceRuns[1].previousRevision).toBe(result.reviewRuns[0].revision)
    expect(result.reviewRuns[1].reviewedRevision).toBe(result.maintenanceRuns[1].revision)
    expect(processing.snapshot().debugTraces.map((trace) => trace.run.agentId)).toEqual([
      'knowledge_maintenance_agent',
      'knowledge_reviewer_agent',
      'knowledge_maintenance_agent',
      'knowledge_reviewer_agent'
    ])
    expect(await collaborations.currentRevision()).toBe(baseRevision)
    await expect(readFile(result.run.workPath, 'utf8')).resolves.toContain('Reviewer approved revision')
  })

  it('rejects a stale Session before creating a full-chain history record', async () => {
    const { service, processing, discovery, records } = await harness()
    discovery.service.listAvailableSessions = () => []

    await expect(service.run({
      sourceRecordId: discovery.session.sourceRecordId,
      expectedRevision: discovery.session.revision
    }, BINDINGS)).rejects.toThrow('Session 已不可用')

    expect(records).toEqual([])
    expect(processing.snapshot().debugTraces).toEqual([])
    expect(service.isRunning()).toBe(false)
  })
})

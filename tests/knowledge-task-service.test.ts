import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelGenerationRequest, SelectedModelStream } from '../src/main/ai-backends/model'
import { runArtifactGit } from '../src/main/artifacts/git-runtime'
import type { DiscoveryService } from '../src/main/discovery/discovery-service'
import {
  FixtureKnowledgeMaintainerRuntime,
  FixtureKnowledgeReviewerRuntime
} from '../src/main/knowledge-processing/fixture'
import { FileKnowledgeTaskHistory } from '../src/main/knowledge-processing/knowledge-task-history'
import type { KnowledgeTaskHistory } from '../src/main/knowledge-processing/knowledge-task-history'
import {
  KnowledgeProcessingService
} from '../src/main/knowledge-processing/knowledge-processing-service'
import {
  KnowledgeTaskService,
  type KnowledgeTaskBindings
} from '../src/main/knowledge-processing/knowledge-task-service'
import {
  KnowledgeTaskWorkspaceRepository,
  REVIEW_MARKER_COMMENT,
  REVIEW_MARKER_END,
  REVIEW_MARKER_START,
  type KnowledgeTaskWorkspace
} from '../src/main/knowledge-processing/knowledge-task-workspace-repository'
import type {
  AiBackendPort,
  KnowledgeMaintainerInvocationInput,
  KnowledgeMaintainerRuntime,
  KnowledgeReviewerInvocationInput,
  KnowledgeReviewerRuntime,
  RepositoryAgentInvocationResult
} from '../src/main/knowledge-processing/model'
import {
  InMemoryKnowledgeProcessingConfigurationRepository
} from '../src/main/knowledge-processing/repository'
import type { AiBackendSnapshot, AiConnection } from '../src/shared/ai-backends'
import type { SourceConversationSummary } from '../src/shared/discovery'
import type { KnowledgeTaskRecord } from '../src/shared/knowledge-processing'
import { completedAgentInvocation } from './agent-invocation-fixture'

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

  async withModelStream<T>(
    _connectionId: string,
    _modelId: string,
    operation: (modelStream: SelectedModelStream) => Promise<T>
  ): Promise<T> {
    return operation({
      model: { id: 'collaboration', contextWindow: 128_000 } as SelectedModelStream['model'],
      streamFn: (() => { throw new Error('not used') }) as SelectedModelStream['streamFn']
    })
  }
}

function fakeDiscovery() {
  const content = '{"role":"user","content":"Keep summaries concise."}'
  const sourceRevision = sha256(`revision\0${content}`)
  const sourceConversation: SourceConversationSummary = {
    sourceConversationId: 'source-conversation-1',
    sourceId: 'source:codex',
    agentType: 'codex',
    sourceDisplayName: 'OpenAI Codex',
    providerConversationId: 'provider-conversation-1',
    title: 'Knowledge test conversation',
    sizeBytes: Buffer.byteLength(content),
    sourceRevision
  }
  const service = {
    listSourceConversations: () => [structuredClone(sourceConversation)],
    readSourceSnapshot: async (input: {
      sourceConversationId: string
      sourceRevision: string
    }) => {
      if (
        input.sourceConversationId !== sourceConversation.sourceConversationId
        || input.sourceRevision !== sourceRevision
      ) throw new Error('The Source Snapshot has changed')
      return {
        sourceConversationId: sourceConversation.sourceConversationId,
        sourceRevision,
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
  return { service, sourceConversation }
}

function inMemoryHistory(): {
  history: KnowledgeTaskHistory
  records: KnowledgeTaskRecord[]
} {
  const records: KnowledgeTaskRecord[] = []
  return {
    records,
    history: {
      save: (record) => records.push(structuredClone(record)),
      list: () => [],
      read: (taskId) => records.find((record) => record.taskId === taskId)
    }
  }
}

const BINDINGS: KnowledgeTaskBindings = {
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
  reviewer: KnowledgeReviewerRuntime = new FixtureKnowledgeReviewerRuntime(),
  historyOverride: KnowledgeTaskHistory | 'file' | undefined = undefined
) {
  const directory = await mkdtemp(join(tmpdir(), 'oyster-knowledge-task-'))
  temporaryDirectories.push(directory)
  const workspaces = new KnowledgeTaskWorkspaceRepository(join(directory, 'repository'))
  const processing = new KnowledgeProcessingService(
    new InMemoryKnowledgeProcessingConfigurationRepository(),
    new FakeBackend(),
    workspaces,
    maintainer,
    reviewer
  )
  await processing.initialize()
  const discovery = fakeDiscovery()
  const { history, records } = inMemoryHistory()
  const selectedHistory = historyOverride === 'file'
    ? new FileKnowledgeTaskHistory(join(directory, 'repository', 'tasks'))
    : historyOverride ?? history
  return {
    processing,
    workspaces,
    discovery,
    records,
    service: new KnowledgeTaskService(
      discovery.service,
      processing,
      workspaces,
      selectedHistory
    )
  }
}

class CapturingMaintainer implements KnowledgeMaintainerRuntime {
  readonly workspaces: KnowledgeTaskWorkspace[] = []
  private readonly delegate = new FixtureKnowledgeMaintainerRuntime()

  async invoke(
    input: KnowledgeMaintainerInvocationInput
  ): Promise<RepositoryAgentInvocationResult> {
    this.workspaces.push(input.workspace)
    return this.delegate.invoke(input)
  }
}

class TaskRecordSquattingMaintainer implements KnowledgeMaintainerRuntime {
  workspace?: KnowledgeTaskWorkspace

  async invoke(
    input: KnowledgeMaintainerInvocationInput
  ): Promise<RepositoryAgentInvocationResult> {
    this.workspace = input.workspace
    await writeFile(join(input.workspace.workspacePath, 'task.json'), '{"ownedBy":"agent"}\n')
    throw new Error('Maintainer failed after creating reserved task.json')
  }
}

class RequestChangesOnceReviewer implements KnowledgeReviewerRuntime {
  calls = 0
  readonly workspaces: KnowledgeTaskWorkspace[] = []
  private readonly approval = new FixtureKnowledgeReviewerRuntime()

  async invoke(
    input: KnowledgeReviewerInvocationInput
  ): Promise<RepositoryAgentInvocationResult> {
    this.calls += 1
    this.workspaces.push(input.workspace)
    if (this.calls > 1) return this.approval.invoke(input)

    const statementPath = join(
      input.workspace.repositoryPath,
      'knowledge',
      'knowledge-processing.md'
    )
    const marker = [
      REVIEW_MARKER_START,
      (await readFile(statementPath, 'utf8')).trimEnd(),
      REVIEW_MARKER_COMMENT,
      'Explain that the approved revision remains unmerged.',
      REVIEW_MARKER_END,
      ''
    ].join('\n')
    await writeFile(statementPath, marker, 'utf8')
    await writeFile(
      input.workspace.progressPath,
      `${await readFile(input.workspace.progressPath, 'utf8')}\n- [ ] Resolve the Reviewer request.\n`,
      'utf8'
    )
    await runArtifactGit(['add', '--', 'knowledge', 'artifacts'], input.workspace.repositoryPath)
    await runArtifactGit([
      'commit', '--quiet', '--no-gpg-sign', '-m', 'review: request unmerged explanation'
    ], input.workspace.repositoryPath)
    const invocation = completedAgentInvocation(
      input.invocationId,
      ['read', 'edit', 'bash'],
      1,
      'knowledge_reviewer'
    )
    input.onInvocationUpdate?.(invocation)
    return {
      invocation,
      modelCallCount: 1,
      toolCalls: invocation.toolCalls.map((call) => call.name)
    }
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => rm(directory, { recursive: true, force: true })
  ))
})

describe('KnowledgeTaskService', () => {
  it('runs Maintainer then Reviewer on a real branch and stores an unmerged Task result', async () => {
    const { service, processing, workspaces, discovery, records } = await harness()
    const baseRepositoryRevision = await workspaces.currentRevision()
    const result = await service.start({
      sourceConversationId: discovery.sourceConversation.sourceConversationId,
      sourceRevision: discovery.sourceConversation.sourceRevision
    }, BINDINGS)

    expect(result.rounds).toHaveLength(1)
    expect(result.rounds[0].review).toMatchObject({
      decision: 'approved',
      reviewedRepositoryRevision: result.rounds[0].maintenance.candidateRepositoryRevision
    })
    expect(result.approvedRepositoryRevision)
      .toBe(result.rounds[0].review.candidateRepositoryRevision)
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
    expect(await workspaces.currentRevision()).toBe(baseRepositoryRevision)
    await expect(readFile(result.workspace.progressPath, 'utf8'))
      .resolves.toContain('Reviewer approved revision')
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      formatVersion: 1,
      status: 'completed',
      result: { approvedRepositoryRevision: result.approvedRepositoryRevision }
    })
    expect(records[0].agentInvocations).toHaveLength(2)
    expect(processing.stateView().liveInvocations.map((view) => view.invocation.agentId)).toEqual([
      'knowledge_maintainer',
      'knowledge_reviewer'
    ])
  })

  it('alternates Reviewer feedback and Maintainer repair before approval', async () => {
    const maintainer = new CapturingMaintainer()
    const reviewer = new RequestChangesOnceReviewer()
    const { service, processing, workspaces, discovery } = await harness(maintainer, reviewer)
    const baseRepositoryRevision = await workspaces.currentRevision()
    const result = await service.start({
      sourceConversationId: discovery.sourceConversation.sourceConversationId,
      sourceRevision: discovery.sourceConversation.sourceRevision,
      attention: 'Keep the Git state explicit.'
    }, BINDINGS)

    expect(result.rounds).toHaveLength(2)
    expect(result.rounds.map((round) => round.review.decision)).toEqual([
      'changes_requested',
      'approved'
    ])
    expect(result.rounds[0].review.markerPaths).toEqual(['knowledge/knowledge-processing.md'])
    expect(result.rounds[1].maintenance.previousRepositoryRevision)
      .toBe(result.rounds[0].review.candidateRepositoryRevision)
    expect(result.rounds[1].review.reviewedRepositoryRevision)
      .toBe(result.rounds[1].maintenance.candidateRepositoryRevision)
    const sharedWorkspace = {
      workspacePath: result.workspace.workspacePath,
      briefPath: result.workspace.briefPath,
      inputPath: result.workspace.inputPath,
      workspaceRevision: result.workspace.workspaceRevision
    }
    expect(result.rounds.map((round) => round.maintenance.workspace)).toEqual([
      expect.objectContaining(sharedWorkspace),
      expect.objectContaining(sharedWorkspace)
    ])
    expect(maintainer.workspaces).toEqual([
      expect.objectContaining(sharedWorkspace),
      expect.objectContaining(sharedWorkspace)
    ])
    expect(reviewer.workspaces).toEqual([
      expect.objectContaining(sharedWorkspace),
      expect.objectContaining(sharedWorkspace)
    ])
    expect(processing.stateView().liveInvocations.map((view) => view.invocation.agentId)).toEqual([
      'knowledge_maintainer',
      'knowledge_reviewer',
      'knowledge_maintainer',
      'knowledge_reviewer'
    ])
    expect(await workspaces.currentRevision()).toBe(baseRepositoryRevision)
  })

  it('stores terminal Task history beside the Task workspace files', async () => {
    const { service, discovery } = await harness(
      new FixtureKnowledgeMaintainerRuntime(),
      new FixtureKnowledgeReviewerRuntime(),
      'file'
    )
    const result = await service.start({
      sourceConversationId: discovery.sourceConversation.sourceConversationId,
      sourceRevision: discovery.sourceConversation.sourceRevision
    }, BINDINGS)

    expect(await readdir(result.workspace.workspacePath)).toEqual(expect.arrayContaining([
      'BRIEF.md',
      'PROGRESS.md',
      'inputs',
      'manifest.json',
      'task.json'
    ]))
    await expect(readFile(join(result.workspace.workspacePath, 'task.json'), 'utf8'))
      .resolves.toContain('"formatVersion": 1')
  })

  it('replaces an Agent-created reserved task.json with the failed terminal Task record', async () => {
    const maintainer = new TaskRecordSquattingMaintainer()
    const { service, discovery } = await harness(
      maintainer,
      new FixtureKnowledgeReviewerRuntime(),
      'file'
    )

    await expect(service.start({
      sourceConversationId: discovery.sourceConversation.sourceConversationId,
      sourceRevision: discovery.sourceConversation.sourceRevision
    }, BINDINGS)).rejects.toThrow('Maintainer failed after creating reserved task.json')

    expect(maintainer.workspace).toBeDefined()
    const record = JSON.parse(await readFile(
      join(maintainer.workspace!.workspacePath, 'task.json'),
      'utf8'
    ))
    expect(record).toMatchObject({
      formatVersion: 1,
      status: 'failed',
      error: 'Maintainer failed after creating reserved task.json'
    })
  })

  it('preserves the Agent failure when reserved-file cleanup also fails', async () => {
    const maintainer = new TaskRecordSquattingMaintainer()
    const { service, workspaces, discovery } = await harness(maintainer)
    vi.spyOn(workspaces, 'removeReservedTaskRecord')
      .mockRejectedValueOnce(new Error('Reserved-file cleanup failed'))

    const failure = await service.start({
      sourceConversationId: discovery.sourceConversation.sourceConversationId,
      sourceRevision: discovery.sourceConversation.sourceRevision
    }, BINDINGS).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).message)
      .toBe('Maintainer failed after creating reserved task.json')
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({ message: 'Maintainer failed after creating reserved task.json' }),
      expect.objectContaining({ message: 'Reserved-file cleanup failed' })
    ])
  })

  it('preserves the Agent failure when terminal history cannot be saved', async () => {
    const failingHistory: KnowledgeTaskHistory = {
      save: () => { throw new Error('Terminal history save failed') },
      list: () => [],
      read: () => undefined
    }
    const { service, discovery } = await harness(
      new TaskRecordSquattingMaintainer(),
      new FixtureKnowledgeReviewerRuntime(),
      failingHistory
    )

    const failure = await service.start({
      sourceConversationId: discovery.sourceConversation.sourceConversationId,
      sourceRevision: discovery.sourceConversation.sourceRevision
    }, BINDINGS).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).message)
      .toBe('Maintainer failed after creating reserved task.json')
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({ message: 'Maintainer failed after creating reserved task.json' }),
      expect.objectContaining({ message: 'Terminal history save failed' })
    ])
  })

  it('rejects an unavailable Source Conversation before accepting a Task', async () => {
    const { service, processing, discovery, records } = await harness()
    discovery.service.listSourceConversations = () => []

    await expect(service.start({
      sourceConversationId: discovery.sourceConversation.sourceConversationId,
      sourceRevision: discovery.sourceConversation.sourceRevision
    }, BINDINGS)).rejects.toThrow('所选来源对话已不可用')

    expect(records).toEqual([])
    expect(processing.stateView().liveInvocations).toEqual([])
    expect(service.isActive()).toBe(false)
  })
})

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import type { ModelGenerationRequest, SelectedModelStream } from '../src/main/ai-backends/model'
import type { DiscoveryService } from '../src/main/discovery/discovery-service'
import {
  FixtureKnowledgeMaintainerRuntime,
  FixtureKnowledgeReviewerRuntime
} from '../src/main/knowledge-processing/fixture'
import { GitKnowledgeTaskHistory } from '../src/main/knowledge-processing/knowledge-task-history'
import type { KnowledgeTaskHistory } from '../src/main/knowledge-processing/knowledge-task-history'
import {
  KnowledgeProcessingService
} from '../src/main/knowledge-processing/knowledge-processing-service'
import {
  KnowledgeTaskService,
  type KnowledgeTaskBindings
} from '../src/main/knowledge-processing/knowledge-task-service'
import {
  KnowledgeTaskGitRepository,
  REVIEW_MARKER_COMMENT,
  REVIEW_MARKER_END,
  REVIEW_MARKER_START,
  type KnowledgeTaskWorktree
} from '../src/main/knowledge-processing/knowledge-task-git-repository'
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
import type { StartKnowledgeTaskInput } from '../src/shared/knowledge-processing'
import { completedAgentInvocation } from './agent-invocation-fixture'
import {
  ARTIFACT_GIT_BINARY_PATH,
  createArtifactGitEnvironment
} from '../src/main/artifacts/git-runtime'

const temporaryDirectories: string[] = []
const execFileAsync = promisify(execFile)

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(ARTIFACT_GIT_BINARY_PATH, args, {
    cwd,
    env: createArtifactGitEnvironment()
  })
  return stdout.trimEnd()
}

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
  const sourceConversation: SourceConversationSummary & { sourceRevision: string } = {
    sourceConversationId: 'source-conversation-1',
    sourceId: 'source:codex',
    agentType: 'codex',
    sourceDisplayName: 'OpenAI Codex',
    providerConversationId: 'provider-conversation-1',
    title: 'Knowledge test conversation',
    sizeBytes: Buffer.byteLength(content),
    sourceRevision: 'legacy-catalog-revision'
  }
  const service = {
    listSourceConversations: () => [structuredClone(sourceConversation)],
    readSourceSnapshot: async (input: {
      sourceConversationId: string
    }) => {
      if (input.sourceConversationId !== sourceConversation.sourceConversationId) {
        throw new Error('The Source Conversation is unavailable')
      }
      return {
        sourceConversationId: sourceConversation.sourceConversationId,
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
  const tasks = new KnowledgeTaskGitRepository(join(directory, 'repository'))
  const processing = new KnowledgeProcessingService(
    new InMemoryKnowledgeProcessingConfigurationRepository(),
    new FakeBackend(),
    tasks,
    maintainer,
    reviewer
  )
  await processing.initialize()
  const discovery = fakeDiscovery()
  const selectedHistory = historyOverride === 'file'
    ? new GitKnowledgeTaskHistory(join(directory, 'repository'), tasks)
    : historyOverride
  return {
    processing,
    tasks,
    discovery,
    service: new KnowledgeTaskService(
      discovery.service,
      processing,
      tasks,
      selectedHistory
    )
  }
}

class CapturingMaintainer implements KnowledgeMaintainerRuntime {
  readonly tasks: KnowledgeTaskWorktree[] = []
  private readonly delegate = new FixtureKnowledgeMaintainerRuntime()

  async invoke(
    input: KnowledgeMaintainerInvocationInput
  ): Promise<RepositoryAgentInvocationResult> {
    this.tasks.push(input.worktree)
    return this.delegate.invoke(input)
  }
}

class TaskRecordSquattingMaintainer implements KnowledgeMaintainerRuntime {
  worktree?: KnowledgeTaskWorktree

  async invoke(
    input: KnowledgeMaintainerInvocationInput
  ): Promise<RepositoryAgentInvocationResult> {
    this.worktree = input.worktree
    await writeFile(join(input.worktree.taskPath, 'task.json'), '{"ownedBy":"agent"}\n')
    throw new Error('Maintainer failed after creating reserved task.json')
  }
}

class RequestChangesOnceReviewer implements KnowledgeReviewerRuntime {
  calls = 0
  readonly tasks: KnowledgeTaskWorktree[] = []
  private readonly approval = new FixtureKnowledgeReviewerRuntime()

  async invoke(
    input: KnowledgeReviewerInvocationInput
  ): Promise<RepositoryAgentInvocationResult> {
    this.calls += 1
    this.tasks.push(input.worktree)
    if (this.calls > 1) return this.approval.invoke(input)

    const statementPath = join(
      input.worktree.worktreePath,
      'knowledge',
      'knowledge-processing.md'
    )
    const marker = [
      REVIEW_MARKER_START,
      (await readFile(statementPath, 'utf8')).trimEnd(),
      REVIEW_MARKER_COMMENT,
      'Explain how the candidate becomes reusable Knowledge.',
      REVIEW_MARKER_END,
      ''
    ].join('\n')
    await writeFile(statementPath, marker, 'utf8')
    await writeFile(
      input.worktree.progressPath,
      `${await readFile(input.worktree.progressPath, 'utf8')}\n- [ ] Resolve the Reviewer request.\n`,
      'utf8'
    )
    await git(['add', '-A'], input.worktree.worktreePath)
    await git([
      'commit', '--quiet', '--no-gpg-sign', '-m', 'fixture: request review changes'
    ], input.worktree.worktreePath)
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

class ConcurrentMaintainerFailure implements KnowledgeMaintainerRuntime {
  readonly invocationIds: string[] = []
  readonly worktrees: KnowledgeTaskWorktree[] = []
  private readonly delegate = new FixtureKnowledgeMaintainerRuntime()
  private firstStartedResolve!: () => void
  private secondStartedResolve!: () => void
  private releaseFirstResolve!: () => void
  private releaseSecondResolve!: () => void
  readonly firstStarted = new Promise<void>((resolve) => { this.firstStartedResolve = resolve })
  readonly secondStarted = new Promise<void>((resolve) => { this.secondStartedResolve = resolve })
  private readonly releaseFirst = new Promise<void>((resolve) => { this.releaseFirstResolve = resolve })
  private readonly releaseSecond = new Promise<void>((resolve) => { this.releaseSecondResolve = resolve })

  async invoke(
    input: KnowledgeMaintainerInvocationInput
  ): Promise<RepositoryAgentInvocationResult> {
    const sequence = this.invocationIds.push(input.invocationId)
    this.worktrees.push(input.worktree)
    const result = await this.delegate.invoke(input)
    if (sequence === 1) {
      this.firstStartedResolve()
      await this.releaseFirst
      throw new Error('First concurrent Task failed')
    }
    this.secondStartedResolve()
    await this.releaseSecond
    return result
  }

  failFirst(): void {
    this.releaseFirstResolve()
  }

  completeSecond(): void {
    this.releaseSecondResolve()
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => rm(directory, { recursive: true, force: true })
  ))
})

describe('KnowledgeTaskService', () => {
  it('completes only after Reviewer fast-forwards the Task revision into main', async () => {
    const { service, processing, tasks, discovery } = await harness()
    const baseRepositoryRevision = await tasks.currentRevision()
    const result = await service.start({
      sourceConversationId: discovery.sourceConversation.sourceConversationId
    }, BINDINGS)

    expect(result.approvedRepositoryRevision).toBe(result.integratedRepositoryRevision)
    expect(result.integratedRepositoryRevision).not.toBe(baseRepositoryRevision)
    expect(result.changedPaths).toEqual(expect.arrayContaining([
      'knowledge/knowledge-processing.md',
      'knowledge/knowledge-maintainer.md',
      'knowledge/knowledge-reviewer.md',
      `tasks/${result.taskId}/task.json`
    ]))
    expect(await tasks.currentRevision()).toBe(result.integratedRepositoryRevision)
    expect(await git(['rev-parse', 'HEAD'], result.worktree.repositoryPath))
      .toBe(result.integratedRepositoryRevision)
    expect(processing.stateView().liveInvocations.map((view) => view.invocation.agentId)).toEqual([
      'knowledge_maintainer',
      'knowledge_reviewer'
    ])
  })

  it('alternates Reviewer feedback and Maintainer repair before approval', async () => {
    const maintainer = new CapturingMaintainer()
    const reviewer = new RequestChangesOnceReviewer()
    const { service, processing, tasks, discovery } = await harness(maintainer, reviewer)
    const baseRepositoryRevision = await tasks.currentRevision()
    const result = await service.start({
      sourceConversationId: discovery.sourceConversation.sourceConversationId,
      attention: 'Keep the Git state explicit.'
    }, BINDINGS)

    const sharedWorktree = {
      taskPath: result.worktree.taskPath,
      briefPath: result.worktree.briefPath,
      inputPath: result.worktree.inputPath,
      baseRepositoryRevision: result.worktree.baseRepositoryRevision
    }
    expect(maintainer.tasks).toEqual([
      expect.objectContaining(sharedWorktree),
      expect.objectContaining(sharedWorktree)
    ])
    expect(reviewer.tasks).toEqual([
      expect.objectContaining(sharedWorktree),
      expect.objectContaining(sharedWorktree)
    ])
    expect(processing.stateView().liveInvocations.map((view) => view.invocation.agentId)).toEqual([
      'knowledge_maintainer',
      'knowledge_reviewer',
      'knowledge_maintainer',
      'knowledge_reviewer'
    ])
    expect(reviewer.calls).toBe(2)
    expect(result.integratedRepositoryRevision).not.toBe(baseRepositoryRevision)
    expect(await tasks.currentRevision()).toBe(result.integratedRepositoryRevision)
  })

  it('keeps a small immutable Task definition and runtime-only Pi sessions', async () => {
    const { service, discovery } = await harness(
      new FixtureKnowledgeMaintainerRuntime(),
      new FixtureKnowledgeReviewerRuntime(),
      'file'
    )
    const input: StartKnowledgeTaskInput & { sourceRevision: string } = {
      sourceConversationId: discovery.sourceConversation.sourceConversationId,
      sourceRevision: 'legacy-selection-revision'
    }
    const result = await service.start(input, BINDINGS)

    expect(await readdir(result.worktree.taskPath)).toEqual(expect.arrayContaining([
      'BRIEF.md',
      'PROGRESS.md',
      'inputs',
      'task.json'
    ]))
    expect(await readdir(result.worktree.taskPath)).not.toContain('pi-sessions')
    const definition = JSON.parse(await readFile(
      join(result.worktree.taskPath, 'task.json'),
      'utf8'
    )) as Record<string, unknown>
    expect(definition).toMatchObject({ formatVersion: 3, taskId: result.taskId })
    expect(definition.input).toEqual({
      sourceConversationId: discovery.sourceConversation.sourceConversationId
    })
    expect(definition.sourceConversation).not.toHaveProperty('sourceRevision')
    expect(result.sourceConversation).not.toHaveProperty('sourceRevision')
    expect(definition).not.toHaveProperty('status')
    expect(definition).not.toHaveProperty('result')
    expect(definition).not.toHaveProperty('agentInvocations')
    expect(definition).not.toHaveProperty('lastError')
    const readModel = await service.readTask(result.taskId)
    expect(readModel).toMatchObject({
      formatVersion: 3,
      status: 'completed',
      result: {
        integratedRepositoryRevision: result.integratedRepositoryRevision,
        changedPaths: result.changedPaths
      }
    })
    expect(readModel?.input).toEqual({
      sourceConversationId: discovery.sourceConversation.sourceConversationId
    })
    expect(readModel?.sourceConversation).not.toHaveProperty('sourceRevision')
    expect(readModel?.result?.sourceConversation).not.toHaveProperty('sourceRevision')
  })

  it('preserves failed Agent working-tree facts without rewriting task.json', async () => {
    const maintainer = new TaskRecordSquattingMaintainer()
    const { service, discovery } = await harness(
      maintainer,
      new FixtureKnowledgeReviewerRuntime(),
      'file'
    )

    await expect(service.start({
      sourceConversationId: discovery.sourceConversation.sourceConversationId
    }, BINDINGS)).rejects.toThrow('Maintainer failed after creating reserved task.json')

    expect(maintainer.worktree).toBeDefined()
    expect(JSON.parse(await readFile(
      join(maintainer.worktree!.taskPath, 'task.json'),
      'utf8'
    ))).toEqual({ ownedBy: 'agent' })
    expect(await git(['status', '--porcelain'], maintainer.worktree!.worktreePath))
      .toContain('tasks/')
  })

  it('does not call Task history writes after an Agent failure', async () => {
    let historyWrites = 0
    const failingHistory: KnowledgeTaskHistory = {
      list: async () => [],
      read: async () => {
        historyWrites += 1
        throw new Error('Task history should remain read-only')
      }
    }
    const maintainer = new TaskRecordSquattingMaintainer()
    const { service, discovery } = await harness(
      maintainer,
      new FixtureKnowledgeReviewerRuntime(),
      failingHistory
    )

    const failure = await service.start({
      sourceConversationId: discovery.sourceConversation.sourceConversationId
    }, BINDINGS).catch((error: unknown) => error)

    expect(failure).toMatchObject({ message: 'Maintainer failed after creating reserved task.json' })
    expect(historyWrites).toBe(0)
    await expect(readFile(maintainer.worktree!.briefPath, 'utf8'))
      .resolves.toContain('Knowledge Processing Task')
  })

  it('keeps one Task failure isolated while another Task completes', async () => {
    const maintainer = new ConcurrentMaintainerFailure()
    const { service, discovery, tasks } = await harness(
      maintainer,
      new FixtureKnowledgeReviewerRuntime()
    )
    const taskInput = {
      sourceConversationId: discovery.sourceConversation.sourceConversationId
    }

    const first = service.start(taskInput, BINDINGS)
    await maintainer.firstStarted
    const second = service.start(taskInput, BINDINGS)
    await maintainer.secondStarted
    maintainer.failFirst()

    await expect(first).rejects.toThrow('First concurrent Task failed')
    expect(await git(['rev-parse', 'HEAD'], maintainer.worktrees[0].worktreePath))
      .not.toBe(maintainer.worktrees[0].baseRepositoryRevision)

    maintainer.completeSecond()
    const completed = await second
    expect(await tasks.currentRevision()).toBe(completed.integratedRepositoryRevision)
  })

  it('rejects an unavailable Source Conversation before accepting a Task', async () => {
    const { service, processing, discovery } = await harness()
    discovery.service.listSourceConversations = () => []

    await expect(service.start({
      sourceConversationId: discovery.sourceConversation.sourceConversationId
    }, BINDINGS)).rejects.toThrow('所选来源对话已不可用')

    expect(processing.stateView().liveInvocations).toEqual([])
    expect(service.isActive()).toBe(false)
  })
})

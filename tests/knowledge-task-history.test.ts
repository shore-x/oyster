import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileKnowledgeTaskHistory } from '../src/main/knowledge-processing/knowledge-task-history'
import type { KnowledgeTaskRecord } from '../src/shared/knowledge-processing'
import { completedAgentInvocation } from './agent-invocation-fixture'
import { parseAgentInvocationRecord } from '../src/main/agent-runtime/agent-invocation-record'

function record(taskId = 'task-history'): KnowledgeTaskRecord {
  const maintainer = completedAgentInvocation(
    'maintainer-invocation',
    ['read'],
    1,
    'knowledge_maintainer'
  )
  const reviewer = completedAgentInvocation(
    'reviewer-invocation',
    ['read'],
    1,
    'knowledge_reviewer'
  )
  const baseRepositoryRevision = 'a'.repeat(40)
  const approvedRepositoryRevision = 'b'.repeat(40)
  const sourceConversation = {
    sourceConversationId: 'source-conversation-1',
    sourceId: 'source:codex',
    agentType: 'codex' as const,
    sourceDisplayName: 'Codex',
    providerConversationId: 'provider-conversation-1',
    title: 'History conversation',
    sizeBytes: 100,
    sourceRevision: 'source-revision-1'
  }
  const workspace = {
    taskId,
    repositoryPath: '/tmp/oyster/repository',
    workspacePath: `/tmp/oyster/repository/tasks/${taskId}`,
    briefPath: `/tmp/oyster/repository/tasks/${taskId}/BRIEF.md`,
    progressPath: `/tmp/oyster/repository/tasks/${taskId}/PROGRESS.md`,
    inputPath: `/tmp/oyster/repository/tasks/${taskId}/inputs`,
    workspaceRevision: 'c'.repeat(64),
    targetBranch: 'main',
    branchName: `knowledge-task/${taskId}`,
    baseRepositoryRevision
  }
  const invocation = {
    connectionId: 'connection',
    connectionName: 'Connection',
    backendKind: 'api' as const,
    providerId: 'openai_compatible' as const,
    runtime: 'pi_coding_agent' as const,
    modelCallCount: 1,
    toolCalls: ['read']
  }
  return {
    formatVersion: 1,
    taskId,
    status: 'completed',
    startedAt: '2026-08-06T00:00:00.000Z',
    completedAt: '2026-08-06T00:00:01.000Z',
    durationMs: 1_000,
    input: {
      sourceConversationId: sourceConversation.sourceConversationId,
      sourceRevision: sourceConversation.sourceRevision
    },
    sourceConversation,
    configuration: {
      maintainer: { connectionId: 'connection', modelId: 'maintainer', instructions: 'Maintain.' },
      reviewer: { connectionId: 'connection', modelId: 'reviewer', instructions: 'Review.' }
    },
    agentInvocations: [
      parseAgentInvocationRecord(maintainer),
      parseAgentInvocationRecord(reviewer)
    ],
    result: {
      taskId,
      sourceConversation,
      sourceSnapshot: {
        sourceConversationId: sourceConversation.sourceConversationId,
        sourceRevision: sourceConversation.sourceRevision
      },
      sourceRef: 'raw:source-conversation-1@source-revision-1',
      workspace,
      rounds: [{
        roundId: 'round-1',
        sequence: 1,
        maintenance: {
          agentId: 'knowledge_maintainer',
          sourceRef: 'raw:source-conversation-1@source-revision-1',
          activitySegmentCount: 1,
          workspace,
          previousRepositoryRevision: baseRepositoryRevision,
          candidateRepositoryRevision: approvedRepositoryRevision,
          changedPaths: ['knowledge/subject.md'],
          agentInvocationId: maintainer.id,
          durationMs: 500,
          completedAt: '2026-08-06T00:00:00.500Z',
          invocation: { ...invocation, model: 'maintainer' }
        },
        review: {
          agentId: 'knowledge_reviewer',
          decision: 'approved',
          reviewedRepositoryRevision: approvedRepositoryRevision,
          candidateRepositoryRevision: approvedRepositoryRevision,
          changedPaths: [],
          markerPaths: [],
          agentInvocationId: reviewer.id,
          durationMs: 500,
          completedAt: '2026-08-06T00:00:01.000Z',
          invocation: { ...invocation, model: 'reviewer' }
        }
      }],
      approvedRepositoryRevision,
      changedPaths: ['knowledge/subject.md'],
      knowledge: [{ title: 'Subject', content: 'Body.' }],
      artifactPaths: [],
      durationMs: 1_000,
      completedAt: '2026-08-06T00:00:01.000Z'
    }
  }
}

describe('FileKnowledgeTaskHistory', () => {
  it('stores terminal history in tasks/<task-id>/task.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oyster-task-history-'))
    const repository = new FileKnowledgeTaskHistory(join(root, 'tasks'))
    const value = record()
    repository.save(value)
    expect(repository.read(value.taskId)).toEqual(value)
    expect(repository.list()).toEqual([
      expect.objectContaining({
        taskId: value.taskId,
        agentInvocationCount: 2,
        statementCount: 1
      })
    ])
  })

  it('does not overwrite an existing terminal Task record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oyster-task-history-'))
    const repository = new FileKnowledgeTaskHistory(join(root, 'tasks'))
    repository.save(record())
    expect(() => repository.save(record())).toThrow()
  })

  it('deletes an older incompatible Task directory while listing history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oyster-task-history-'))
    const tasksPath = join(root, 'tasks')
    const repository = new FileKnowledgeTaskHistory(tasksPath)
    const current = record('current-task')
    repository.save(current)
    const legacy = { ...record('legacy-task'), formatVersion: 0 }
    const legacyPath = join(tasksPath, legacy.taskId)
    await mkdir(legacyPath)
    await writeFile(join(legacyPath, 'task.json'), JSON.stringify(legacy), 'utf8')

    expect(repository.list()).toEqual([
      expect.objectContaining({ taskId: current.taskId })
    ])
    expect(await readdir(tasksPath)).toEqual([current.taskId])
  })

  it('preserves and reports unsupported future Task records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oyster-task-history-'))
    const tasksPath = join(root, 'tasks')
    const repository = new FileKnowledgeTaskHistory(tasksPath)
    const future = { ...record('future-task'), formatVersion: 2 }
    const futurePath = join(tasksPath, future.taskId)
    await mkdir(futurePath)
    await writeFile(join(futurePath, 'task.json'), JSON.stringify(future), 'utf8')

    expect(() => repository.list()).toThrow(
      `Knowledge Task 历史记录格式无效：${future.taskId}`
    )
    expect(await readdir(tasksPath)).toEqual([future.taskId])
  })
})

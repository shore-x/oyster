import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitKnowledgeTaskHistory } from '../src/main/knowledge-processing/knowledge-task-history'
import {
  KnowledgeTaskGitRepository,
  type KnowledgeTaskWorktree
} from '../src/main/knowledge-processing/knowledge-task-git-repository'
import { OysterRepository } from '../src/main/repository/oyster-repository'
import type { KnowledgeTaskRecord } from '../src/shared/knowledge-processing'

const temporaryDirectories: string[] = []

function openRecord(taskId: string): KnowledgeTaskRecord {
  return {
    formatVersion: 2,
    taskId,
    status: 'open',
    startedAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
    durationMs: 0,
    input: {
      sourceConversationId: 'source-conversation-1',
      sourceRevision: 'source-revision-1'
    },
    sourceConversation: {
      sourceConversationId: 'source-conversation-1',
      sourceId: 'source:codex',
      agentType: 'codex',
      sourceDisplayName: 'Codex',
      providerConversationId: 'provider-conversation-1',
      title: 'History conversation',
      sizeBytes: 100,
      sourceRevision: 'source-revision-1'
    },
    configuration: {
      maintainer: { connectionId: 'connection', modelId: 'maintainer', instructions: 'Maintain.' },
      reviewer: { connectionId: 'connection', modelId: 'reviewer', instructions: 'Review.' }
    },
    agentInvocations: []
  }
}

async function fixture(taskId = 'task-history') {
  const root = await mkdtemp(join(tmpdir(), 'oyster-task-history-'))
  temporaryDirectories.push(root)
  const repository = new OysterRepository(join(root, 'repository'))
  const tasks = new KnowledgeTaskGitRepository(repository)
  const initial = openRecord(taskId)
  const worktree = await tasks.createWorktree({
    taskId,
    kind: 'task',
    sourceRef: 'raw:test@revision',
    taskRecord: initial,
    plan: {
      files: [{ relativePath: 'inputs/README.md', content: '# Inputs\n' }],
      items: ['Inspect input.'],
      activitySegmentCount: 1,
      activityPageCount: 1,
      evidencePageCount: 1,
      attachmentCount: 0,
      canonicalActivityFormat: 'test-activity-v1',
      rawEvidenceFormat: 'test-raw-v1',
      activityCount: 1,
      rawEvidenceLineCount: 1
    }
  })
  const history = new GitKnowledgeTaskHistory(repository, tasks)
  return { root, repository, tasks, worktree, history, initial }
}

function completedRecord(
  initial: KnowledgeTaskRecord,
  worktree: KnowledgeTaskWorktree
): KnowledgeTaskRecord {
  const completedAt = '2026-08-11T00:00:01.000Z'
  const worktreeView = {
    taskId: worktree.taskId,
    repositoryPath: worktree.repositoryPath,
    worktreePath: worktree.worktreePath,
    runtimePath: worktree.runtimePath,
    taskPath: worktree.taskPath,
    briefPath: worktree.briefPath,
    progressPath: worktree.progressPath,
    inputPath: worktree.inputPath,
    targetBranch: worktree.targetBranch,
    branchName: worktree.branchName,
    baseRepositoryRevision: worktree.baseRepositoryRevision,
    taskStartRepositoryRevision: worktree.taskStartRepositoryRevision
  }
  return {
    ...initial,
    status: 'completed',
    updatedAt: completedAt,
    completedAt,
    durationMs: 1_000,
    result: {
      taskId: initial.taskId,
      sourceConversation: initial.sourceConversation!,
      sourceSnapshot: initial.input,
      sourceRef: 'raw:test@revision',
      worktree: worktreeView,
      rounds: [],
      approvedRepositoryRevision: worktree.taskStartRepositoryRevision,
      changedPaths: [`tasks/${initial.taskId}/task.json`],
      knowledge: [],
      artifactPaths: [],
      durationMs: 1_000,
      completedAt
    }
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => rm(directory, { recursive: true, force: true })
  ))
})

describe('GitKnowledgeTaskHistory', () => {
  it('reads and updates Task state from its Task branch', async () => {
    const { repository, worktree, history, initial } = await fixture()
    const completed = completedRecord(initial, worktree)

    await history.save(completed, worktree)

    await expect(history.read(initial.taskId)).resolves.toEqual(completed)
    await expect(history.list()).resolves.toEqual([
      expect.objectContaining({
        taskId: initial.taskId,
        status: 'completed',
        statementCount: 0
      })
    ])
    await expect(readFile(join(worktree.taskPath, 'task.json'), 'utf8'))
      .resolves.toContain('"status": "completed"')
  })

  it('keeps a failed Agent execution as an open Task checkpoint', async () => {
    const { worktree, history, initial } = await fixture('recoverable-task')
    const updated: KnowledgeTaskRecord = {
      ...initial,
      updatedAt: '2026-08-11T00:00:02.000Z',
      durationMs: 2_000,
      lastError: 'Provider disconnected'
    }

    await history.save(updated, worktree)

    await expect(history.read(initial.taskId)).resolves.toMatchObject({
      status: 'open',
      lastError: 'Provider disconnected'
    })
  })

  it('preserves and reads a legacy ignored Task record without deleting it', async () => {
    const { repository, tasks, worktree, initial } = await fixture('current-task')
    const legacyTaskId = 'legacy-task'
    const legacyPath = join(repository.tasksPath, legacyTaskId, 'task.json')
    await mkdir(join(legacyPath, '..'), { recursive: true })
    const current = completedRecord({ ...initial, taskId: legacyTaskId }, worktree)
    const { worktree: _worktree, ...legacyResult } = current.result!
    const legacyWorkspace = {
      taskId: legacyTaskId,
      repositoryPath: worktree.repositoryPath,
      workspacePath: join(repository.tasksPath, legacyTaskId),
      briefPath: join(repository.tasksPath, legacyTaskId, 'BRIEF.md'),
      progressPath: join(repository.tasksPath, legacyTaskId, 'PROGRESS.md'),
      inputPath: join(repository.tasksPath, legacyTaskId, 'inputs'),
      workspaceRevision: 'f'.repeat(64),
      branchName: `knowledge-task/${legacyTaskId}`,
      targetBranch: 'main',
      baseRepositoryRevision: worktree.baseRepositoryRevision
    }
    const legacy: Record<string, unknown> = {
      ...current,
      formatVersion: 1,
      result: { ...legacyResult, workspace: legacyWorkspace }
    }
    delete legacy.updatedAt
    await writeFile(legacyPath, JSON.stringify(legacy), { flag: 'wx' })
    const history = new GitKnowledgeTaskHistory(repository, tasks)

    const migrated = await history.read(legacyTaskId)

    expect(migrated).toMatchObject({
      formatVersion: 2,
      status: 'completed',
      result: {
        worktree: {
          worktreePath: worktree.repositoryPath,
          taskPath: legacyWorkspace.workspacePath,
          branchName: `knowledge-task/${legacyTaskId}`
        }
      }
    })
    await expect(readFile(legacyPath, 'utf8')).resolves.toContain('"formatVersion":1')
  })
})

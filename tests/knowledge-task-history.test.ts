import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ARTIFACT_GIT_BINARY_PATH,
  createArtifactGitEnvironment,
  runArtifactGit
} from '../src/main/artifacts/git-runtime'
import { GitKnowledgeTaskHistory } from '../src/main/knowledge-processing/knowledge-task-history'
import {
  KnowledgeTaskGitRepository,
  type KnowledgeTaskWorktree
} from '../src/main/knowledge-processing/knowledge-task-git-repository'
import { OysterRepository } from '../src/main/repository/oyster-repository'
import type { KnowledgeTaskDefinition } from '../src/shared/knowledge-processing'

const temporaryDirectories: string[] = []
const execFileAsync = promisify(execFile)

async function gitOutput(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(ARTIFACT_GIT_BINARY_PATH, args, {
    cwd,
    env: createArtifactGitEnvironment()
  })
  return stdout.trimEnd()
}

function openRecord(taskId: string): KnowledgeTaskDefinition {
  return {
    formatVersion: 3,
    taskId,
    startedAt: '2026-08-11T00:00:00.000Z',
    input: { sourceConversationId: 'source-conversation-1' },
    sourceRef: 'raw:test@revision',
    sourceConversation: {
      sourceConversationId: 'source-conversation-1',
      sourceId: 'source:codex',
      agentType: 'codex',
      sourceDisplayName: 'Codex',
      providerConversationId: 'provider-conversation-1',
      title: 'History conversation',
      sizeBytes: 100
    },
    configuration: {
      maintainer: { connectionId: 'connection', modelId: 'maintainer' },
      reviewer: { connectionId: 'connection', modelId: 'reviewer' }
    }
  }
}

async function fixture(taskId = 'task-history') {
  const root = await mkdtemp(join(tmpdir(), 'oyster-task-history-'))
  temporaryDirectories.push(root)
  const repository = new OysterRepository(join(root, 'repository'))
  const tasks = new KnowledgeTaskGitRepository(repository)
  const worktree = await tasks.createWorktree({
    taskId,
    kind: 'task',
    taskDefinition: openRecord(taskId),
    plan: {
      files: [{ relativePath: 'inputs/activity.md', content: '# Activity\n' }],
      items: ['Inspect input.'],
    }
  })
  const history = new GitKnowledgeTaskHistory(repository, tasks)
  return { root, repository, tasks, worktree, history }
}

async function agentCommit(
  worktree: KnowledgeTaskWorktree,
  message: string,
  allowEmpty = false
): Promise<void> {
  await runArtifactGit(['add', '-A'], worktree.worktreePath)
  await runArtifactGit([
    'commit', '--quiet', ...(allowEmpty ? ['--allow-empty'] : []), '--no-gpg-sign', '-m', message
  ], worktree.worktreePath)
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => rm(directory, { recursive: true, force: true })
  ))
})

describe('GitKnowledgeTaskHistory', () => {
  it('derives open while the Task tip remains outside main and ignores JSON lifecycle fields', async () => {
    const { worktree, history } = await fixture()
    await agentCommit(worktree, 'maintainer: candidate', true)

    const record = await history.read(worktree.taskId)
    expect(record).toMatchObject({
      taskId: worktree.taskId,
      status: 'open',
      sourceRef: 'raw:test@revision'
    })
    expect(record).not.toHaveProperty('result')
    await expect(history.list()).resolves.toEqual([
      expect.objectContaining({
        taskId: worktree.taskId,
        status: 'open',
        changedPathCount: 0
      })
    ])
  })

  it('derives completed and changed paths once Task tip is an ancestor of main', async () => {
    const { repository, worktree, history } = await fixture('completed-task')
    await writeFile(join(worktree.worktreePath, 'knowledge', 'task-change.md'), [
      '# Task change', '', 'Task-owned.', ''
    ].join('\n'))
    await agentCommit(worktree, 'maintainer: task change')
    await runArtifactGit(['merge', '--quiet', '--ff-only', worktree.branchName], repository.rootPath)

    const record = await history.read(worktree.taskId)
    expect(record).toMatchObject({
      status: 'completed',
      result: {
        changedPaths: expect.arrayContaining([
          'knowledge/task-change.md',
          'tasks/completed-task/task.json'
        ])
      }
    })
    expect(record?.result?.approvedRepositoryRevision)
      .toBe(record?.result?.integratedRepositoryRevision)
  })

  it('keeps a completed Task completed after main advances again', async () => {
    const { repository, worktree, history } = await fixture('ancestor-task')
    await agentCommit(worktree, 'maintainer: candidate', true)
    const approved = await gitOutput(['rev-parse', 'HEAD'], worktree.worktreePath)
    await runArtifactGit(['merge', '--quiet', '--ff-only', worktree.branchName], repository.rootPath)
    await writeFile(join(repository.rootPath, 'knowledge', 'later.md'), '# Later\n\nMain change.\n')
    await runArtifactGit(['add', '-A'], repository.rootPath)
    await runArtifactGit(['commit', '--quiet', '--no-gpg-sign', '-m', 'main: later'], repository.rootPath)
    await gitOutput(['rev-parse', 'HEAD'], repository.rootPath)

    await expect(history.read(worktree.taskId)).resolves.toMatchObject({
      status: 'completed',
      result: {
        approvedRepositoryRevision: approved,
        integratedRepositoryRevision: approved
      }
    })
  })

  it('lists each Task as open from its Host-owned Task-start commit', async () => {
    const pending = await fixture('pending-first-commit')
    const committed = await pending.tasks.createWorktree({
      taskId: 'committed-task',
      kind: 'task',
      taskDefinition: openRecord('committed-task'),
      plan: {
        files: [{ relativePath: 'inputs/activity.md', content: '# Activity\n' }],
        items: ['Inspect input.'],
      }
    })
    await expect(pending.history.read(pending.worktree.taskId)).resolves.toMatchObject({
      taskId: pending.worktree.taskId,
      status: 'open'
    })
    await expect(pending.history.list()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: committed.taskId, status: 'open' }),
      expect.objectContaining({ taskId: pending.worktree.taskId, status: 'open' })
    ]))
  })

  it('isolates malformed committed Tasks in list but reports direct reads', async () => {
    const { repository, tasks, worktree, history } = await fixture('malformed-task')
    await writeFile(join(worktree.taskPath, 'task.json'), '{not json}\n')
    await agentCommit(worktree, 'maintainer: malformed task')
    const valid = await tasks.createWorktree({
      taskId: 'valid-task',
      kind: 'task',
      taskDefinition: openRecord('valid-task'),
      plan: {
        files: [{ relativePath: 'inputs/activity.md', content: '# Activity\n' }],
        items: ['Inspect input.'],
      }
    })
    const deleted = await tasks.createWorktree({
      taskId: 'deleted-definition',
      kind: 'task',
      taskDefinition: openRecord('deleted-definition'),
      plan: {
        files: [{ relativePath: 'inputs/activity.md', content: '# Activity\n' }],
        items: ['Inspect input.'],
      }
    })
    await rm(join(deleted.taskPath, 'task.json'))
    await agentCommit(deleted, 'corrupt: delete definition')
    await runArtifactGit(['branch', 'task/invalid.name'], repository.rootPath)

    await expect(history.list()).resolves.toEqual([
      expect.objectContaining({ taskId: valid.taskId })
    ])
    await expect(history.read(worktree.taskId)).rejects.toBeInstanceOf(SyntaxError)
    await expect(history.read(deleted.taskId)).resolves.toBeUndefined()
  })

  it('excludes unrelated latest-main changes after main is merged into the Task', async () => {
    const { repository, worktree, history } = await fixture('merged-task')
    await writeFile(join(repository.rootPath, 'knowledge', 'unrelated.md'), '# Unrelated\n\nMain.\n')
    await runArtifactGit(['add', '-A'], repository.rootPath)
    await runArtifactGit(['commit', '--quiet', '--no-gpg-sign', '-m', 'main: unrelated'], repository.rootPath)
    await writeFile(join(worktree.worktreePath, 'knowledge', 'owned.md'), '# Owned\n\nTask.\n')
    await agentCommit(worktree, 'maintainer: owned')
    await runArtifactGit(['merge', '--quiet', '--no-edit', 'main'], worktree.worktreePath)
    await writeFile(join(worktree.worktreePath, 'knowledge', 'after-merge.md'), [
      '# After merge', '', 'Task follow-up.', ''
    ].join('\n'))
    await agentCommit(worktree, 'reviewer: verify merged tree')
    await runArtifactGit(['merge', '--quiet', '--ff-only', worktree.branchName], repository.rootPath)

    const record = await history.read(worktree.taskId)
    const changedPaths = record?.result?.changedPaths
    expect(changedPaths).toContain('knowledge/owned.md')
    expect(changedPaths).toContain('knowledge/after-merge.md')
    expect(changedPaths).not.toContain('knowledge/unrelated.md')
    expect(record?.result?.worktree.baseRepositoryRevision).toBe(worktree.baseRepositoryRevision)
  })

  it('reads old v2 task.json fields without rewriting them', async () => {
    const { worktree, history } = await fixture('legacy-v2')
    const path = join(worktree.taskPath, 'task.json')
    const legacy = {
      ...openRecord(worktree.taskId),
      formatVersion: 2,
      status: 'open',
      input: {
        sourceConversationId: 'source-conversation-1',
        sourceRevision: 'legacy-selection-revision'
      },
      sourceConversation: {
        ...openRecord(worktree.taskId).sourceConversation,
        sourceRevision: 'legacy-catalog-revision'
      },
      legacyFailure: 'old failure'
    }
    await writeFile(path, `${JSON.stringify(legacy)}\n`)
    await agentCommit(worktree, 'legacy: tracked record')

    const readModel = await history.read(worktree.taskId)
    expect(readModel).toMatchObject({
      taskId: worktree.taskId,
      status: 'open'
    })
    expect(readModel?.input).toEqual({ sourceConversationId: 'source-conversation-1' })
    expect(readModel?.sourceConversation).not.toHaveProperty('sourceRevision')
    await expect(readFile(path, 'utf8')).resolves.toContain('legacyFailure')
  })

  it('reads a completed pre-Git v1 record without rewriting it', async () => {
    const { repository, tasks, worktree } = await fixture('current-task')
    const taskId = 'legacy-v1'
    const taskPath = join(repository.tasksPath, taskId)
    const path = join(taskPath, 'task.json')
    await mkdir(taskPath, { recursive: true })
    const completedAt = '2026-08-11T00:00:02.000Z'
    const approvedRepositoryRevision = 'a'.repeat(40)
    const legacy = {
      formatVersion: 1,
      taskId,
      status: 'completed',
      startedAt: '2026-08-11T00:00:00.000Z',
      completedAt,
      input: {
        sourceConversationId: 'legacy-source',
        sourceRevision: 'legacy-revision'
      },
      configuration: {
        maintainer: {
          connectionId: 'legacy-connection',
          modelId: 'legacy-maintainer',
          instructions: 'Legacy instructions.'
        },
        reviewer: {
          connectionId: 'legacy-connection',
          modelId: 'legacy-reviewer',
          instructions: 'Legacy instructions.'
        }
      },
      result: {
        sourceConversation: {
          sourceConversationId: 'legacy-source',
          sourceId: 'source:codex',
          agentType: 'codex',
          sourceDisplayName: 'Codex',
          providerConversationId: 'legacy-provider-conversation',
          title: 'Legacy conversation',
          sizeBytes: 100,
          sourceRevision: 'legacy-catalog-revision'
        },
        sourceRef: 'raw:legacy@revision',
        approvedRepositoryRevision,
        changedPaths: ['knowledge/legacy.md'],
        workspace: {
          taskId,
          repositoryPath: repository.rootPath,
          workspacePath: taskPath,
          briefPath: join(taskPath, 'BRIEF.md'),
          progressPath: join(taskPath, 'PROGRESS.md'),
          inputPath: join(taskPath, 'inputs'),
          branchName: `knowledge-task/${taskId}`,
          targetBranch: 'main',
          baseRepositoryRevision: worktree.baseRepositoryRevision
        },
        durationMs: 2_000,
        completedAt
      }
    }
    await writeFile(path, `${JSON.stringify(legacy)}\n`, 'utf8')
    const history = new GitKnowledgeTaskHistory(repository, tasks)

    const readModel = await history.read(taskId)
    expect(readModel).toMatchObject({
      formatVersion: 3,
      status: 'completed',
      completedAt,
      result: {
        approvedRepositoryRevision,
        integratedRepositoryRevision: approvedRepositoryRevision,
        changedPaths: ['knowledge/legacy.md'],
        worktree: { taskPath }
      }
    })
    expect(readModel?.input).toEqual({ sourceConversationId: 'legacy-source' })
    expect(readModel?.sourceConversation).not.toHaveProperty('sourceRevision')
    expect(readModel?.result?.sourceConversation).not.toHaveProperty('sourceRevision')
    await expect(readFile(path, 'utf8')).resolves.toContain('"formatVersion":1')
  })
})

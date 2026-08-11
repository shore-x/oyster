import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ARTIFACT_GIT_BINARY_PATH,
  createArtifactGitEnvironment,
  runArtifactGit
} from '../src/main/artifacts/git-runtime'
import {
  KnowledgeTaskGitRepository,
  REVIEW_MARKER_COMMENT,
  REVIEW_MARKER_END,
  REVIEW_MARKER_START,
  type CreateKnowledgeTaskWorktreeInput,
  type KnowledgeTaskWorktree
} from '../src/main/knowledge-processing/knowledge-task-git-repository'
import type { KnowledgeTaskRecord } from '../src/shared/knowledge-processing'

const temporaryDirectories: string[] = []
const execFileAsync = promisify(execFile)

async function gitOutput(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(ARTIFACT_GIT_BINARY_PATH, args, {
    cwd,
    env: createArtifactGitEnvironment()
  })
  return stdout.trimEnd()
}

function record(taskId: string): KnowledgeTaskRecord {
  return {
    formatVersion: 2,
    taskId,
    status: 'open',
    startedAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
    durationMs: 0,
    input: { sourceConversationId: 'source-1', sourceRevision: 'revision-1' },
    configuration: {
      maintainer: { connectionId: 'connection', modelId: 'model', instructions: 'Maintain.' },
      reviewer: { connectionId: 'connection', modelId: 'model', instructions: 'Review.' }
    },
    agentInvocations: []
  }
}

function input(taskId: string): CreateKnowledgeTaskWorktreeInput {
  return {
    taskId,
    kind: 'task',
    sourceRef: 'raw:source@revision',
    taskRecord: record(taskId),
    plan: {
      files: [{ relativePath: 'inputs/README.md', content: '# Inputs\n' }],
      items: ['Inspect.'],
      activitySegmentCount: 1,
      activityPageCount: 1,
      evidencePageCount: 1,
      attachmentCount: 0,
      canonicalActivityFormat: 'test-activity-v1',
      rawEvidenceFormat: 'test-raw-v1',
      activityCount: 1,
      rawEvidenceLineCount: 1
    }
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'oyster-task-worktree-'))
  temporaryDirectories.push(root)
  const repositoryPath = join(root, 'repository')
  const repository = new KnowledgeTaskGitRepository(repositoryPath)
  await repository.initialize()
  return { root, repositoryPath, repository }
}

async function completeProgress(worktree: KnowledgeTaskWorktree): Promise<void> {
  await writeFile(
    worktree.progressPath,
    (await readFile(worktree.progressPath, 'utf8')).replaceAll('- [ ]', '- [x]'),
    'utf8'
  )
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => rm(directory, { recursive: true, force: true })
  ))
})

describe('KnowledgeTaskGitRepository', () => {
  it('creates a tracked Task start commit in an external linked worktree', async () => {
    const { root, repositoryPath, repository } = await fixture()
    const mainRevision = await repository.currentRevision()
    const worktree = await repository.createWorktree(input('tracked-task'))

    expect(worktree.repositoryPath).toBe(repositoryPath)
    expect(worktree.worktreePath).toBe(join(root, 'worktrees', 'tracked-task'))
    expect(worktree.runtimePath).toBe(join(root, 'agent-runtime', 'tracked-task'))
    expect(worktree.taskPath).toBe(join(
      root, 'worktrees', 'tracked-task', 'tasks', 'tracked-task'
    ))
    expect(worktree.branchName).toBe('task/tracked-task')
    expect(worktree.baseRepositoryRevision).toBe(mainRevision)
    expect(worktree.taskStartRepositoryRevision).not.toBe(mainRevision)
    expect(await repository.currentRevision()).toBe(mainRevision)
    expect(await gitOutput([
      'show', 'task/tracked-task:tasks/tracked-task/BRIEF.md'
    ], repositoryPath)).toContain('Knowledge Processing Task tracked-task')
    expect(await gitOutput([
      'show', 'task/tracked-task:tasks/tracked-task/task.json'
    ], repositoryPath)).toContain('"status": "open"')
  })

  it('does not absorb or modify uncommitted changes in the user main checkout', async () => {
    const { repositoryPath, repository } = await fixture()
    await writeFile(join(repositoryPath, 'knowledge', 'user-edit.md'), '# User edit\n\nDraft.\n')
    await writeFile(join(repositoryPath, 'notes.txt'), 'User notes.\n')

    const worktree = await repository.createWorktree(input('isolated-task'))

    await expect(readFile(join(worktree.worktreePath, 'knowledge', 'user-edit.md'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(repositoryPath, 'notes.txt'), 'utf8')).toBe('User notes.\n')
    expect(await gitOutput(['status', '--short'], repositoryPath))
      .toContain('knowledge/user-edit.md')
  })

  it('supports multiple Task branches and worktrees at the same time', async () => {
    const { repository } = await fixture()
    const first = await repository.createWorktree(input('parallel-a'))
    const second = await repository.createWorktree(input('parallel-b'))

    expect(first.worktreePath).not.toBe(second.worktreePath)
    await writeFile(join(first.worktreePath, 'knowledge', 'a.md'), '# A\n\nFirst.\n')
    await writeFile(join(second.worktreePath, 'knowledge', 'b.md'), '# B\n\nSecond.\n')
    await Promise.all([completeProgress(first), completeProgress(second)])
    const [a, b] = await Promise.all([
      repository.checkpointMaintainer(first, first.taskStartRepositoryRevision, 'session-a'),
      repository.checkpointMaintainer(second, second.taskStartRepositoryRevision, 'session-b')
    ])
    expect(a.changedPaths).toContain('knowledge/a.md')
    expect(b.changedPaths).toContain('knowledge/b.md')
  })

  it('preserves dirty Task-worktree changes as a pre-Agent checkpoint', async () => {
    const { repository } = await fixture()
    const worktree = await repository.createWorktree(input('recoverable-task'))
    await writeFile(join(worktree.worktreePath, 'knowledge', 'manual.md'), '# Manual\n\nEdit.\n')

    const actualRevision = await repository.prepareAgentTurn(
      worktree,
      worktree.taskStartRepositoryRevision
    )

    expect(actualRevision).not.toBe(worktree.taskStartRepositoryRevision)
    expect(await gitOutput(['status', '--short'], worktree.worktreePath)).toBe('')
    expect(await gitOutput(['show', '--name-only', '--format=', actualRevision], worktree.worktreePath))
      .toContain('knowledge/manual.md')
  })

  it('allows Task files and Pi sessions without a root allowlist', async () => {
    const { repository } = await fixture()
    const worktree = await repository.createWorktree(input('session-task'))
    await mkdir(join(worktree.taskPath, 'pi-sessions'), { recursive: true })
    await writeFile(join(worktree.taskPath, 'pi-sessions', 'session.jsonl'), '{}\n')
    await writeFile(join(worktree.taskPath, 'notes.md'), '# Agent note\n')
    await completeProgress(worktree)

    const handoff = await repository.checkpointMaintainer(
      worktree,
      worktree.taskStartRepositoryRevision,
      'session-1'
    )

    expect(handoff.changedPaths).toEqual(expect.arrayContaining([
      'tasks/session-task/PROGRESS.md',
      'tasks/session-task/notes.md',
      'tasks/session-task/pi-sessions/session.jsonl'
    ]))
  })

  it('records Reviewer approval as a non-empty Task commit', async () => {
    const { repository } = await fixture()
    const worktree = await repository.createWorktree(input('approved-task'))
    await completeProgress(worktree)
    const maintained = await repository.checkpointMaintainer(
      worktree,
      worktree.taskStartRepositoryRevision,
      'maintainer-session'
    )

    const decision = await repository.checkpointReview(
      worktree,
      maintained.candidateRepositoryRevision,
      'reviewer-session'
    )

    expect(decision).toMatchObject({ kind: 'approved' })
    expect(decision.candidateRepositoryRevision).not.toBe(maintained.candidateRepositoryRevision)
    await expect(readFile(worktree.progressPath, 'utf8'))
      .resolves.toContain('Reviewer session reviewer-session approved the candidate')
  })

  it('records Reviewer feedback without enforcing an exact commit shape', async () => {
    const { repository } = await fixture()
    const worktree = await repository.createWorktree(input('review-task'))
    await completeProgress(worktree)
    await writeFile(join(worktree.worktreePath, 'knowledge', 'subject.md'), '# Subject\n\nBody.\n')
    const maintained = await repository.checkpointMaintainer(
      worktree,
      worktree.taskStartRepositoryRevision
    )
    await writeFile(join(worktree.worktreePath, 'knowledge', 'subject.md'), [
      REVIEW_MARKER_START,
      '# Subject',
      '',
      'Body.',
      REVIEW_MARKER_COMMENT,
      'Explain the boundary.',
      REVIEW_MARKER_END,
      ''
    ].join('\n'))
    await writeFile(
      worktree.progressPath,
      `${await readFile(worktree.progressPath, 'utf8')}\n- [ ] Resolve Reviewer feedback.\n`
    )

    const decision = await repository.checkpointReview(
      worktree,
      maintained.candidateRepositoryRevision
    )

    expect(decision).toMatchObject({
      kind: 'changes_requested',
      markerPaths: ['knowledge/subject.md']
    })
  })

  it('removes the legacy tasks ignore only on the Task branch', async () => {
    const { repositoryPath, repository } = await fixture()
    await writeFile(join(repositoryPath, '.gitignore'), '/tasks/\nkeep-me\n')
    await runArtifactGit(['add', '--', '.gitignore'], repositoryPath)
    await runArtifactGit(['commit', '--quiet', '--no-gpg-sign', '-m', 'legacy ignore'], repositoryPath)

    const worktree = await repository.createWorktree(input('ignore-migration'))

    expect(await readFile(join(worktree.worktreePath, '.gitignore'), 'utf8')).toBe('keep-me\n')
    expect(await readFile(join(repositoryPath, '.gitignore'), 'utf8')).toBe('/tasks/\nkeep-me\n')
    expect(await gitOutput([
      'show', 'task/ignore-migration:tasks/ignore-migration/task.json'
    ], repositoryPath)).toContain('ignore-migration')
  })
})

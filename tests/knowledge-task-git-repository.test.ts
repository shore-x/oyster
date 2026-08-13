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
import {
  KnowledgeTaskGitRepository,
  REVIEW_MARKER_COMMENT,
  REVIEW_MARKER_END,
  REVIEW_MARKER_START,
  TASK_FILE_NAME,
  type CreateKnowledgeTaskWorktreeInput,
  type KnowledgeTaskWorktree
} from '../src/main/knowledge-processing/knowledge-task-git-repository'
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

function record(taskId: string): KnowledgeTaskDefinition {
  return {
    formatVersion: 3,
    taskId,
    startedAt: '2026-08-11T00:00:00.000Z',
    input: { sourceConversationId: 'source-1' },
    sourceRef: 'raw:source@revision',
    configuration: {
      maintainer: { connectionId: 'connection', modelId: 'model' },
      reviewer: { connectionId: 'connection', modelId: 'model' }
    }
  }
}

function input(taskId: string): CreateKnowledgeTaskWorktreeInput {
  return {
    taskId,
    kind: 'task',
    taskDefinition: record(taskId),
    plan: {
      files: [{ relativePath: 'inputs/activity.md', content: '# Activity\n' }],
      items: ['Inspect.'],
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

async function agentCommit(worktree: KnowledgeTaskWorktree, message: string): Promise<string> {
  await runArtifactGit(['add', '-A'], worktree.worktreePath)
  await runArtifactGit(['commit', '--quiet', '--no-gpg-sign', '-m', message], worktree.worktreePath)
  return gitOutput(['rev-parse', 'HEAD'], worktree.worktreePath)
}

function taskFile(worktree: KnowledgeTaskWorktree): string {
  return join(worktree.taskPath, TASK_FILE_NAME)
}

async function completeTask(worktree: KnowledgeTaskWorktree): Promise<void> {
  const path = taskFile(worktree)
  await writeFile(
    path,
    (await readFile(path, 'utf8')).replaceAll('- [ ]', '- [x]'),
    'utf8'
  )
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => rm(directory, { recursive: true, force: true })
  ))
})

describe('KnowledgeTaskGitRepository', () => {
  it('creates a clean Host-owned Task-start commit without advancing main', async () => {
    const { repositoryPath, repository } = await fixture()
    const base = await repository.currentRevision()
    const worktree = await repository.createWorktree(input('agent-owned-start'))
    const start = await gitOutput(['rev-parse', 'HEAD'], worktree.worktreePath)

    expect(start).toBe(worktree.baseRepositoryRevision)
    expect(start).not.toBe(base)
    expect(await gitOutput(['rev-parse', `${start}^`], worktree.worktreePath)).toBe(base)
    expect(await gitOutput(['status', '--short'], worktree.worktreePath)).toBe('')
    expect((await gitOutput([
      'diff-tree', '--no-commit-id', '--name-only', '-r', start
    ], worktree.worktreePath)).split('\n').filter(Boolean)).toEqual([
      'tasks/agent-owned-start/TASK.md',
      'tasks/agent-owned-start/inputs/activity.md',
      'tasks/agent-owned-start/task.json'
    ])
    const stored = JSON.parse(await readFile(join(worktree.taskPath, 'task.json'), 'utf8'))
    expect(stored).toMatchObject({
      formatVersion: 3,
      taskId: 'agent-owned-start',
      sourceRef: 'raw:source@revision'
    })
    expect(stored).not.toHaveProperty('status')
    expect(stored).not.toHaveProperty('result')
    expect(stored).not.toHaveProperty('agentInvocations')
    const task = await readFile(taskFile(worktree), 'utf8')
    expect(task).toContain('# Task\n\n## Checklist')
    expect(task).toContain('## Knowledge–Evidence')
    expect(task).toContain('## Handoffs')
    expect(task).not.toContain('Completion contract')
    expect(task).not.toContain(repositoryPath)
    expect(await repository.prepareAgentTurn(worktree, start)).toBe(start)
    expect(await repository.currentRevision()).toBe(base)
    expect(await gitOutput(['status', '--short'], repositoryPath)).toBe('')
  })

  it('validates a clean Maintainer commit and derives all Task changed paths', async () => {
    const { repository } = await fixture()
    const worktree = await repository.createWorktree(input('maintained-task'))
    await completeTask(worktree)
    await writeFile(join(worktree.worktreePath, 'knowledge', 'subject.md'), '# Subject\n\nBody.\n')
    const revision = await agentCommit(worktree, 'maintainer: create subject')

    await expect(repository.inspectAgentCommit(
      worktree,
      worktree.baseRepositoryRevision
    )).resolves.toMatchObject({
      previousRepositoryRevision: worktree.baseRepositoryRevision,
      candidateRepositoryRevision: revision,
      changedPaths: expect.arrayContaining([
        'knowledge/subject.md',
        'tasks/maintained-task/TASK.md'
      ])
    })
    await expect(repository.taskChangedPaths(worktree.taskId, revision))
      .resolves.toContain('knowledge/subject.md')
  })

  it('derives Task changed paths across repeated main merges and later Task commits', async () => {
    const { repositoryPath, repository } = await fixture()
    const worktree = await repository.createWorktree(input('repeated-main-merges'))
    await completeTask(worktree)
    await writeFile(
      join(worktree.worktreePath, 'knowledge', 'before-merges.md'),
      '# Before merges\n\nTask-owned.\n'
    )
    await agentCommit(worktree, 'maintainer: change before merges')

    await writeFile(join(repositoryPath, 'knowledge', 'main-only-first.md'), '# Main first\n\nMain.\n')
    await runArtifactGit(['add', '-A'], repositoryPath)
    await runArtifactGit([
      'commit', '--quiet', '--no-gpg-sign', '-m', 'main: first unrelated change'
    ], repositoryPath)
    await runArtifactGit(['merge', '--quiet', '--no-edit', 'main'], worktree.worktreePath)
    await writeFile(
      join(worktree.worktreePath, 'knowledge', 'between-merges.md'),
      '# Between merges\n\nTask-owned.\n'
    )
    await agentCommit(worktree, 'maintainer: change between merges')

    await writeFile(join(repositoryPath, 'knowledge', 'main-only-second.md'), '# Main second\n\nMain.\n')
    await runArtifactGit(['add', '-A'], repositoryPath)
    await runArtifactGit([
      'commit', '--quiet', '--no-gpg-sign', '-m', 'main: second unrelated change'
    ], repositoryPath)
    await runArtifactGit(['merge', '--quiet', '--no-edit', 'main'], worktree.worktreePath)
    await writeFile(
      join(worktree.worktreePath, 'knowledge', 'after-merges.md'),
      '# After merges\n\nTask-owned.\n'
    )
    const revision = await agentCommit(worktree, 'reviewer: change after merges')

    const changedPaths = await repository.taskChangedPaths(worktree.taskId, revision)
    expect(changedPaths).toEqual(expect.arrayContaining([
      'knowledge/before-merges.md',
      'knowledge/between-merges.md',
      'knowledge/after-merges.md'
    ]))
    expect(changedPaths).not.toEqual(expect.arrayContaining([
      'knowledge/main-only-first.md',
      'knowledge/main-only-second.md'
    ]))
  })

  it('counts a same-path conflict resolution when the merge commit is the final Task tip', async () => {
    const { repositoryPath, repository } = await fixture()
    await writeFile(join(repositoryPath, 'knowledge', 'shared.md'), '# Shared\n\nInitial.\n')
    await runArtifactGit(['add', '-A'], repositoryPath)
    await runArtifactGit([
      'commit', '--quiet', '--no-gpg-sign', '-m', 'main: add shared knowledge'
    ], repositoryPath)
    const worktree = await repository.createWorktree(input('conflict-resolution'))
    await completeTask(worktree)
    await writeFile(
      join(worktree.worktreePath, 'knowledge', 'shared.md'),
      '# Shared\n\nTask interpretation.\n'
    )
    const reviewed = await agentCommit(worktree, 'maintainer: revise shared knowledge')

    await writeFile(join(repositoryPath, 'knowledge', 'shared.md'), '# Shared\n\nMain update.\n')
    await runArtifactGit(['add', '-A'], repositoryPath)
    await runArtifactGit([
      'commit', '--quiet', '--no-gpg-sign', '-m', 'main: revise shared knowledge'
    ], repositoryPath)
    const latestMain = await repository.currentRevision()
    await expect(runArtifactGit(
      ['merge', '--quiet', '--no-edit', 'main'],
      worktree.worktreePath
    )).rejects.toThrow()
    await writeFile(
      join(worktree.worktreePath, 'knowledge', 'shared.md'),
      '# Shared\n\nResolved Task and main interpretation.\n'
    )
    const mergeTip = await agentCommit(worktree, 'reviewer: resolve main conflict')

    expect(await gitOutput(['rev-parse', 'HEAD'], worktree.worktreePath)).toBe(mergeTip)
    expect((await gitOutput(['show', '-s', '--format=%P', mergeTip], worktree.worktreePath)).split(' '))
      .toEqual([reviewed, latestMain])
    await expect(repository.taskChangedPaths(worktree.taskId, mergeTip))
      .resolves.toContain('knowledge/shared.md')
  })

  it('rejects fixed input changes before the next Agent reads them', async () => {
    const { repository } = await fixture()
    const worktree = await repository.createWorktree(input('dirty-fixed-input'))
    await writeFile(join(worktree.inputPath, 'activity.md'), '# Rewritten inputs\n')

    await expect(repository.prepareAgentTurn(
      worktree,
      worktree.baseRepositoryRevision
    )).rejects.toThrow('固定的输入不得修改')
  })

  it('rejects a fixed-input change after merging the latest main', async () => {
    const { repositoryPath, repository } = await fixture()
    const worktree = await repository.createWorktree(input('merged-fixed-input'))
    await completeTask(worktree)
    await writeFile(join(worktree.worktreePath, 'knowledge', 'subject.md'), '# Subject\n\nBody.\n')
    await agentCommit(worktree, 'maintainer: candidate')
    await writeFile(join(worktree.inputPath, 'activity.md'), '# Rewritten inputs\n')
    await agentCommit(worktree, 'maintainer: rewrite fixed input')
    await writeFile(join(repositoryPath, 'knowledge', 'main.md'), '# Main\n\nAdvanced.\n')
    await runArtifactGit(['add', '-A'], repositoryPath)
    await runArtifactGit([
      'commit', '--quiet', '--no-gpg-sign', '-m', 'main: advance'
    ], repositoryPath)
    await runArtifactGit(['merge', '--quiet', '--no-edit', 'main'], worktree.worktreePath)
    const revision = await gitOutput(['rev-parse', 'HEAD'], worktree.worktreePath)

    await expect(repository.prepareAgentTurn(
      worktree,
      revision
    )).rejects.toThrow('Task-start commit 固定的输入')
    await expect(repository.taskStartRevision(worktree.taskId, revision))
      .resolves.toBe(worktree.baseRepositoryRevision)
  })

  it('rejects rewritten Task history even when fixed input content still matches', async () => {
    const { repositoryPath, repository } = await fixture()
    const worktree = await repository.createWorktree(input('rewritten-history'))
    await completeTask(worktree)
    await writeFile(join(worktree.worktreePath, 'knowledge', 'subject.md'), '# Subject\n\nBody.\n')
    await agentCommit(worktree, 'maintainer: candidate')
    await writeFile(join(repositoryPath, 'knowledge', 'main.md'), '# Main\n\nAdvanced.\n')
    await runArtifactGit(['add', '-A'], repositoryPath)
    await runArtifactGit([
      'commit', '--quiet', '--no-gpg-sign', '-m', 'main: advance'
    ], repositoryPath)
    await runArtifactGit(['rebase', 'main'], worktree.worktreePath)
    const revision = await gitOutput(['rev-parse', 'HEAD'], worktree.worktreePath)

    await expect(repository.prepareAgentTurn(worktree, revision))
      .rejects.toThrow('不得改写 Host 创建的 Task-start commit')
  })

  it('rejects fixed-input mutations hidden in a restored second-parent history', async () => {
    const { repository } = await fixture()
    const worktree = await repository.createWorktree(input('hidden-fixed-input'))
    const start = worktree.baseRepositoryRevision
    const originalInput = await readFile(join(worktree.inputPath, 'activity.md'), 'utf8')

    await runArtifactGit([
      'checkout', '--quiet', '-b', 'hidden-fixed-input-side', start
    ], worktree.worktreePath)
    await writeFile(join(worktree.inputPath, 'activity.md'), '# Mutated inputs\n')
    const mutation = await agentCommit(worktree, 'mutate fixed input on hidden side')
    await runArtifactGit([
      'checkout', '--quiet', worktree.branchName
    ], worktree.worktreePath)
    await runArtifactGit([
      'merge', '--quiet', '--no-ff', '--strategy=ours', '-m',
      'merge hidden fixed-input mutation while restoring the Task tree',
      'hidden-fixed-input-side'
    ], worktree.worktreePath)
    const revision = await gitOutput(['rev-parse', 'HEAD'], worktree.worktreePath)

    expect(await readFile(join(worktree.inputPath, 'activity.md'), 'utf8')).toBe(originalInput)
    expect(await gitOutput([
      'diff', '--name-only', start, revision, '--',
      `tasks/${worktree.taskId}/inputs`,
      `tasks/${worktree.taskId}/task.json`
    ], worktree.worktreePath)).toBe('')
    expect((await gitOutput([
      'show', '-s', '--format=%P', revision
    ], worktree.worktreePath)).split(' ')).toContain(mutation)
    await expect(repository.prepareAgentTurn(worktree, revision))
      .rejects.toThrow('Task-start commit 固定的输入')
  })

  it('rejects fixed-input mutations introduced from a branch beside Task-start', async () => {
    const { repository } = await fixture()
    const worktree = await repository.createWorktree(input('off-path-fixed-input'))
    const start = worktree.baseRepositoryRevision

    await runArtifactGit([
      'checkout', '--quiet', '-b', 'off-path-fixed-input-side', `${start}^`
    ], worktree.worktreePath)
    await mkdir(worktree.inputPath, { recursive: true })
    await writeFile(join(worktree.inputPath, 'activity.md'), '# Mutated beside Task-start\n')
    await agentCommit(worktree, 'add alternate fixed input beside Task-start')
    await runArtifactGit([
      'checkout', '--quiet', worktree.branchName
    ], worktree.worktreePath)
    await runArtifactGit([
      'merge', '--quiet', '--no-ff', '--strategy=ours', '-m',
      'merge off-path fixed-input mutation while preserving the Task tree',
      'off-path-fixed-input-side'
    ], worktree.worktreePath)
    const revision = await gitOutput(['rev-parse', 'HEAD'], worktree.worktreePath)

    await expect(repository.prepareAgentTurn(worktree, revision))
      .rejects.toThrow('Task-start commit 固定的输入')
  })

  it('validates preview commits without requiring a tracked task definition', async () => {
    const { repository } = await fixture()
    const preview = await repository.createWorktree({
      ...input('preview-task'),
      kind: 'preview',
      taskDefinition: undefined
    })
    const previewTask = await readFile(taskFile(preview), 'utf8')
    expect(previewTask).toContain('# Task\n\n## Checklist')
    expect(previewTask).toContain('## Knowledge–Evidence')
    await expect(readFile(join(preview.taskPath, 'task.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await completeTask(preview)
    await writeFile(join(preview.worktreePath, 'knowledge', 'preview.md'), '# Preview\n\nBody.\n')
    const revision = await agentCommit(preview, 'preview: candidate')

    await expect(repository.inspectAgentCommit(
      preview,
      preview.baseRepositoryRevision
    )).resolves.toMatchObject({ candidateRepositoryRevision: revision })
  })

  it('rejects a Preview carrying a formal Task definition', async () => {
    const { repository } = await fixture()

    await expect(repository.createWorktree({
      ...input('preview-with-definition'),
      kind: 'preview'
    })).rejects.toThrow('Agent Preview 不得包含 Knowledge Processing Task 定义')
  })

  it('rejects dirty, unchanged, or fixed-input-mutating Agent handoffs', async () => {
    const { repository } = await fixture()
    const dirty = await repository.createWorktree(input('dirty-task'))
    await writeFile(taskFile(dirty), `${await readFile(taskFile(dirty), 'utf8')}\nDirty.\n`)
    await expect(repository.inspectAgentCommit(dirty, dirty.baseRepositoryRevision))
      .rejects.toThrow('必须提交')

    const unchanged = await repository.createWorktree(input('unchanged-task'))
    const head = await gitOutput(['rev-parse', 'HEAD'], unchanged.worktreePath)
    await expect(repository.inspectAgentCommit(unchanged, head)).rejects.toThrow('没有创建新的')

    const mutated = await repository.createWorktree(input('mutated-task'))
    const taskJson = JSON.parse(await readFile(join(mutated.taskPath, 'task.json'), 'utf8'))
    taskJson.sourceRef = 'mutated'
    await writeFile(join(mutated.taskPath, 'task.json'), `${JSON.stringify(taskJson)}\n`)
    await agentCommit(mutated, 'maintainer: mutate reserved summary')
    await expect(repository.inspectAgentCommit(mutated, mutated.baseRepositoryRevision))
      .rejects.toThrow('不得修改')

    const rewritten = await repository.createWorktree(input('rewritten-task'))
    const original = await readFile(join(rewritten.taskPath, 'task.json'), 'utf8')
    await runArtifactGit(['rm', '--quiet', '--', 'tasks/rewritten-task/task.json'], rewritten.worktreePath)
    await runArtifactGit([
      'commit', '--quiet', '--no-gpg-sign', '-m', 'maintainer: remove fixed Task definition'
    ], rewritten.worktreePath)
    await writeFile(join(rewritten.taskPath, 'task.json'), original)
    await agentCommit(rewritten, 'maintainer: restore fixed Task definition')
    await expect(repository.inspectAgentCommit(rewritten, rewritten.baseRepositoryRevision))
      .rejects.toThrow('不得修改')
  })

  it('requires a changes-requested Reviewer to commit its feedback', async () => {
    const { repository } = await fixture()
    const worktree = await repository.createWorktree(input('review-task'))
    await completeTask(worktree)
    await writeFile(join(worktree.worktreePath, 'knowledge', 'subject.md'), '# Subject\n\nBody.\n')
    const reviewed = await agentCommit(worktree, 'maintainer: candidate')
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
      taskFile(worktree),
      `${await readFile(taskFile(worktree), 'utf8')}\n- [ ] Resolve feedback.\n`
    )
    await agentCommit(worktree, 'reviewer: request changes')

    await expect(repository.inspectReview(
      worktree,
      reviewed,
      await repository.currentRevision()
    )).resolves.toMatchObject({
      kind: 'changes_requested',
      reviewedRepositoryRevision: reviewed,
      markerPaths: ['knowledge/subject.md']
    })
  })

  it('approves only after Agent fast-forward promotion synchronizes main HEAD and index', async () => {
    const { repositoryPath, repository } = await fixture()
    const worktree = await repository.createWorktree(input('approved-task'))
    const taskStart = worktree.baseRepositoryRevision
    await completeTask(worktree)
    await writeFile(join(worktree.worktreePath, 'knowledge', 'approved.md'), '# Approved\n\nBody.\n')
    const reviewed = await agentCommit(worktree, 'maintainer: approved candidate')

    await writeFile(join(repositoryPath, 'knowledge', 'main-before-approval.md'), [
      '# Main before approval', '', 'Unrelated main change.', ''
    ].join('\n'))
    await runArtifactGit(['add', '-A'], repositoryPath)
    await runArtifactGit([
      'commit', '--quiet', '--no-gpg-sign', '-m', 'main: advance before approval'
    ], repositoryPath)
    const targetRevisionBeforeReview = await repository.currentRevision()
    await runArtifactGit(['merge', '--quiet', '--no-edit', 'main'], worktree.worktreePath)
    const finalTip = await gitOutput(['rev-parse', 'HEAD'], worktree.worktreePath)

    expect(finalTip).not.toBe(reviewed)
    await expect(repository.taskStartRevision(worktree.taskId, finalTip)).resolves.toBe(taskStart)
    await expect(gitOutput([
      'merge-base', '--is-ancestor', reviewed, finalTip
    ], worktree.worktreePath)).resolves.toBe('')

    await expect(repository.inspectReview(worktree, reviewed, targetRevisionBeforeReview))
      .rejects.toThrow('快进合并')

    await runArtifactGit(['merge', '--quiet', '--ff-only', worktree.branchName], repositoryPath)
    expect(await repository.currentRevision()).toBe(finalTip)
    expect(await gitOutput(['rev-parse', 'HEAD'], repositoryPath)).toBe(finalTip)
    await expect(repository.inspectReview(
      worktree,
      reviewed,
      targetRevisionBeforeReview
    )).resolves.toEqual({
      kind: 'approved',
      reviewedRepositoryRevision: reviewed,
      candidateRepositoryRevision: finalTip,
      integratedRepositoryRevision: finalTip
    })
    await expect(readFile(join(repositoryPath, 'knowledge', 'approved.md'), 'utf8'))
      .resolves.toContain('Body')
  })

  it('rejects a non-fast-forward merge of the Task branch into main', async () => {
    const { repositoryPath, repository } = await fixture()
    const worktree = await repository.createWorktree(input('non-fast-forward-promotion'))
    await completeTask(worktree)
    await writeFile(join(worktree.worktreePath, 'knowledge', 'approved.md'), '# Approved\n\nBody.\n')
    const reviewed = await agentCommit(worktree, 'maintainer: approved candidate')

    await writeFile(join(repositoryPath, 'knowledge', 'main-only.md'), '# Main only\n\nMain.\n')
    await runArtifactGit(['add', '-A'], repositoryPath)
    await runArtifactGit([
      'commit', '--quiet', '--no-gpg-sign', '-m', 'main: advance before promotion'
    ], repositoryPath)
    const targetRevisionBeforeReview = await repository.currentRevision()
    await runArtifactGit([
      'merge', '--quiet', '--no-edit', 'main'
    ], worktree.worktreePath)
    await runArtifactGit([
      'merge', '--quiet', '--no-ff', '--no-edit', worktree.branchName
    ], repositoryPath)

    await expect(repository.inspectReview(worktree, reviewed, targetRevisionBeforeReview))
      .rejects.toThrow('精确 Task revision 快进')
  })

  it('rejects promotion that discards the main revision present when review began', async () => {
    const { repositoryPath, repository } = await fixture()
    const worktree = await repository.createWorktree(input('discarded-review-target'))
    await completeTask(worktree)
    await writeFile(join(worktree.worktreePath, 'knowledge', 'approved.md'), '# Approved\n\nBody.\n')
    const reviewed = await agentCommit(worktree, 'maintainer: approved candidate')

    await writeFile(join(repositoryPath, 'knowledge', 'review-target.md'), [
      '# Review target', '', 'This main revision existed when review began.', ''
    ].join('\n'))
    await runArtifactGit(['add', '-A'], repositoryPath)
    await runArtifactGit([
      'commit', '--quiet', '--no-gpg-sign', '-m', 'main: revision visible at review start'
    ], repositoryPath)
    const expectedTargetRevision = await repository.currentRevision()
    await runArtifactGit(['reset', '--hard', reviewed], repositoryPath)

    await expect(repository.inspectReview(
      worktree,
      reviewed,
      expectedTargetRevision
    )).rejects.toThrow('审阅开始时的目标分支 revision')
  })

  it('rejects approval when the Reviewer replaces the reviewed Task history', async () => {
    const { repositoryPath, repository } = await fixture()
    const worktree = await repository.createWorktree(input('replaced-review-history'))
    await completeTask(worktree)
    await writeFile(join(worktree.worktreePath, 'knowledge', 'approved.md'), '# Approved\n\nBody.\n')
    const reviewed = await agentCommit(worktree, 'maintainer: reviewed candidate')
    const tree = await gitOutput(['rev-parse', `${reviewed}^{tree}`], worktree.worktreePath)
    const replacement = await gitOutput([
      'commit-tree', tree, '-p', worktree.baseRepositoryRevision,
      '-m', 'reviewer: replace reviewed history'
    ], worktree.worktreePath)
    const targetRevisionBeforeReview = await repository.currentRevision()
    await runArtifactGit([
      'update-ref', `refs/heads/${worktree.branchName}`, replacement, reviewed
    ], worktree.worktreePath)
    await runArtifactGit(['merge', '--quiet', '--ff-only', worktree.branchName], repositoryPath)

    await expect(repository.inspectReview(worktree, reviewed, targetRevisionBeforeReview))
      .rejects.toThrow('必须保留已审阅的 Task revision')
  })

  it('rejects a reverse merge that places main on the Task first-parent history', async () => {
    const { repositoryPath, repository } = await fixture()
    const worktree = await repository.createWorktree(input('reverse-review-merge'))
    await completeTask(worktree)
    await writeFile(join(worktree.worktreePath, 'knowledge', 'reviewed.md'), '# Reviewed\n\nTask.\n')
    const reviewed = await agentCommit(worktree, 'maintainer: reviewed candidate')

    await writeFile(join(repositoryPath, 'knowledge', 'main.md'), '# Main\n\nTarget.\n')
    await runArtifactGit(['add', '-A'], repositoryPath)
    await runArtifactGit([
      'commit', '--quiet', '--no-gpg-sign', '-m', 'main: advance before reverse merge'
    ], repositoryPath)
    const targetRevisionBeforeReview = await repository.currentRevision()
    await runArtifactGit(['reset', '--hard', 'main'], worktree.worktreePath)
    await runArtifactGit([
      'merge', '--quiet', '--no-ff', '--no-edit', reviewed
    ], worktree.worktreePath)
    await runArtifactGit(['merge', '--quiet', '--ff-only', worktree.branchName], repositoryPath)

    await expect(repository.inspectReview(
      worktree,
      reviewed,
      targetRevisionBeforeReview
    )).rejects.toThrow('Task first-parent 历史')
  })

  it('rejects promotion while the main checkout contains uncommitted user changes', async () => {
    const { repositoryPath, repository } = await fixture()
    const worktree = await repository.createWorktree(input('dirty-main-promotion'))
    await completeTask(worktree)
    const reviewed = await agentCommit(worktree, 'maintainer: approved candidate')
    const targetRevisionBeforeReview = await repository.currentRevision()
    await writeFile(join(repositoryPath, 'user-note.txt'), 'untracked user content\n')

    await runArtifactGit(['merge', '--quiet', '--ff-only', worktree.branchName], repositoryPath)
    await expect(repository.inspectReview(worktree, reviewed, targetRevisionBeforeReview))
      .rejects.toThrow('同步且 clean')
    await expect(readFile(join(repositoryPath, 'user-note.txt'), 'utf8'))
      .resolves.toContain('untracked user content')
  })

  it('ignores REVIEW marker bytes in binary Artifact files', async () => {
    const { repositoryPath, repository } = await fixture()
    const worktree = await repository.createWorktree(input('binary-artifact'))
    await completeTask(worktree)
    await writeFile(
      join(worktree.worktreePath, 'artifacts', 'binary.dat'),
      Buffer.concat([
        Buffer.from([0, 1, 2, 3]),
        Buffer.from(REVIEW_MARKER_START),
        Buffer.from([0, 4, 5])
      ])
    )
    const reviewed = await agentCommit(worktree, 'maintainer: binary Artifact')
    const targetRevisionBeforeReview = await repository.currentRevision()
    await runArtifactGit(['merge', '--quiet', '--ff-only', worktree.branchName], repositoryPath)

    await expect(repository.inspectReview(
      worktree,
      reviewed,
      targetRevisionBeforeReview
    )).resolves.toMatchObject({
      kind: 'approved',
      integratedRepositoryRevision: reviewed
    })
  })

  it('rejects approval when main advances beyond the exact Task revision before inspection', async () => {
    const { repositoryPath, repository } = await fixture()
    const worktree = await repository.createWorktree(input('advanced-main'))
    await completeTask(worktree)
    const reviewed = await agentCommit(worktree, 'maintainer: approved candidate')
    const targetRevisionBeforeReview = await repository.currentRevision()
    await runArtifactGit(['merge', '--quiet', '--ff-only', worktree.branchName], repositoryPath)
    await writeFile(join(repositoryPath, 'knowledge', 'later.md'), '# Later\n\nMain change.\n')
    await runArtifactGit(['add', '-A'], repositoryPath)
    await runArtifactGit(['commit', '--quiet', '--no-gpg-sign', '-m', 'main: later'], repositoryPath)
    const integrated = await repository.currentRevision()

    await expect(repository.inspectReview(
      worktree,
      reviewed,
      targetRevisionBeforeReview
    )).rejects.toThrow('精确 Task revision 快进')
    expect(integrated).not.toBe(reviewed)
  })

  it('rejects ref-only promotion that leaves the main checkout out of sync', async () => {
    const { repositoryPath, repository } = await fixture()
    const worktree = await repository.createWorktree(input('unsafe-promotion'))
    await completeTask(worktree)
    const tip = await agentCommit(worktree, 'maintainer: candidate')
    const oldMain = await repository.currentRevision()
    await runArtifactGit(['update-ref', 'refs/heads/main', tip, oldMain], repositoryPath)

    await expect(repository.inspectReview(worktree, tip, oldMain))
      .rejects.toThrow('同步且 clean')
  })
})

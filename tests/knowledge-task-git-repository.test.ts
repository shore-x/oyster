import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
    sourceRef: 'raw:source@revision',
    taskDefinition: record(taskId),
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

async function agentCommit(worktree: KnowledgeTaskWorktree, message: string): Promise<string> {
  await runArtifactGit(['add', '-A'], worktree.worktreePath)
  await runArtifactGit(['commit', '--quiet', '--no-gpg-sign', '-m', message], worktree.worktreePath)
  return gitOutput(['rev-parse', 'HEAD'], worktree.worktreePath)
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
  it('creates an uncommitted Task definition and never checkpoints it for the Agent', async () => {
    const { repositoryPath, repository } = await fixture()
    const base = await repository.currentRevision()
    const worktree = await repository.createWorktree(input('agent-owned-start'))

    expect(await gitOutput(['rev-parse', 'HEAD'], worktree.worktreePath)).toBe(base)
    expect(await gitOutput(['status', '--short'], worktree.worktreePath)).toContain('tasks/')
    const stored = JSON.parse(await readFile(join(worktree.taskPath, 'task.json'), 'utf8'))
    expect(stored).toMatchObject({
      formatVersion: 3,
      taskId: 'agent-owned-start',
      sourceRef: 'raw:source@revision'
    })
    expect(stored).not.toHaveProperty('status')
    expect(stored).not.toHaveProperty('result')
    expect(stored).not.toHaveProperty('agentInvocations')
    expect(await repository.prepareAgentTurn(worktree, base)).toBe(base)
    expect(await repository.currentRevision()).toBe(base)
    expect(await gitOutput(['status', '--short'], repositoryPath)).toBe('')
  })

  it('validates a clean Maintainer commit and derives all Task changed paths', async () => {
    const { repository } = await fixture()
    const worktree = await repository.createWorktree(input('maintained-task'))
    await completeProgress(worktree)
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
        'tasks/maintained-task/task.json'
      ])
    })
    await expect(repository.taskChangedPaths(worktree.taskId, revision))
      .resolves.toContain('knowledge/subject.md')
  })

  it('validates preview commits without requiring a tracked task definition', async () => {
    const { repository } = await fixture()
    const preview = await repository.createWorktree({
      ...input('preview-task'),
      kind: 'preview',
      taskDefinition: undefined
    })
    await completeProgress(preview)
    await writeFile(join(preview.worktreePath, 'knowledge', 'preview.md'), '# Preview\n\nBody.\n')
    const revision = await agentCommit(preview, 'preview: candidate')

    await expect(repository.inspectAgentCommit(
      preview,
      preview.baseRepositoryRevision
    )).resolves.toMatchObject({ candidateRepositoryRevision: revision })
  })

  it('rejects dirty, missing, unrelated, or task.json-mutating Agent handoffs', async () => {
    const { repository } = await fixture()
    const dirty = await repository.createWorktree(input('dirty-task'))
    await expect(repository.inspectAgentCommit(dirty, dirty.baseRepositoryRevision))
      .rejects.toThrow('必须提交')

    const unchanged = await repository.createWorktree(input('unchanged-task'))
    await agentCommit(unchanged, 'maintainer: start task')
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
    await completeProgress(rewritten)
    await agentCommit(rewritten, 'maintainer: start task')
    const original = await readFile(join(rewritten.taskPath, 'task.json'), 'utf8')
    await runArtifactGit(['rm', '--quiet', '--', 'tasks/rewritten-task/task.json'], rewritten.worktreePath)
    await runArtifactGit([
      'commit', '--quiet', '--no-gpg-sign', '-m', 'maintainer: remove Task summary'
    ], rewritten.worktreePath)
    await writeFile(join(rewritten.taskPath, 'task.json'), original)
    await agentCommit(rewritten, 'maintainer: restore Task summary')
    await expect(repository.inspectAgentCommit(rewritten, rewritten.baseRepositoryRevision))
      .rejects.toThrow('不得修改')
  })

  it('requires a changes-requested Reviewer to commit its feedback', async () => {
    const { repository } = await fixture()
    const worktree = await repository.createWorktree(input('review-task'))
    await completeProgress(worktree)
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
      worktree.progressPath,
      `${await readFile(worktree.progressPath, 'utf8')}\n- [ ] Resolve feedback.\n`
    )
    await agentCommit(worktree, 'reviewer: request changes')

    await expect(repository.inspectReview(worktree, reviewed)).resolves.toMatchObject({
      kind: 'changes_requested',
      reviewedRepositoryRevision: reviewed,
      markerPaths: ['knowledge/subject.md']
    })
  })

  it('approves only after Agent fast-forward promotion synchronizes main HEAD and index', async () => {
    const { repositoryPath, repository } = await fixture()
    const worktree = await repository.createWorktree(input('approved-task'))
    await completeProgress(worktree)
    await writeFile(join(worktree.worktreePath, 'knowledge', 'approved.md'), '# Approved\n\nBody.\n')
    const reviewed = await agentCommit(worktree, 'maintainer: approved candidate')

    await expect(repository.inspectReview(worktree, reviewed))
      .rejects.toThrow('快进合并')

    await runArtifactGit(['merge', '--quiet', '--ff-only', worktree.branchName], repositoryPath)
    await expect(repository.inspectReview(worktree, reviewed)).resolves.toEqual({
      kind: 'approved',
      reviewedRepositoryRevision: reviewed,
      candidateRepositoryRevision: reviewed,
      integratedRepositoryRevision: reviewed
    })
    await expect(readFile(join(repositoryPath, 'knowledge', 'approved.md'), 'utf8'))
      .resolves.toContain('Body')
  })

  it('rejects promotion while the main checkout contains uncommitted user changes', async () => {
    const { repositoryPath, repository } = await fixture()
    const worktree = await repository.createWorktree(input('dirty-main-promotion'))
    await completeProgress(worktree)
    const reviewed = await agentCommit(worktree, 'maintainer: approved candidate')
    await writeFile(join(repositoryPath, 'user-note.txt'), 'untracked user content\n')

    await runArtifactGit(['merge', '--quiet', '--ff-only', worktree.branchName], repositoryPath)
    await expect(repository.inspectReview(worktree, reviewed))
      .rejects.toThrow('同步且 clean')
    await expect(readFile(join(repositoryPath, 'user-note.txt'), 'utf8'))
      .resolves.toContain('untracked user content')
  })

  it('ignores REVIEW marker bytes in binary Artifact files', async () => {
    const { repositoryPath, repository } = await fixture()
    const worktree = await repository.createWorktree(input('binary-artifact'))
    await completeProgress(worktree)
    await writeFile(
      join(worktree.worktreePath, 'artifacts', 'binary.dat'),
      Buffer.concat([
        Buffer.from([0, 1, 2, 3]),
        Buffer.from(REVIEW_MARKER_START),
        Buffer.from([0, 4, 5])
      ])
    )
    const reviewed = await agentCommit(worktree, 'maintainer: binary Artifact')
    await runArtifactGit(['merge', '--quiet', '--ff-only', worktree.branchName], repositoryPath)

    await expect(repository.inspectReview(worktree, reviewed)).resolves.toMatchObject({
      kind: 'approved',
      integratedRepositoryRevision: reviewed
    })
  })

  it('keeps approval valid when another Task advances main before Runtime inspection', async () => {
    const { repositoryPath, repository } = await fixture()
    const worktree = await repository.createWorktree(input('advanced-main'))
    await completeProgress(worktree)
    const reviewed = await agentCommit(worktree, 'maintainer: approved candidate')
    await runArtifactGit(['merge', '--quiet', '--ff-only', worktree.branchName], repositoryPath)
    await writeFile(join(repositoryPath, 'knowledge', 'later.md'), '# Later\n\nMain change.\n')
    await runArtifactGit(['add', '-A'], repositoryPath)
    await runArtifactGit(['commit', '--quiet', '--no-gpg-sign', '-m', 'main: later'], repositoryPath)
    const integrated = await repository.currentRevision()

    await expect(repository.inspectReview(worktree, reviewed)).resolves.toEqual({
      kind: 'approved',
      reviewedRepositoryRevision: reviewed,
      candidateRepositoryRevision: reviewed,
      integratedRepositoryRevision: integrated
    })
  })

  it('rejects ref-only promotion that leaves the main checkout out of sync', async () => {
    const { repositoryPath, repository } = await fixture()
    const worktree = await repository.createWorktree(input('unsafe-promotion'))
    await completeProgress(worktree)
    const tip = await agentCommit(worktree, 'maintainer: candidate')
    const oldMain = await repository.currentRevision()
    await runArtifactGit(['update-ref', 'refs/heads/main', tip, oldMain], repositoryPath)

    await expect(repository.inspectReview(worktree, tip))
      .rejects.toThrow('同步且 clean')
  })
})

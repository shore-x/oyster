import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  REVIEW_MARKER_COMMENT,
  REVIEW_MARKER_END,
  REVIEW_MARKER_START,
  UnifiedGitRepositoryPrototype,
  type PrototypeCollaborationWorkspace
} from '../prototypes/unified-git-repository/unified-git-repository'
import {
  ARTIFACT_GIT_BINARY_PATH,
  createArtifactGitEnvironment
} from '../src/main/artifacts/git-runtime'

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []

async function prototypeRepository(): Promise<{
  parentPath: string
  repositoryPath: string
  repository: UnifiedGitRepositoryPrototype
}> {
  const parentPath = await mkdtemp(join(tmpdir(), 'unified-git-'))
  temporaryDirectories.push(parentPath)
  const repositoryPath = join(parentPath, 'repository')
  const repository = new UnifiedGitRepositoryPrototype(repositoryPath)
  await repository.initialize()
  return { parentPath, repositoryPath, repository }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(ARTIFACT_GIT_BINARY_PATH, args, {
    cwd,
    env: createArtifactGitEnvironment()
  })
  return stdout.trim()
}

async function commit(workspace: PrototypeCollaborationWorkspace, message: string): Promise<string> {
  await git(workspace.worktreePath, ['add', '-A'])
  await git(workspace.worktreePath, ['commit', '--quiet', '--no-gpg-sign', '-m', message])
  return git(workspace.worktreePath, ['rev-parse', 'HEAD'])
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => (
    rm(path, { recursive: true, force: true })
  )))
})

describe('UnifiedGitRepositoryPrototype', () => {
  it('records one Maintainer commit that changes Knowledge and Artifact together', async () => {
    const { repositoryPath, repository } = await prototypeRepository()
    const workspace = await repository.createCollaboration()

    await repository.writeKnowledgeStatement(workspace, 'repository.md', {
      title: 'Unified Repository',
      content: 'The repository stores [[Knowledge Statement]] and Artifact files.'
    })
    await repository.writeKnowledgeStatement(workspace, 'statement.md', {
      title: 'Knowledge Statement',
      content: 'A self-explaining unit of knowledge.'
    })
    await repository.createArtifact(workspace, 'review-guide', 'Maintain review guidance.')
    await repository.writeArtifactFile(
      workspace,
      'review-guide',
      'guide.md',
      '# Review guide\n\nReview the current collaboration branch.\n'
    )
    await commit(workspace, 'maintain: update repository knowledge and guide')

    const handoff = await repository.recordMaintainerHandoff(workspace, workspace.baseRevision)
    const index = await repository.buildIndex(handoff.revision)

    expect(await git(repositoryPath, [
      'rev-list',
      '--count',
      `${workspace.baseRevision}..${handoff.revision}`
    ])).toBe('1')
    expect(handoff.changedPaths).toEqual([
      'artifacts/review-guide/AGENTS.md',
      'artifacts/review-guide/guide.md',
      'knowledge/repository.md',
      'knowledge/statement.md'
    ])
    expect(index.knowledge.map(({ title }) => title)).toEqual([
      'Knowledge Statement',
      'Unified Repository'
    ])
    expect(index.references).toEqual([{
      sourceTitle: 'Unified Repository',
      targetTitle: 'Knowledge Statement',
      resolved: true
    }])
  })

  it('preserves incremental Maintainer and Reviewer commits under the approval merge', async () => {
    const { repositoryPath, repository } = await prototypeRepository()
    const workspace = await repository.createCollaboration()
    const statementPath = await repository.writeKnowledgeStatement(workspace, 'subject.md', {
      title: 'Subject',
      content: 'It belongs here.'
    })
    const firstMaintainerRevision = await commit(workspace, 'maintain: add subject')
    await repository.recordMaintainerHandoff(workspace, workspace.baseRevision)

    await writeFile(statementPath, [
      '# Subject',
      '',
      REVIEW_MARKER_START,
      'It belongs here.',
      REVIEW_MARKER_COMMENT,
      'Replace the unresolved pronouns with explicit subjects and context.',
      REVIEW_MARKER_END,
      ''
    ].join('\n'), 'utf8')
    const reviewRevision = await commit(workspace, 'review: mark unresolved context')
    const requested = await repository.recordReviewerOutcome(workspace, firstMaintainerRevision)
    expect(requested).toMatchObject({
      kind: 'changes_requested',
      reviewedRevision: firstMaintainerRevision,
      revision: reviewRevision,
      markerPaths: ['knowledge/subject.md']
    })

    await writeFile(
      statementPath,
      '# Subject\n\nSubject is a named concept in the unified repository.\n',
      'utf8'
    )
    const secondMaintainerRevision = await commit(workspace, 'maintain: resolve review context')
    await repository.recordMaintainerHandoff(workspace, reviewRevision)

    await git(repositoryPath, [
      'merge',
      '--quiet',
      '--no-ff',
      '--no-gpg-sign',
      '-m',
      'review: approve collaboration',
      workspace.branchName
    ])
    const accepted = await repository.recordReviewerOutcome(workspace, secondMaintainerRevision)
    expect(accepted).toMatchObject({
      kind: 'accepted',
      reviewedRevision: secondMaintainerRevision,
      targetBranch: 'main'
    })

    const mergeParents = (await git(repositoryPath, [
      'rev-list',
      '--parents',
      '-n',
      '1',
      'main'
    ])).split(' ').slice(1)
    expect(mergeParents).toEqual([workspace.baseRevision, secondMaintainerRevision])
    expect(await git(repositoryPath, ['merge-base', '--is-ancestor', reviewRevision, 'main']))
      .toBe('')
  })

  it('rejects malformed Review handoffs and unresolved markers from Maintainer', async () => {
    const { repository } = await prototypeRepository()
    const workspace = await repository.createCollaboration()
    const statementPath = await repository.writeKnowledgeStatement(workspace, 'subject.md', {
      title: 'Subject',
      content: 'Initial content.'
    })
    const maintained = await commit(workspace, 'maintain: add subject')
    await repository.recordMaintainerHandoff(workspace, workspace.baseRevision)

    await writeFile(
      statementPath,
      `# Subject\n\n${REVIEW_MARKER_START}\nIncomplete marker.\n`,
      'utf8'
    )
    await commit(workspace, 'review: malformed marker')
    await expect(repository.recordReviewerOutcome(workspace, maintained))
      .rejects.toThrow('REVIEW 标记格式不完整')

    const malformedReview = await repository.collaborationRevision(workspace)
    await writeFile(statementPath, [
      '# Subject',
      '',
      REVIEW_MARKER_START,
      'Initial content.',
      REVIEW_MARKER_COMMENT,
      'Still needs a concrete subject.',
      REVIEW_MARKER_END,
      ''
    ].join('\n'), 'utf8')
    await commit(workspace, 'maintain: incorrectly retain review marker')
    await expect(repository.recordMaintainerHandoff(workspace, malformedReview))
      .rejects.toThrow('仍有未解决的 REVIEW 标记')
  })

  it('rejects an approval merge whose tree differs from the reviewed revision', async () => {
    const { repositoryPath, repository } = await prototypeRepository()
    const workspace = await repository.createCollaboration()
    await repository.writeKnowledgeStatement(workspace, 'subject.md', {
      title: 'Subject',
      content: 'Reviewed content.'
    })
    const reviewedRevision = await commit(workspace, 'maintain: add reviewed subject')
    await repository.recordMaintainerHandoff(workspace, workspace.baseRevision)

    await git(repositoryPath, [
      'merge',
      '--quiet',
      '--no-ff',
      '--no-commit',
      workspace.branchName
    ])
    await writeFile(
      join(repositoryPath, 'knowledge/subject.md'),
      '# Subject\n\nContent changed while creating the approval merge.\n',
      'utf8'
    )
    await git(repositoryPath, ['add', '-A'])
    await git(repositoryPath, [
      'commit',
      '--quiet',
      '--no-gpg-sign',
      '-m',
      'review: approve a different tree'
    ])

    await expect(repository.recordReviewerOutcome(workspace, reviewedRevision))
      .rejects.toThrow('Reviewer merge tree 与被审阅 revision 不一致')
  })

  it('validates duplicate titles and Artifact Attention at Maintainer handoff', async () => {
    const { repository } = await prototypeRepository()
    const duplicate = await repository.createCollaboration()
    await repository.writeKnowledgeStatement(duplicate, 'one.md', {
      title: 'Duplicate',
      content: 'One.'
    })
    await repository.writeKnowledgeStatement(duplicate, 'two.md', {
      title: 'Duplicate',
      content: 'Two.'
    })
    await commit(duplicate, 'maintain: add duplicate knowledge')
    await expect(repository.recordMaintainerHandoff(duplicate, duplicate.baseRevision))
      .rejects.toThrow('canonical title 重复')

    const invalidArtifact = await repository.createCollaboration()
    await repository.writeArtifactFile(
      invalidArtifact,
      'missing-attention',
      'notes.md',
      'No AGENTS.md exists.\n'
    )
    await commit(invalidArtifact, 'maintain: add invalid artifact')
    await expect(repository.recordMaintainerHandoff(invalidArtifact, invalidArtifact.baseRevision))
      .rejects.toThrow('Artifact 缺少根 AGENTS.md')
  })
})

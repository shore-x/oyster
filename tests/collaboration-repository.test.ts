import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CollaborationRepository,
  COLLABORATION_WORK_FILE,
  REVIEW_MARKER_COMMENT,
  REVIEW_MARKER_END,
  REVIEW_MARKER_START
} from '../src/main/knowledge-processing/collaboration-repository'
import {
  ARTIFACT_GIT_BINARY_PATH,
  createArtifactGitEnvironment
} from '../src/main/artifacts/git-runtime'

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(ARTIFACT_GIT_BINARY_PATH, args, {
    cwd,
    env: createArtifactGitEnvironment()
  })
  return stdout.trim()
}

async function commit(cwd: string, message: string): Promise<string> {
  await git(cwd, ['add', '-A'])
  await git(cwd, ['commit', '--quiet', '--no-gpg-sign', '-m', message])
  return git(cwd, ['rev-parse', 'HEAD'])
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => (
    rm(path, { recursive: true, force: true })
  )))
})

describe('CollaborationRepository', () => {
  it('keeps file work state and review handoffs on a real unmerged branch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oyster-collaboration-'))
    temporaryDirectories.push(directory)
    const repository = new CollaborationRepository(join(directory, 'repository'))
    const baseRevision = await repository.initialize()
    const workspace = await repository.createCollaboration({
      sourceRef: 'raw:test@sha256:abc',
      attention: 'Keep the repository model self-explaining.',
      items: ['Inspect Canonical Activity segment 1.\n- read_activity({"activity":1,"offset":0,"limit":20})']
    })

    expect(workspace.baseRevision).toBe(baseRevision)
    expect(workspace.workOrderRevision).not.toBe(baseRevision)
    expect(await repository.currentRevision()).toBe(baseRevision)
    expect(await repository.readWorkOrder(workspace)).toContain('- [ ] Inspect Canonical Activity segment 1.')

    const statementPath = join(workspace.worktreePath, 'knowledge', 'repository.md')
    await writeFile(statementPath, '# Repository\n\nRepository keeps Knowledge and Artifact changes together.\n', 'utf8')
    const workPath = join(workspace.worktreePath, COLLABORATION_WORK_FILE)
    await writeFile(
      workPath,
      (await readFile(workPath, 'utf8')).replaceAll('- [ ]', '- [x]'),
      'utf8'
    )
    const firstMaintainerRevision = await commit(workspace.worktreePath, 'maintain: add repository knowledge')
    const firstHandoff = await repository.recordMaintainerHandoff(
      workspace,
      workspace.workOrderRevision
    )
    expect(firstHandoff.revision).toBe(firstMaintainerRevision)

    const marker = [
      REVIEW_MARKER_START,
      'Repository keeps Knowledge and Artifact changes together.',
      REVIEW_MARKER_COMMENT,
      'Explain what a Repository revision represents.',
      REVIEW_MARKER_END
    ].join('\n')
    await writeFile(
      statementPath,
      `# Repository\n\n${marker}\n`,
      'utf8'
    )
    await writeFile(
      workPath,
      `${await readFile(workPath, 'utf8')}\n- [ ] Resolve every REVIEW marker.\n`,
      'utf8'
    )
    const reviewRevision = await commit(workspace.worktreePath, 'review: request revision explanation')
    const requested = await repository.recordReviewerOutcome(workspace, firstMaintainerRevision)
    expect(requested).toMatchObject({
      kind: 'changes_requested',
      revision: reviewRevision,
      markerPaths: ['knowledge/repository.md']
    })

    await writeFile(
      statementPath,
      '# Repository\n\nA Repository revision is one immutable Knowledge and Artifact tree.\n',
      'utf8'
    )
    await writeFile(
      workPath,
      (await readFile(workPath, 'utf8')).replaceAll('- [ ]', '- [x]'),
      'utf8'
    )
    const secondMaintainerRevision = await commit(workspace.worktreePath, 'maintain: resolve review')
    await repository.recordMaintainerHandoff(workspace, reviewRevision)

    await rm(workPath)
    const approvalRevision = await commit(workspace.worktreePath, 'review: approve collaboration')
    const approved = await repository.recordReviewerOutcome(workspace, secondMaintainerRevision)
    expect(approved).toEqual({
      kind: 'approved',
      reviewedRevision: secondMaintainerRevision,
      revision: approvalRevision
    })
    expect(await repository.currentRevision()).toBe(baseRevision)
    expect((await repository.revisionView(approvalRevision)).knowledge).toEqual([
      expect.objectContaining({
        path: 'knowledge/repository.md',
        title: 'Repository'
      })
    ])
  })

  it('rejects a Maintainer commit while the file checklist is incomplete', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oyster-collaboration-'))
    temporaryDirectories.push(directory)
    const repository = new CollaborationRepository(join(directory, 'repository'))
    await repository.initialize()
    const workspace = await repository.createCollaboration({
      sourceRef: 'raw:test@sha256:def',
      items: ['Inspect the activity.']
    })
    await writeFile(
      join(workspace.worktreePath, 'knowledge', 'subject.md'),
      '# Subject\n\nA complete subject.\n',
      'utf8'
    )
    await commit(workspace.worktreePath, 'maintain: incomplete work')

    await expect(repository.recordMaintainerHandoff(workspace, workspace.workOrderRevision))
      .rejects.toThrow('工作清单仍有未完成项')
  })
})

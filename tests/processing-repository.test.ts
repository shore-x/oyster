import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runArtifactGit } from '../src/main/artifacts/git-runtime'
import {
  ProcessingRepository,
  REVIEW_MARKER_COMMENT,
  REVIEW_MARKER_END,
  REVIEW_MARKER_START,
} from '../src/main/knowledge-processing/processing-repository'

async function fixture() {
  const rootPath = await mkdtemp(join(tmpdir(), 'oyster-processing-repository-'))
  const repository = new ProcessingRepository(rootPath)
  await repository.initialize()
  return { rootPath, repository }
}

async function commit(rootPath: string, message: string): Promise<void> {
  await runArtifactGit(['add', '--', 'knowledge', 'artifacts'], rootPath)
  await runArtifactGit(['commit', '--quiet', '--no-gpg-sign', '-m', message], rootPath)
}

async function completeWork(workPath: string): Promise<void> {
  await writeFile(workPath, (await readFile(workPath, 'utf8')).replaceAll('- [ ]', '- [x]'))
}

describe('ProcessingRepository', () => {
  it('keeps one global tree and one durable directory per Run', async () => {
    const { rootPath, repository } = await fixture()
    const run = await repository.createRun({
      id: 'run-one',
      sourceRef: 'session:test',
      items: ['Inspect the session.']
    })
    expect(run.repositoryPath).toBe(rootPath)
    expect(run.runPath).toBe(join(rootPath, 'runs', 'run-one'))
    expect(run.workPath).toBe(join(run.runPath, 'WORK.md'))
    expect(await repository.readWorkOrder(run)).toContain('- [ ] Inspect the session.')

    await completeWork(run.workPath)
    await writeFile(join(rootPath, 'knowledge', 'subject.md'), '# Subject\n\nInitial.\n')
    await commit(rootPath, 'maintain: subject')
    const maintainedRevision = await repository.runRevision(run)
    await expect(repository.recordMaintainerHandoff(run, run.baseRevision)).resolves.toEqual({
      previousRevision: run.baseRevision,
      revision: maintainedRevision,
      changedPaths: ['knowledge/subject.md']
    })

    const reviewBlock = [
      REVIEW_MARKER_START,
      'Initial.',
      REVIEW_MARKER_COMMENT,
      'Explain the subject.',
      REVIEW_MARKER_END
    ].join('\n')
    await writeFile(join(rootPath, 'knowledge', 'subject.md'), `# Subject\n\n${reviewBlock}\n`)
    await writeFile(run.workPath, `${await readFile(run.workPath, 'utf8')}\n- [ ] Explain Subject.\n`)
    await commit(rootPath, 'review: request explanation')
    const reviewRevision = await repository.runRevision(run)
    await expect(repository.recordReviewerOutcome(run, maintainedRevision)).resolves.toMatchObject({
      kind: 'changes_requested',
      revision: reviewRevision,
      markerPaths: ['knowledge/subject.md']
    })

    await writeFile(join(rootPath, 'knowledge', 'subject.md'), '# Subject\n\nSelf-explaining subject.\n')
    await completeWork(run.workPath)
    await commit(rootPath, 'maintain: explain subject')
    const finalRevision = await repository.runRevision(run)
    await repository.recordMaintainerHandoff(run, reviewRevision)
    await expect(repository.recordReviewerOutcome(run, finalRevision)).resolves.toEqual({
      kind: 'approved',
      reviewedRevision: finalRevision,
      revision: finalRevision
    })
    await expect(readFile(run.workPath, 'utf8')).resolves.toContain(
      `Maintainer handed off revision ${maintainedRevision}`
    )
    await expect(readFile(run.workPath, 'utf8')).resolves.toContain(
      `Reviewer requested changes in revision ${reviewRevision}`
    )
    await expect(readFile(run.workPath, 'utf8')).resolves.toContain(
      `Reviewer approved revision ${finalRevision}`
    )
  })

  it('rejects a Maintainer handoff with pending WORK.md items', async () => {
    const { rootPath, repository } = await fixture()
    const run = await repository.createRun({ sourceRef: 'session:test', items: ['Pending.'] })
    await writeFile(join(rootPath, 'knowledge', 'subject.md'), '# Subject\n\nBody.\n')
    await commit(rootPath, 'maintain: incomplete')
    await expect(repository.recordMaintainerHandoff(run, run.baseRevision))
      .rejects.toThrow('工作清单仍有未完成项')
  })
})

import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
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
import type { KnowledgeRunWorkspacePlan } from '../src/main/knowledge-processing/run-workspace'

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

function workspace(items: string[]): KnowledgeRunWorkspacePlan {
  return {
    files: [
      { relativePath: 'inputs/README.md', content: '# Inputs\n' },
      { relativePath: 'inputs/activity/segment-000001-page-000001.md', content: 'Activity.\n' },
      { relativePath: 'inputs/evidence/INDEX.md', content: '# Evidence\n' }
    ],
    items,
    activitySegmentCount: 1,
    activityPageCount: 1,
    evidencePageCount: 0,
    attachmentCount: 0,
    canonicalActivityFormat: 'test-activity-v1',
    rawEvidenceFormat: 'test-raw-v1',
    activityCount: 1,
    rawEvidenceLineCount: 1
  }
}

describe('ProcessingRepository', () => {
  it('rejects a symlinked Host-managed runs directory', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'oyster-processing-symlink-'))
    const rootPath = join(parent, 'repository')
    const targetPath = join(parent, 'external-runs')
    await mkdir(rootPath)
    await mkdir(targetPath)
    await symlink(targetPath, join(rootPath, 'runs'), 'dir')

    await expect(new ProcessingRepository(rootPath).initialize())
      .rejects.toThrow('runs 必须是 APP 管理的真实目录')
  })

  it('keeps one global tree and one durable directory per Run', async () => {
    const { rootPath, repository } = await fixture()
    const run = await repository.createRun({
      id: 'run-one',
      sourceRef: 'session:test',
      workspace: workspace(['Inspect the session.'])
    })
    expect(run.repositoryPath).toBe(rootPath)
    expect(run.runPath).toBe(join(rootPath, 'runs', 'run-one'))
    expect(run.taskPath).toBe(join(run.runPath, 'TASK.md'))
    expect(run.workPath).toBe(join(run.runPath, 'WORK.md'))
    expect(run.inputPath).toBe(join(run.runPath, 'inputs'))
    await expect(readFile(run.taskPath, 'utf8')).resolves.toContain('independent workspace')
    await expect(readFile(join(run.inputPath, 'README.md'), 'utf8')).resolves.toContain('# Inputs')
    await expect(repository.assertRunWorkspace(run)).resolves.toBeUndefined()
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

  it('allows a Run to begin with existing Knowledge or Artifact working-tree edits', async () => {
    const { rootPath, repository } = await fixture()
    const statementPath = join(rootPath, 'knowledge', 'subject.md')
    await writeFile(statementPath, '# Subject\n\nBefore.\n')
    await commit(rootPath, 'knowledge: add subject')
    await writeFile(statementPath, '# Subject\n\nEdited before the Run.\n')
    const draftPath = join(rootPath, 'artifacts', 'draft.txt')
    await writeFile(draftPath, 'Untracked draft.\n')
    await chmod(draftPath, 0o755)

    const run = await repository.createRun({
      id: 'run-existing-edit',
      sourceRef: 'session:test',
      workspace: workspace(['Inspect existing edits.'])
    })

    const manifest = JSON.parse(await readFile(join(run.runPath, 'workspace.json'), 'utf8'))
    expect(manifest).toMatchObject({
      formatVersion: 4,
      initialRepositoryState: {
        status: expect.stringContaining('knowledge/subject.md'),
        trackedDiffBytes: expect.any(Number),
        trackedDiffSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        indexDiffBytes: expect.any(Number),
        indexDiffSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        untracked: [{
          path: 'artifacts/draft.txt',
          kind: 'file',
          mode: '100755',
          bytes: 17,
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
        }]
      }
    })
    await expect(repository.assertAgentStart(run, run.baseRevision, undefined, true))
      .resolves.toBeUndefined()
    await completeWork(run.workPath)
    await commit(rootPath, 'maintain: accept existing subject edit')
    await expect(repository.recordMaintainerHandoff(run, run.baseRevision)).resolves.toMatchObject({
      changedPaths: ['artifacts/draft.txt', 'knowledge/subject.md']
    })
  })

  it('binds the staged index separately from the final tracked working tree', async () => {
    const { rootPath, repository } = await fixture()
    const statementPath = join(rootPath, 'knowledge', 'subject.md')
    await writeFile(statementPath, '# Subject\n\nBase.\n')
    await commit(rootPath, 'knowledge: add subject')
    await writeFile(statementPath, '# Subject\n\nStaged B.\n')
    await runArtifactGit(['add', '--', 'knowledge/subject.md'], rootPath)
    await writeFile(statementPath, '# Subject\n\nWorking C.\n')

    const run = await repository.createRun({
      id: 'run-partial-stage',
      sourceRef: 'session:test',
      workspace: workspace(['Inspect partial stage.'])
    })

    await writeFile(statementPath, '# Subject\n\nStaged D.\n')
    await runArtifactGit(['add', '--', 'knowledge/subject.md'], rootPath)
    await writeFile(statementPath, '# Subject\n\nWorking C.\n')
    await expect(repository.assertAgentStart(run, run.baseRevision, undefined, true))
      .rejects.toThrow('Run 初始 Knowledge/Artifact working tree 已发生变化')
  })

  it('rejects a Maintainer handoff with pending WORK.md items', async () => {
    const { rootPath, repository } = await fixture()
    const run = await repository.createRun({
      sourceRef: 'session:test',
      workspace: workspace(['Pending.'])
    })
    await writeFile(join(rootPath, 'knowledge', 'subject.md'), '# Subject\n\nBody.\n')
    await commit(rootPath, 'maintain: incomplete')
    await expect(repository.recordMaintainerHandoff(run, run.baseRevision))
      .rejects.toThrow('工作清单仍有未完成项')
  })

  it('rejects pre-existing changes outside Knowledge and Artifact', async () => {
    const { rootPath, repository } = await fixture()
    await writeFile(join(rootPath, 'outside.txt'), 'Outside domain.\n')

    await expect(repository.createRun({
      sourceRef: 'session:test',
      workspace: workspace(['Inspect.'])
    })).rejects.toThrow('Knowledge/Artifact 之外的未提交修改')
  })

  it('rejects an untracked nested repository as an unfingerprinted initial input', async () => {
    const { rootPath, repository } = await fixture()
    const nestedPath = join(rootPath, 'artifacts', 'nested-repository')
    const runId = 'run-nested-repository'
    await mkdir(nestedPath)
    await runArtifactGit(['init', '--quiet'], nestedPath)
    await writeFile(join(nestedPath, 'README.md'), '# Nested\n')

    await expect(repository.createRun({
      id: runId,
      sourceRef: 'session:test',
      workspace: workspace(['Inspect.'])
    })).rejects.toThrow('不是普通文件或符号链接')

    await expect(readFile(join(rootPath, '.git', 'HEAD'), 'utf8'))
      .resolves.toBe('ref: refs/heads/main\n')
    await expect(readFile(join(rootPath, '.git', 'refs', 'heads', 'processing', runId), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(rootPath, 'runs', runId, 'TASK.md'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })

    await rm(nestedPath, { recursive: true, force: true })
    await expect(repository.createRun({
      id: runId,
      sourceRef: 'session:test',
      workspace: workspace(['Inspect.'])
    })).resolves.toMatchObject({ id: runId, branchName: `processing/${runId}` })
  })

  it('allows a clean gitlink but rejects uncommitted content in its nested worktree', async () => {
    const { rootPath, repository } = await fixture()
    const nestedPath = join(rootPath, 'artifacts', 'nested-repository')
    await mkdir(nestedPath)
    await runArtifactGit(['init', '--quiet', '--initial-branch=main'], nestedPath)
    await runArtifactGit(['config', 'user.name', 'Nested'], nestedPath)
    await runArtifactGit(['config', 'user.email', 'nested@oyster.local'], nestedPath)
    await writeFile(join(nestedPath, 'README.md'), '# Nested\n')
    await runArtifactGit(['add', '--', 'README.md'], nestedPath)
    await runArtifactGit([
      'commit', '--quiet', '--no-gpg-sign', '-m', 'Initialize nested repository'
    ], nestedPath)
    await commit(rootPath, 'artifact: add clean gitlink')

    await expect(repository.createRun({
      id: 'run-clean-gitlink',
      sourceRef: 'session:test',
      workspace: workspace(['Inspect clean gitlink.'])
    })).resolves.toMatchObject({ id: 'run-clean-gitlink' })

    await runArtifactGit(['checkout', '--quiet', 'main'], rootPath)
    await writeFile(join(nestedPath, 'README.md'), '# Nested\n\nDirty content.\n')
    await expect(repository.createRun({
      id: 'run-dirty-gitlink',
      sourceRef: 'session:test',
      workspace: workspace(['Inspect dirty gitlink.'])
    })).rejects.toThrow('嵌套 Git working tree 含有无法固定的未提交内容')
  })

  it('keeps fixed files isolated by Run and rejects input modification', async () => {
    const { rootPath, repository } = await fixture()
    const first = await repository.createRun({
      id: 'run-first',
      sourceRef: 'session:first',
      workspace: workspace(['First.'])
    })
    await writeFile(join(first.inputPath, 'README.md'), '# Changed\n')
    await expect(repository.assertRunWorkspace(first)).rejects.toThrow('固定输入已被修改')

    await runArtifactGit(['checkout', '--quiet', 'main'], rootPath)
    const second = await repository.createRun({
      id: 'run-second',
      sourceRef: 'session:second',
      workspace: workspace(['Second.'])
    })
    expect(second.runPath).not.toBe(first.runPath)
    await expect(readFile(join(second.inputPath, 'README.md'), 'utf8')).resolves.toBe('# Inputs\n')
  })

  it('rejects files or directories added to the fixed inputs tree', async () => {
    const { repository } = await fixture()
    const run = await repository.createRun({
      id: 'run-extra-input',
      sourceRef: 'session:test',
      workspace: workspace(['Inspect.'])
    })

    await mkdir(join(run.inputPath, 'unlisted'))
    await expect(repository.assertRunWorkspace(run))
      .rejects.toThrow('固定输入文件树已被修改')
  })

  it('rejects extra root files and a prematurely created run.json in an active Run', async () => {
    const { repository } = await fixture()
    const run = await repository.createRun({
      id: 'run-root-boundary',
      sourceRef: 'session:test',
      workspace: workspace(['Inspect.'])
    })
    await writeFile(join(run.runPath, 'scratch.txt'), 'scratch\n')
    await expect(repository.assertRunWorkspace(run))
      .rejects.toThrow('根目录包含未授权条目')

    const secondFixture = await fixture()
    const second = await secondFixture.repository.createRun({
      id: 'run-reserved-history',
      sourceRef: 'session:test',
      workspace: workspace(['Inspect.'])
    })
    await writeFile(join(second.runPath, 'run.json'), '{}\n')
    await expect(secondFixture.repository.assertAgentStart(second, second.baseRevision))
      .rejects.toThrow('根目录包含未授权条目：run.json')
  })
})

import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runArtifactGit } from '../src/main/artifacts/git-runtime'
import {
  KnowledgeTaskWorkspaceRepository,
  REVIEW_MARKER_COMMENT,
  REVIEW_MARKER_END,
  REVIEW_MARKER_START,
} from '../src/main/knowledge-processing/knowledge-task-workspace-repository'
import type { KnowledgeTaskWorkspacePlan } from '../src/main/knowledge-processing/task-workspace'

async function fixture() {
  const rootPath = await mkdtemp(join(tmpdir(), 'oyster-knowledge-task-workspace-repository-'))
  const repository = new KnowledgeTaskWorkspaceRepository(rootPath)
  await repository.initialize()
  return { rootPath, repository }
}

async function commit(rootPath: string, message: string): Promise<void> {
  await runArtifactGit(['add', '--', 'knowledge', 'artifacts'], rootPath)
  await runArtifactGit(['commit', '--quiet', '--no-gpg-sign', '-m', message], rootPath)
}

async function completeProgress(progressPath: string): Promise<void> {
  await writeFile(progressPath, (await readFile(progressPath, 'utf8')).replaceAll('- [ ]', '- [x]'))
}

function workspacePlan(items: string[]): KnowledgeTaskWorkspacePlan {
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

describe('KnowledgeTaskWorkspaceRepository', () => {
  it('rejects a symlinked Host-managed tasks directory', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'oyster-processing-symlink-'))
    const rootPath = join(parent, 'repository')
    const targetPath = join(parent, 'external-tasks')
    await mkdir(rootPath)
    await mkdir(targetPath)
    await symlink(targetPath, join(rootPath, 'tasks'), 'dir')

    await expect(new KnowledgeTaskWorkspaceRepository(rootPath).initialize())
      .rejects.toThrow('tasks 必须是 APP 管理的真实目录')
  })

  it('keeps one global tree and one durable directory per Task', async () => {
    const { rootPath, repository } = await fixture()
    const workspace = await repository.createWorkspace({
      taskId: 'workspace-one',
      sourceRef: 'raw:source-conversation-test@sha256:test',
      workspace: workspacePlan(['Inspect the Source Snapshot.'])
    })
    expect(workspace.repositoryPath).toBe(rootPath)
    expect(workspace.workspacePath).toBe(join(rootPath, 'tasks', 'workspace-one'))
    expect(workspace.briefPath).toBe(join(workspace.workspacePath, 'BRIEF.md'))
    expect(workspace.progressPath).toBe(join(workspace.workspacePath, 'PROGRESS.md'))
    expect(workspace.inputPath).toBe(join(workspace.workspacePath, 'inputs'))
    await expect(readFile(workspace.briefPath, 'utf8')).resolves.toContain('independent workspace')
    await expect(readFile(join(workspace.inputPath, 'README.md'), 'utf8')).resolves.toContain('# Inputs')
    await expect(repository.assertWorkspaceIntegrity(workspace)).resolves.toBeUndefined()
    expect(await repository.readProgress(workspace)).toContain('- [ ] Inspect the Source Snapshot.')

    await completeProgress(workspace.progressPath)
    await writeFile(join(rootPath, 'knowledge', 'subject.md'), '# Subject\n\nInitial.\n')
    await commit(rootPath, 'maintain: subject')
    const maintainedRevision = await repository.currentRepositoryRevision(workspace)
    await expect(repository.recordMaintainerHandoff(workspace, workspace.baseRepositoryRevision)).resolves.toEqual({
      previousRepositoryRevision: workspace.baseRepositoryRevision,
      candidateRepositoryRevision: maintainedRevision,
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
    await writeFile(workspace.progressPath, `${await readFile(workspace.progressPath, 'utf8')}\n- [ ] Explain Subject.\n`)
    await commit(rootPath, 'review: request explanation')
    const reviewRevision = await repository.currentRepositoryRevision(workspace)
    await expect(repository.recordReviewDecision(workspace, maintainedRevision)).resolves.toMatchObject({
      kind: 'changes_requested',
      reviewedRepositoryRevision: maintainedRevision,
      candidateRepositoryRevision: reviewRevision,
      markerPaths: ['knowledge/subject.md']
    })

    await writeFile(join(rootPath, 'knowledge', 'subject.md'), '# Subject\n\nSelf-explaining subject.\n')
    await completeProgress(workspace.progressPath)
    await commit(rootPath, 'maintain: explain subject')
    const finalRevision = await repository.currentRepositoryRevision(workspace)
    await repository.recordMaintainerHandoff(workspace, reviewRevision)
    await expect(repository.recordReviewDecision(workspace, finalRevision)).resolves.toEqual({
      kind: 'approved',
      reviewedRepositoryRevision: finalRevision,
      candidateRepositoryRevision: finalRevision
    })
    await expect(readFile(workspace.progressPath, 'utf8')).resolves.toContain(
      `Maintainer handed off revision ${maintainedRevision}`
    )
    await expect(readFile(workspace.progressPath, 'utf8')).resolves.toContain(
      `Reviewer requested changes in revision ${reviewRevision}`
    )
    await expect(readFile(workspace.progressPath, 'utf8')).resolves.toContain(
      `Reviewer approved revision ${finalRevision}`
    )
  })

  it('allows a Task to begin with existing Knowledge or Artifact working-tree edits', async () => {
    const { rootPath, repository } = await fixture()
    const statementPath = join(rootPath, 'knowledge', 'subject.md')
    await writeFile(statementPath, '# Subject\n\nBefore.\n')
    await commit(rootPath, 'knowledge: add subject')
    await writeFile(statementPath, '# Subject\n\nEdited before the Task.\n')
    const draftPath = join(rootPath, 'artifacts', 'draft.txt')
    await writeFile(draftPath, 'Untracked draft.\n')
    await chmod(draftPath, 0o755)

    const workspace = await repository.createWorkspace({
      taskId: 'workspace-existing-edit',
      sourceRef: 'raw:source-conversation-test@sha256:test',
      workspace: workspacePlan(['Inspect existing edits.'])
    })

    const manifest = JSON.parse(await readFile(join(workspace.workspacePath, 'manifest.json'), 'utf8'))
    expect(manifest).toMatchObject({
      formatVersion: 5,
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
    await expect(repository.assertAgentStart(workspace, workspace.baseRepositoryRevision, undefined, true))
      .resolves.toBeUndefined()
    await completeProgress(workspace.progressPath)
    await commit(rootPath, 'maintain: accept existing subject edit')
    await expect(repository.recordMaintainerHandoff(workspace, workspace.baseRepositoryRevision)).resolves.toMatchObject({
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

    const workspace = await repository.createWorkspace({
      taskId: 'workspace-partial-stage',
      sourceRef: 'raw:source-conversation-test@sha256:test',
      workspace: workspacePlan(['Inspect partial stage.'])
    })

    await writeFile(statementPath, '# Subject\n\nStaged D.\n')
    await runArtifactGit(['add', '--', 'knowledge/subject.md'], rootPath)
    await writeFile(statementPath, '# Subject\n\nWorking C.\n')
    await expect(repository.assertAgentStart(workspace, workspace.baseRepositoryRevision, undefined, true))
      .rejects.toThrow('Task 初始 Knowledge/Artifact working tree 已发生变化')
  })

  it('rejects a Maintainer handoff with pending PROGRESS.md items', async () => {
    const { rootPath, repository } = await fixture()
    const workspace = await repository.createWorkspace({
      sourceRef: 'raw:source-conversation-test@sha256:test',
      workspace: workspacePlan(['Pending.'])
    })
    await writeFile(join(rootPath, 'knowledge', 'subject.md'), '# Subject\n\nBody.\n')
    await commit(rootPath, 'maintain: incomplete')
    await expect(repository.recordMaintainerHandoff(workspace, workspace.baseRepositoryRevision))
      .rejects.toThrow('工作清单仍有未完成项')
  })

  it('rejects pre-existing changes outside Knowledge and Artifact', async () => {
    const { rootPath, repository } = await fixture()
    await writeFile(join(rootPath, 'outside.txt'), 'Outside domain.\n')

    await expect(repository.createWorkspace({
      sourceRef: 'raw:source-conversation-test@sha256:test',
      workspace: workspacePlan(['Inspect.'])
    })).rejects.toThrow('Knowledge/Artifact 之外的未提交修改')
  })

  it('rejects an untracked nested repository as an unfingerprinted initial input', async () => {
    const { rootPath, repository } = await fixture()
    const nestedPath = join(rootPath, 'artifacts', 'nested-repository')
    const taskId = 'workspace-nested-repository'
    await mkdir(nestedPath)
    await runArtifactGit(['init', '--quiet'], nestedPath)
    await writeFile(join(nestedPath, 'README.md'), '# Nested\n')

    await expect(repository.createWorkspace({
      taskId,
      sourceRef: 'raw:source-conversation-test@sha256:test',
      workspace: workspacePlan(['Inspect.'])
    })).rejects.toThrow('不是普通文件或符号链接')

    await expect(readFile(join(rootPath, '.git', 'HEAD'), 'utf8'))
      .resolves.toBe('ref: refs/heads/main\n')
    await expect(readFile(join(rootPath, '.git', 'refs', 'heads', 'knowledge-task', taskId), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(rootPath, 'tasks', taskId, 'BRIEF.md'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })

    await rm(nestedPath, { recursive: true, force: true })
    await expect(repository.createWorkspace({
      taskId,
      sourceRef: 'raw:source-conversation-test@sha256:test',
      workspace: workspacePlan(['Inspect.'])
    })).resolves.toMatchObject({ taskId, branchName: `knowledge-task/${taskId}` })
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

    await expect(repository.createWorkspace({
      taskId: 'workspace-clean-gitlink',
      sourceRef: 'raw:source-conversation-test@sha256:test',
      workspace: workspacePlan(['Inspect clean gitlink.'])
    })).resolves.toMatchObject({ taskId: 'workspace-clean-gitlink' })

    await runArtifactGit(['checkout', '--quiet', 'main'], rootPath)
    await writeFile(join(nestedPath, 'README.md'), '# Nested\n\nDirty content.\n')
    await expect(repository.createWorkspace({
      taskId: 'workspace-dirty-gitlink',
      sourceRef: 'raw:source-conversation-test@sha256:test',
      workspace: workspacePlan(['Inspect dirty gitlink.'])
    })).rejects.toThrow('嵌套 Git working tree 含有无法固定的未提交内容')
  })

  it('keeps fixed files isolated by Task and rejects input modification', async () => {
    const { rootPath, repository } = await fixture()
    const first = await repository.createWorkspace({
      taskId: 'workspace-first',
      sourceRef: 'raw:source-conversation-first@sha256:first',
      workspace: workspacePlan(['First.'])
    })
    await writeFile(join(first.inputPath, 'README.md'), '# Changed\n')
    await expect(repository.assertWorkspaceIntegrity(first)).rejects.toThrow('固定输入已被修改')

    await runArtifactGit(['checkout', '--quiet', 'main'], rootPath)
    const second = await repository.createWorkspace({
      taskId: 'workspace-second',
      sourceRef: 'raw:source-conversation-second@sha256:second',
      workspace: workspacePlan(['Second.'])
    })
    expect(second.workspacePath).not.toBe(first.workspacePath)
    await expect(readFile(join(second.inputPath, 'README.md'), 'utf8')).resolves.toBe('# Inputs\n')
  })

  it('rejects files or directories added to the fixed inputs tree', async () => {
    const { repository } = await fixture()
    const workspace = await repository.createWorkspace({
      taskId: 'workspace-extra-input',
      sourceRef: 'raw:source-conversation-test@sha256:test',
      workspace: workspacePlan(['Inspect.'])
    })

    await mkdir(join(workspace.inputPath, 'unlisted'))
    await expect(repository.assertWorkspaceIntegrity(workspace))
      .rejects.toThrow('固定输入文件树已被修改')
  })

  it('rejects extra root files and a prematurely created task.json in an active Task', async () => {
    const { repository } = await fixture()
    const workspace = await repository.createWorkspace({
      taskId: 'workspace-root-boundary',
      sourceRef: 'raw:source-conversation-test@sha256:test',
      workspace: workspacePlan(['Inspect.'])
    })
    await writeFile(join(workspace.workspacePath, 'scratch.txt'), 'scratch\n')
    await expect(repository.assertWorkspaceIntegrity(workspace))
      .rejects.toThrow('根目录包含未授权条目')

    const secondFixture = await fixture()
    const second = await secondFixture.repository.createWorkspace({
      taskId: 'workspace-reserved-history',
      sourceRef: 'raw:source-conversation-test@sha256:test',
      workspace: workspacePlan(['Inspect.'])
    })
    await writeFile(join(second.workspacePath, 'task.json'), '{}\n')
    await expect(secondFixture.repository.assertAgentStart(second, second.baseRepositoryRevision))
      .rejects.toThrow('根目录包含未授权条目：task.json')
  })
})

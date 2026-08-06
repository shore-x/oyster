import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import {
  ARTIFACT_GIT_BINARY_PATH,
  createArtifactGitEnvironment
} from '../artifacts/git-runtime'

const execFileAsync = promisify(execFile)
const TARGET_BRANCH = 'main'
const KNOWLEDGE_DIRECTORY = 'knowledge'
const ARTIFACT_DIRECTORY = 'artifacts'
const COLLABORATION_DIRECTORY = '.oyster'
export const COLLABORATION_WORK_FILE = `${COLLABORATION_DIRECTORY}/WORK.md`

export const REVIEW_MARKER_START = '<<<<<<< REVIEW'
export const REVIEW_MARKER_COMMENT = '||||||| REVIEW COMMENT'
export const REVIEW_MARKER_END = '>>>>>>> REVIEW'

const REVIEW_MARKERS = [
  REVIEW_MARKER_START,
  REVIEW_MARKER_COMMENT,
  REVIEW_MARKER_END
] as const

export interface CollaborationWorkspace {
  id: string
  repositoryPath: string
  worktreePath: string
  targetBranch: string
  branchName: string
  baseRevision: string
  workOrderRevision: string
}

export interface CollaborationWorkOrder {
  sourceRef: string
  attention?: string
  items: readonly string[]
}

export interface MaintainerHandoff {
  previousRevision: string
  revision: string
  changedPaths: string[]
}

export interface ChangesRequested {
  kind: 'changes_requested'
  reviewedRevision: string
  revision: string
  changedPaths: string[]
  markerPaths: string[]
}

export interface ApprovedReview {
  kind: 'approved'
  reviewedRevision: string
  revision: string
}

export type ReviewerOutcome = ChangesRequested | ApprovedReview

export interface RepositoryKnowledgeStatement {
  path: string
  title: string
  content: string
}

export interface RepositoryRevisionView {
  revision: string
  knowledge: RepositoryKnowledgeStatement[]
  artifactPaths: string[]
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 不能为空`)
  if (value.includes('\0')) throw new Error(`${label} 不能包含 NUL`)
  return value.trim()
}

function repositoryChild(rootPath: string, relativePath: string): string {
  const root = resolve(rootPath)
  const target = resolve(root, relativePath)
  const child = relative(root, target)
  if (!child || child === '..' || child.startsWith(`..${sep}`)) {
    throw new Error('Repository 文件路径无效')
  }
  return target
}

function markdownChecklistItem(value: string): string {
  const lines = requiredText(value, '工作项').split(/\r?\n/)
  return [
    `- [ ] ${lines[0]}`,
    ...lines.slice(1).map((line) => `  ${line}`)
  ].join('\n')
}

function serializeWorkOrder(input: CollaborationWorkOrder): string {
  if (!Array.isArray(input.items) || !input.items.length) {
    throw new Error('协作工作清单不能为空')
  }
  return [
    '# Collaboration Work Order',
    '',
    'This file is branch-local working state. It must be removed by the Reviewer before approval.',
    '',
    `Source reference: ${requiredText(input.sourceRef, 'Source reference')}`,
    ...(input.attention?.trim() ? ['', '## Attention', '', input.attention.trim()] : []),
    '',
    '## Checklist',
    '',
    ...input.items.map(markdownChecklistItem),
    '',
    '## Completion contract',
    '',
    '- [ ] Every required activity and attachment has been inspected.',
    '- [ ] Every justified Knowledge or Artifact change is committed.',
    '- [ ] No REVIEW marker remains.',
    '- [ ] The working tree is clean.',
    ''
  ].join('\n')
}

function hasPendingWork(document: string): boolean {
  return /^\s*- \[ \]/m.test(document)
}

function markerCount(document: string, marker: string): number {
  return document.split(marker).length - 1
}

function hasReviewMarker(document: string): boolean {
  return REVIEW_MARKERS.some((marker) => document.includes(marker))
}

function hasCompleteReviewMarkers(document: string): boolean {
  const counts = REVIEW_MARKERS.map((marker) => markerCount(document, marker))
  if (!counts[0] || counts.some((count) => count !== counts[0])) return false
  let offset = 0
  for (let index = 0; index < counts[0]; index += 1) {
    const start = document.indexOf(REVIEW_MARKER_START, offset)
    const comment = document.indexOf(REVIEW_MARKER_COMMENT, start + REVIEW_MARKER_START.length)
    const end = document.indexOf(REVIEW_MARKER_END, comment + REVIEW_MARKER_COMMENT.length)
    if (start < 0 || comment < 0 || end < 0) return false
    offset = end + REVIEW_MARKER_END.length
  }
  return true
}

function parseKnowledgeStatement(path: string, document: string): RepositoryKnowledgeStatement {
  const normalized = document.replace(/\r\n/g, '\n')
  const firstBreak = normalized.indexOf('\n')
  if (firstBreak < 0 || !normalized.startsWith('# ')) {
    throw new Error(`Knowledge 文件必须以 canonical title H1 开始：${path}`)
  }
  const title = requiredText(normalized.slice(2, firstBreak), `Knowledge title (${path})`)
  if (normalized[firstBreak + 1] !== '\n') {
    throw new Error(`Knowledge title 与正文之间必须有一个空行：${path}`)
  }
  const rawContent = normalized.slice(firstBreak + 2)
  const content = rawContent.endsWith('\n') ? rawContent.slice(0, -1) : rawContent
  if (!content.trim()) throw new Error(`Knowledge content 不能为空：${path}`)
  return { path, title, content }
}

function allowedCollaborationPath(path: string): boolean {
  return path === COLLABORATION_WORK_FILE
    || path.startsWith(`${KNOWLEDGE_DIRECTORY}/`)
    || path.startsWith(`${ARTIFACT_DIRECTORY}/`)
}

/** A real Git repository and one linear, branch-local Agent collaboration. */
export class CollaborationRepository {
  readonly repositoryPath: string

  constructor(repositoryPath: string) {
    this.repositoryPath = resolve(repositoryPath)
  }

  private async git(
    args: string[],
    cwd = this.repositoryPath,
    trimOutput = true
  ): Promise<string> {
    try {
      const { stdout } = await execFileAsync(ARTIFACT_GIT_BINARY_PATH, args, {
        cwd,
        env: createArtifactGitEnvironment(),
        maxBuffer: 16 * 1_024 * 1_024
      })
      return trimOutput ? stdout.trimEnd() : stdout
    } catch (error) {
      const details = error as Error & { stderr?: string }
      throw new Error(`Git 操作失败：${details.stderr?.trim() || details.message}`, { cause: error })
    }
  }

  async initialize(): Promise<string> {
    await mkdir(this.repositoryPath, { recursive: true })
    try {
      return await this.git(['rev-parse', '--verify', TARGET_BRANCH])
    } catch {
      await this.git(['init', '--quiet', `--initial-branch=${TARGET_BRANCH}`])
      await this.git(['config', 'user.name', 'Oyster Collaboration'])
      await this.git(['config', 'user.email', 'collaboration@oyster.local'])
      await Promise.all([
        mkdir(resolve(this.repositoryPath, KNOWLEDGE_DIRECTORY), { recursive: true }),
        mkdir(resolve(this.repositoryPath, ARTIFACT_DIRECTORY), { recursive: true })
      ])
      await Promise.all([
        writeFile(resolve(this.repositoryPath, KNOWLEDGE_DIRECTORY, '.gitkeep'), '', 'utf8'),
        writeFile(resolve(this.repositoryPath, ARTIFACT_DIRECTORY, '.gitkeep'), '', 'utf8')
      ])
      await this.git(['add', '--', KNOWLEDGE_DIRECTORY, ARTIFACT_DIRECTORY])
      await this.git(['commit', '--quiet', '--no-gpg-sign', '-m', 'Initialize collaboration repository'])
      return this.git(['rev-parse', TARGET_BRANCH])
    }
  }

  async currentRevision(): Promise<string> {
    return this.git(['rev-parse', TARGET_BRANCH])
  }

  async collaborationRevision(workspace: CollaborationWorkspace): Promise<string> {
    return this.git(['rev-parse', 'HEAD'], workspace.worktreePath)
  }

  async createCollaboration(input: CollaborationWorkOrder): Promise<CollaborationWorkspace> {
    const baseRevision = await this.currentRevision()
    const id = randomUUID()
    const branchName = `collaboration/${id}`
    const worktreesRoot = resolve(
      dirname(this.repositoryPath),
      `${basename(this.repositoryPath)}-worktrees`
    )
    const worktreePath = resolve(worktreesRoot, id)
    await mkdir(worktreesRoot, { recursive: true })
    await this.git([
      'worktree',
      'add',
      '--quiet',
      '-b',
      branchName,
      worktreePath,
      baseRevision
    ])
    await mkdir(repositoryChild(worktreePath, COLLABORATION_DIRECTORY), { recursive: true })
    await writeFile(
      repositoryChild(worktreePath, COLLABORATION_WORK_FILE),
      serializeWorkOrder(input),
      'utf8'
    )
    await this.git(['add', '--', COLLABORATION_WORK_FILE], worktreePath)
    await this.git([
      'commit',
      '--quiet',
      '--no-gpg-sign',
      '-m',
      'Initialize collaboration work order'
    ], worktreePath)
    const workOrderRevision = await this.git(['rev-parse', 'HEAD'], worktreePath)
    return {
      id,
      repositoryPath: this.repositoryPath,
      worktreePath,
      targetBranch: TARGET_BRANCH,
      branchName,
      baseRevision,
      workOrderRevision
    }
  }

  private async treeFiles(revision: string, path?: string): Promise<string[]> {
    const output = await this.git([
      'ls-tree',
      '-r',
      '--name-only',
      revision,
      ...(path ? ['--', path] : [])
    ])
    return output ? output.split('\n').filter(Boolean).sort() : []
  }

  private async readTreeFile(revision: string, path: string): Promise<string> {
    return this.git(['show', `${revision}:${path}`], this.repositoryPath, false)
  }

  private async fileExists(revision: string, path: string): Promise<boolean> {
    try {
      await this.git(['cat-file', '-e', `${revision}:${path}`])
      return true
    } catch {
      return false
    }
  }

  private async changedPaths(previousRevision: string, revision: string): Promise<string[]> {
    const output = await this.git(['diff', '--name-only', previousRevision, revision])
    return output ? output.split('\n').filter(Boolean).sort() : []
  }

  async revisionChangedPaths(previousRevision: string, revision: string): Promise<string[]> {
    return this.changedPaths(previousRevision, revision)
  }

  private async commitParents(revision: string): Promise<string[]> {
    const output = await this.git(['rev-list', '--parents', '-n', '1', revision])
    return output.split(' ').slice(1)
  }

  private async assertClean(cwd: string, label: string): Promise<void> {
    const status = await this.git(['status', '--porcelain', '--untracked-files=all'], cwd)
    if (status) throw new Error(`${label} 工作区尚未提交全部修改`)
  }

  private async assertWorkspace(workspace: CollaborationWorkspace): Promise<void> {
    const branch = await this.git(['branch', '--show-current'], workspace.worktreePath)
    if (branch !== workspace.branchName) throw new Error('协作 worktree 没有停留在绑定分支')
    if (await this.currentRevision() !== workspace.baseRevision) {
      throw new Error('目标分支已经离开协作 base')
    }
  }

  private async reviewMarkerPaths(revision: string): Promise<string[]> {
    const paths: string[] = []
    for (const path of await this.treeFiles(revision)) {
      if (!path.startsWith(`${KNOWLEDGE_DIRECTORY}/`)
        && !path.startsWith(`${ARTIFACT_DIRECTORY}/`)) continue
      const document = await this.readTreeFile(revision, path)
      if (hasReviewMarker(document)) paths.push(path)
    }
    return paths
  }

  private async assertNoReviewMarkers(revision: string): Promise<void> {
    const paths = await this.reviewMarkerPaths(revision)
    if (paths.length) throw new Error(`仍有未解决的 REVIEW 标记：${paths.join('、')}`)
  }

  async revisionView(revisionInput: string): Promise<RepositoryRevisionView> {
    const revision = await this.git(['rev-parse', '--verify', revisionInput])
    const knowledgePaths = (await this.treeFiles(revision, KNOWLEDGE_DIRECTORY))
      .filter((path) => path.endsWith('.md'))
    const knowledge = await Promise.all(knowledgePaths.map(async (path) => (
      parseKnowledgeStatement(path, await this.readTreeFile(revision, path))
    )))
    const titles = new Map<string, string>()
    for (const statement of knowledge) {
      const previous = titles.get(statement.title)
      if (previous) {
        throw new Error(`canonical title 重复：${statement.title}（${previous}、${statement.path}）`)
      }
      titles.set(statement.title, statement.path)
    }
    knowledge.sort((left, right) => left.title.localeCompare(right.title))
    const artifactPaths = (await this.treeFiles(revision, ARTIFACT_DIRECTORY))
      .filter((path) => !path.endsWith('/.gitkeep') && path !== `${ARTIFACT_DIRECTORY}/.gitkeep`)
    return { revision, knowledge, artifactPaths }
  }

  async recordMaintainerHandoff(
    workspace: CollaborationWorkspace,
    previousRevision: string
  ): Promise<MaintainerHandoff> {
    await this.assertClean(workspace.worktreePath, 'Maintainer')
    await this.assertWorkspace(workspace)
    const revision = await this.collaborationRevision(workspace)
    const parents = await this.commitParents(revision)
    if (parents.length !== 1 || parents[0] !== previousRevision) {
      throw new Error('Maintainer 必须在上一个 handoff revision 上增量提交一次')
    }
    const changedPaths = await this.changedPaths(previousRevision, revision)
    if (!changedPaths.length) throw new Error('Maintainer handoff commit 不能为空')
    const outside = changedPaths.find((path) => !allowedCollaborationPath(path))
    if (outside) throw new Error(`Maintainer 修改超出协作 Repository：${outside}`)
    if (!changedPaths.some((path) => (
      path.startsWith(`${KNOWLEDGE_DIRECTORY}/`)
      || path.startsWith(`${ARTIFACT_DIRECTORY}/`)
    ))) {
      throw new Error('Maintainer 没有修改 Knowledge 或 Artifact')
    }
    if (!await this.fileExists(revision, COLLABORATION_WORK_FILE)) {
      throw new Error('Maintainer 不得删除协作工作清单')
    }
    const workOrder = await this.readTreeFile(revision, COLLABORATION_WORK_FILE)
    if (hasPendingWork(workOrder)) throw new Error('Maintainer 提交时工作清单仍有未完成项')
    await this.assertNoReviewMarkers(revision)
    await this.revisionView(revision)
    return { previousRevision, revision, changedPaths }
  }

  async recordReviewerOutcome(
    workspace: CollaborationWorkspace,
    reviewedRevision: string
  ): Promise<ReviewerOutcome> {
    await this.assertClean(workspace.worktreePath, 'Reviewer')
    await this.assertWorkspace(workspace)
    const revision = await this.collaborationRevision(workspace)
    const parents = await this.commitParents(revision)
    if (parents.length !== 1 || parents[0] !== reviewedRevision) {
      throw new Error('Reviewer 必须在被审阅 revision 上增量提交一次')
    }
    const changedPaths = await this.changedPaths(reviewedRevision, revision)
    if (!changedPaths.length) throw new Error('Reviewer handoff commit 不能为空')
    const outside = changedPaths.find((path) => !allowedCollaborationPath(path))
    if (outside) throw new Error(`Reviewer 修改超出协作 Repository：${outside}`)
    const workOrderExists = await this.fileExists(revision, COLLABORATION_WORK_FILE)
    if (!workOrderExists) {
      if (changedPaths.length !== 1 || changedPaths[0] !== COLLABORATION_WORK_FILE) {
        throw new Error('Reviewer 批准 commit 只能删除协作工作清单')
      }
      await this.assertNoReviewMarkers(revision)
      await this.revisionView(revision)
      return { kind: 'approved', reviewedRevision, revision }
    }

    const markerPaths = await this.reviewMarkerPaths(revision)
    if (!markerPaths.length) throw new Error('Reviewer commit 没有包含 REVIEW 标记')
    for (const path of markerPaths) {
      const document = await this.readTreeFile(revision, path)
      if (!hasCompleteReviewMarkers(document)) {
        throw new Error(`REVIEW 标记格式不完整：${path}`)
      }
    }
    const workOrder = await this.readTreeFile(revision, COLLABORATION_WORK_FILE)
    if (!hasPendingWork(workOrder)) {
      throw new Error('Reviewer 提出修改时必须在工作清单中留下未完成项')
    }
    return {
      kind: 'changes_requested',
      reviewedRevision,
      revision,
      changedPaths,
      markerPaths
    }
  }

  async readWorkOrder(workspace: CollaborationWorkspace): Promise<string> {
    return readFile(repositoryChild(workspace.worktreePath, COLLABORATION_WORK_FILE), 'utf8')
  }
}

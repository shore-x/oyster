import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import {
  ARTIFACT_GIT_BINARY_PATH,
  createArtifactGitEnvironment
} from '../artifacts/git-runtime'
import {
  ARTIFACTS_DIRECTORY,
  KNOWLEDGE_DIRECTORY,
  OYSTER_TARGET_BRANCH,
  OysterRepository
} from '../repository/oyster-repository'

const execFileAsync = promisify(execFile)
export const RUN_WORK_FILE_NAME = 'WORK.md'

export const REVIEW_MARKER_START = '<<<<<<< REVIEW'
export const REVIEW_MARKER_COMMENT = '||||||| REVIEW COMMENT'
export const REVIEW_MARKER_END = '>>>>>>> REVIEW'

const REVIEW_MARKERS = [
  REVIEW_MARKER_START,
  REVIEW_MARKER_COMMENT,
  REVIEW_MARKER_END
] as const

export interface ProcessingRun {
  id: string
  repositoryPath: string
  runPath: string
  workPath: string
  targetBranch: string
  branchName: string
  baseRevision: string
}

export interface ProcessingWorkOrder {
  id?: string
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

function requiredRunId(value: unknown): string {
  const id = requiredText(value, 'Run ID')
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Run ID 格式无效')
  return id
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
  return [`- [ ] ${lines[0]}`, ...lines.slice(1).map((line) => `  ${line}`)].join('\n')
}

function serializeWorkOrder(id: string, input: ProcessingWorkOrder): string {
  if (!Array.isArray(input.items) || !input.items.length) {
    throw new Error('Run 工作清单不能为空')
  }
  return [
    `# Run ${id}`,
    '',
    'This file is the durable work state shared by the Maintainer and Reviewer.',
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
    '',
    '## Handoffs',
    '',
    'Maintainer and Reviewer append concise, role-named handoffs here.',
    ''
  ].join('\n')
}

function hasPendingWork(document: string): boolean {
  return /^\s*- \[ \]/m.test(document)
}

function approvalLine(revision: string): string {
  return `- [x] Reviewer approved revision ${revision}.`
}

function maintainerHandoffLine(revision: string): string {
  return `- [x] Maintainer handed off revision ${revision}.`
}

function reviewerChangesLine(revision: string): string {
  return `- [x] Reviewer requested changes in revision ${revision}.`
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

function allowedDomainPath(path: string): boolean {
  return path.startsWith(`${KNOWLEDGE_DIRECTORY}/`)
    || path.startsWith(`${ARTIFACTS_DIRECTORY}/`)
}

function nulDelimitedPaths(output: string): string[] {
  return output ? output.split('\0').filter(Boolean).sort() : []
}

/** Git handoffs over the single Oyster working tree; a Run owns only runs/<id>/. */
export class ProcessingRepository {
  readonly repositoryPath: string
  private readonly repository: OysterRepository

  constructor(repository: OysterRepository | string) {
    this.repository = typeof repository === 'string' ? new OysterRepository(repository) : repository
    this.repositoryPath = this.repository.rootPath
  }

  private async git(args: string[], trimOutput = true): Promise<string> {
    try {
      const { stdout } = await execFileAsync(ARTIFACT_GIT_BINARY_PATH, args, {
        cwd: this.repositoryPath,
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
    await this.repository.initialize()
    return this.git(['rev-parse', '--verify', OYSTER_TARGET_BRANCH])
  }

  async currentRevision(): Promise<string> {
    return this.git(['rev-parse', OYSTER_TARGET_BRANCH])
  }

  async runRevision(_run: ProcessingRun): Promise<string> {
    return this.git(['rev-parse', 'HEAD'])
  }

  async createRun(input: ProcessingWorkOrder): Promise<ProcessingRun> {
    await this.initialize()
    const baseRevision = await this.currentRevision()
    const id = requiredRunId(input.id ?? randomUUID())
    const branchName = `processing/${id}`
    await this.git(['checkout', '--quiet', OYSTER_TARGET_BRANCH])
    await this.git(['checkout', '--quiet', '-b', branchName, baseRevision])
    const runPath = repositoryChild(this.repository.runsPath, id)
    const workPath = join(runPath, RUN_WORK_FILE_NAME)
    await mkdir(runPath, { recursive: false })
    await writeFile(workPath, serializeWorkOrder(id, input), 'utf8')
    return {
      id,
      repositoryPath: this.repositoryPath,
      runPath,
      workPath,
      targetBranch: OYSTER_TARGET_BRANCH,
      branchName,
      baseRevision
    }
  }

  private async treeFiles(revision: string, path?: string): Promise<string[]> {
    const output = await this.git([
      'ls-tree', '-r', '-z', '--name-only', revision, ...(path ? ['--', path] : [])
    ])
    return nulDelimitedPaths(output)
  }

  private async readTreeFile(revision: string, path: string): Promise<string> {
    return this.git(['show', `${revision}:${path}`], false)
  }

  private async changedPaths(previousRevision: string, revision: string): Promise<string[]> {
    return nulDelimitedPaths(await this.git([
      'diff', '--name-only', '-z', previousRevision, revision
    ]))
  }

  async revisionChangedPaths(previousRevision: string, revision: string): Promise<string[]> {
    return this.changedPaths(previousRevision, revision)
  }

  private async commitParents(revision: string): Promise<string[]> {
    return (await this.git(['rev-list', '--parents', '-n', '1', revision])).split(' ').slice(1)
  }

  private async assertClean(label: string): Promise<void> {
    if (await this.git(['status', '--porcelain', '--untracked-files=all'])) {
      throw new Error(`${label} 工作区尚未提交全部修改`)
    }
  }

  private async assertRun(run: ProcessingRun): Promise<void> {
    const branch = await this.git(['branch', '--show-current'])
    if (branch !== run.branchName) throw new Error('Repository 没有停留在当前 Run 分支')
  }

  private async reviewMarkerPaths(revision: string): Promise<string[]> {
    const paths: string[] = []
    for (const path of await this.treeFiles(revision)) {
      if (!allowedDomainPath(path)) continue
      if (hasReviewMarker(await this.readTreeFile(revision, path))) paths.push(path)
    }
    return paths
  }

  private async assertNoReviewMarkers(revision: string): Promise<void> {
    const paths = await this.reviewMarkerPaths(revision)
    if (paths.length) throw new Error(`仍有未解决的 REVIEW 标记：${paths.join('、')}`)
  }

  private async appendHandoff(run: ProcessingRun, line: string): Promise<void> {
    const document = await this.readWorkOrder(run)
    if (document.includes(line)) return
    await writeFile(run.workPath, `${document.trimEnd()}\n\n${line}\n`, 'utf8')
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
    const artifactPaths = (await this.treeFiles(revision, ARTIFACTS_DIRECTORY))
      .filter((path) => path !== `${ARTIFACTS_DIRECTORY}/.gitkeep`)
    return { revision, knowledge, artifactPaths }
  }

  async recordMaintainerHandoff(
    run: ProcessingRun,
    previousRevision: string
  ): Promise<MaintainerHandoff> {
    await this.assertClean('Maintainer')
    await this.assertRun(run)
    const revision = await this.runRevision(run)
    const parents = await this.commitParents(revision)
    if (parents.length !== 1 || parents[0] !== previousRevision) {
      throw new Error('Maintainer 必须在上一个 handoff revision 上增量提交一次')
    }
    const changedPaths = await this.changedPaths(previousRevision, revision)
    if (!changedPaths.length) throw new Error('Maintainer handoff commit 不能为空')
    const outside = changedPaths.find((path) => !allowedDomainPath(path))
    if (outside) throw new Error(`Maintainer 修改超出 Knowledge/Artifact：${outside}`)
    const workOrder = await this.readWorkOrder(run)
    if (hasPendingWork(workOrder)) throw new Error('Maintainer 提交时工作清单仍有未完成项')
    await this.assertNoReviewMarkers(revision)
    await this.revisionView(revision)
    await this.appendHandoff(run, maintainerHandoffLine(revision))
    return { previousRevision, revision, changedPaths }
  }

  async recordReviewerOutcome(
    run: ProcessingRun,
    reviewedRevision: string
  ): Promise<ReviewerOutcome> {
    await this.assertClean('Reviewer')
    await this.assertRun(run)
    const revision = await this.runRevision(run)
    const workOrder = await this.readWorkOrder(run)
    if (revision === reviewedRevision) {
      if (hasPendingWork(workOrder)) throw new Error('Reviewer 批准时工作清单仍有未完成项')
      await this.assertNoReviewMarkers(revision)
      await this.revisionView(revision)
      await this.appendHandoff(run, approvalLine(reviewedRevision))
      return { kind: 'approved', reviewedRevision, revision }
    }

    const parents = await this.commitParents(revision)
    if (parents.length !== 1 || parents[0] !== reviewedRevision) {
      throw new Error('Reviewer 必须在被审阅 revision 上增量提交一次')
    }
    const changedPaths = await this.changedPaths(reviewedRevision, revision)
    if (!changedPaths.length) throw new Error('Reviewer handoff commit 不能为空')
    const outside = changedPaths.find((path) => !allowedDomainPath(path))
    if (outside) throw new Error(`Reviewer 修改超出 Knowledge/Artifact：${outside}`)
    const markerPaths = await this.reviewMarkerPaths(revision)
    if (!markerPaths.length) throw new Error('Reviewer commit 没有包含 REVIEW 标记')
    for (const path of markerPaths) {
      if (!hasCompleteReviewMarkers(await this.readTreeFile(revision, path))) {
        throw new Error(`REVIEW 标记格式不完整：${path}`)
      }
    }
    if (!hasPendingWork(workOrder)) {
      throw new Error('Reviewer 提出修改时必须在 WORK.md 中留下未完成项')
    }
    await this.appendHandoff(run, reviewerChangesLine(revision))
    return {
      kind: 'changes_requested',
      reviewedRevision,
      revision,
      changedPaths,
      markerPaths
    }
  }

  async readWorkOrder(run: ProcessingRun): Promise<string> {
    return readFile(run.workPath, 'utf8')
  }
}

export function reviewerApprovalLine(revision: string): string {
  return approvalLine(revision)
}

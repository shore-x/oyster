import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import {
  ARTIFACT_GIT_BINARY_PATH,
  createArtifactGitEnvironment
} from '../../src/main/artifacts/git-runtime'
import { parseKnowledgeStatementContent } from '../../src/shared/knowledge-reference'

const execFileAsync = promisify(execFile)
const KNOWLEDGE_DIRECTORY = 'knowledge'
const ARTIFACT_DIRECTORY = 'artifacts'
const TARGET_BRANCH = 'main'

export const REVIEW_MARKER_START = '<<<<<<< REVIEW'
export const REVIEW_MARKER_COMMENT = '||||||| REVIEW COMMENT'
export const REVIEW_MARKER_END = '>>>>>>> REVIEW'

const REVIEW_MARKERS = [
  REVIEW_MARKER_START,
  REVIEW_MARKER_COMMENT,
  REVIEW_MARKER_END
] as const

export interface PrototypeKnowledgeStatement {
  title: string
  content: string
}

export interface PrototypeCollaborationWorkspace {
  id: string
  repositoryPath: string
  worktreePath: string
  targetBranch: string
  branchName: string
  baseRevision: string
}

export interface PrototypeMaintainerHandoff {
  previousRevision: string
  revision: string
  changedPaths: string[]
}

export interface PrototypeChangesRequested {
  kind: 'changes_requested'
  reviewedRevision: string
  revision: string
  changedPaths: string[]
  markerPaths: string[]
}

export interface PrototypeAcceptedReview {
  kind: 'accepted'
  reviewedRevision: string
  mergeRevision: string
  targetBranch: string
}

export type PrototypeReviewerOutcome = PrototypeChangesRequested | PrototypeAcceptedReview

export interface PrototypeKnowledgeIndexEntry extends PrototypeKnowledgeStatement {
  path: string
}

export interface PrototypeReferenceIndexEntry {
  sourceTitle: string
  targetTitle: string
  resolved: boolean
}

export interface PrototypeArtifactIndexEntry {
  directoryName: string
  attention: string
  files: string[]
}

export interface PrototypeRevisionIndex {
  revision: string
  knowledge: PrototypeKnowledgeIndexEntry[]
  references: PrototypeReferenceIndexEntry[]
  artifacts: PrototypeArtifactIndexEntry[]
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 不能为空`)
  if (value.includes('\0')) throw new Error(`${label} 不能包含 NUL`)
  return value.trim()
}

function directName(value: unknown, label: string, suffix?: string): string {
  const name = requiredText(value, label)
  if (
    name !== value
    || name.startsWith('.')
    || name.includes('/')
    || name.includes('\\')
    || (suffix && !name.endsWith(suffix))
  ) {
    throw new Error(`${label} 无效`)
  }
  return name
}

function layerPath(rootPath: string, layer: string, relativePath: string): string {
  const root = resolve(rootPath, layer)
  const target = resolve(root, relativePath)
  const child = relative(root, target)
  if (!child || child.startsWith(`..${sep}`) || child === '..') {
    throw new Error('文件路径必须位于指定层级内')
  }
  return target
}

function serializeStatement(statement: PrototypeKnowledgeStatement): string {
  const title = requiredText(statement?.title, 'Knowledge title')
  if (title.includes('\n') || title.includes('\r')) {
    throw new Error('Knowledge title 必须位于单行 H1 中')
  }
  if (typeof statement?.content !== 'string' || !statement.content.trim()) {
    throw new Error('Knowledge content 不能为空')
  }
  const content = statement.content.endsWith('\n')
    ? statement.content
    : `${statement.content}\n`
  return `# ${title}\n\n${content}`
}

function parseStatement(path: string, document: string): PrototypeKnowledgeIndexEntry {
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

function isLayerPath(path: string): boolean {
  return path.startsWith(`${KNOWLEDGE_DIRECTORY}/`) || path.startsWith(`${ARTIFACT_DIRECTORY}/`)
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
  for (let index = 0; index < counts[0]; index++) {
    const start = document.indexOf(REVIEW_MARKER_START, offset)
    const comment = document.indexOf(REVIEW_MARKER_COMMENT, start + REVIEW_MARKER_START.length)
    const end = document.indexOf(REVIEW_MARKER_END, comment + REVIEW_MARKER_COMMENT.length)
    if (start < 0 || comment < 0 || end < 0) return false
    offset = end + REVIEW_MARKER_END.length
  }
  return true
}

/**
 * Independent prototype for one Git repository and one linear Agent collaboration branch.
 * It is intentionally not wired into the application or the current SQLite Store.
 */
export class UnifiedGitRepositoryPrototype {
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
        maxBuffer: 16 * 1024 * 1024
      })
      return trimOutput ? stdout.trimEnd() : stdout
    } catch (error) {
      const details = error as Error & { stderr?: string }
      const message = details.stderr?.trim() || details.message
      throw new Error(`Git 操作失败：${message}`, { cause: error })
    }
  }

  async initialize(): Promise<string> {
    await mkdir(this.repositoryPath, { recursive: true })
    try {
      return await this.git(['rev-parse', '--verify', 'HEAD'])
    } catch {
      await this.git(['init', '--quiet', `--initial-branch=${TARGET_BRANCH}`])
      await this.git(['config', 'user.name', 'Repository Prototype'])
      await this.git(['config', 'user.email', 'repository-prototype@local'])
      await mkdir(resolve(this.repositoryPath, KNOWLEDGE_DIRECTORY), { recursive: false })
      await mkdir(resolve(this.repositoryPath, ARTIFACT_DIRECTORY), { recursive: false })
      await Promise.all([
        writeFile(resolve(this.repositoryPath, KNOWLEDGE_DIRECTORY, '.gitkeep'), '', 'utf8'),
        writeFile(resolve(this.repositoryPath, ARTIFACT_DIRECTORY, '.gitkeep'), '', 'utf8')
      ])
      await this.git(['add', '--', KNOWLEDGE_DIRECTORY, ARTIFACT_DIRECTORY])
      await this.git(['commit', '--quiet', '--no-gpg-sign', '-m', 'Initialize unified repository'])
      return this.git(['rev-parse', 'HEAD'])
    }
  }

  async currentRevision(): Promise<string> {
    return this.git(['rev-parse', TARGET_BRANCH])
  }

  async collaborationRevision(workspace: PrototypeCollaborationWorkspace): Promise<string> {
    return this.git(['rev-parse', 'HEAD'], workspace.worktreePath)
  }

  async createCollaboration(): Promise<PrototypeCollaborationWorkspace> {
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
    return {
      id,
      repositoryPath: this.repositoryPath,
      worktreePath,
      targetBranch: TARGET_BRANCH,
      branchName,
      baseRevision
    }
  }

  async writeKnowledgeStatement(
    workspace: PrototypeCollaborationWorkspace,
    fileNameInput: string,
    statement: PrototypeKnowledgeStatement
  ): Promise<string> {
    const fileName = directName(fileNameInput, 'Knowledge 文件名', '.md')
    const path = layerPath(workspace.worktreePath, KNOWLEDGE_DIRECTORY, fileName)
    await writeFile(path, serializeStatement(statement), 'utf8')
    return path
  }

  async createArtifact(
    workspace: PrototypeCollaborationWorkspace,
    directoryNameInput: string,
    attentionInput: string
  ): Promise<string> {
    const directoryName = directName(directoryNameInput, 'Artifact 目录名')
    const attention = requiredText(attentionInput, 'Artifact Attention')
    const artifactPath = layerPath(workspace.worktreePath, ARTIFACT_DIRECTORY, directoryName)
    await mkdir(artifactPath, { recursive: false })
    await writeFile(resolve(artifactPath, 'AGENTS.md'), `# Attention\n\n${attention}\n`, 'utf8')
    return artifactPath
  }

  async writeArtifactFile(
    workspace: PrototypeCollaborationWorkspace,
    directoryNameInput: string,
    relativePathInput: string,
    content: string
  ): Promise<string> {
    const directoryName = directName(directoryNameInput, 'Artifact 目录名')
    const relativePath = requiredText(relativePathInput, 'Artifact 文件路径')
    const artifactRoot = layerPath(workspace.worktreePath, ARTIFACT_DIRECTORY, directoryName)
    const path = layerPath(artifactRoot, '.', relativePath)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, 'utf8')
    return path
  }

  private async treeFiles(revision: string, layer: string): Promise<string[]> {
    const output = await this.git(['ls-tree', '-r', '--name-only', revision, '--', layer])
    return output ? output.split('\n').filter(Boolean).sort() : []
  }

  private async layerTreeFiles(revision: string): Promise<string[]> {
    const files = await Promise.all([
      this.treeFiles(revision, KNOWLEDGE_DIRECTORY),
      this.treeFiles(revision, ARTIFACT_DIRECTORY)
    ])
    return files.flat().sort()
  }

  private async readTreeFile(revision: string, path: string): Promise<string> {
    return this.git(['show', `${revision}:${path}`], this.repositoryPath, false)
  }

  private async changedPaths(previousRevision: string, revision: string): Promise<string[]> {
    const output = await this.git([
      'diff',
      '--name-only',
      previousRevision,
      revision,
      '--',
      KNOWLEDGE_DIRECTORY,
      ARTIFACT_DIRECTORY
    ])
    return output ? output.split('\n').filter(Boolean).sort() : []
  }

  private async allChangedPaths(previousRevision: string, revision: string): Promise<string[]> {
    const output = await this.git(['diff', '--name-only', previousRevision, revision])
    return output ? output.split('\n').filter(Boolean).sort() : []
  }

  private async commitParents(revision: string): Promise<string[]> {
    const line = await this.git(['rev-list', '--parents', '-n', '1', revision])
    return line.split(' ').slice(1)
  }

  private async assertClean(cwd: string, label: string): Promise<void> {
    const status = await this.git(['status', '--porcelain', '--untracked-files=all'], cwd)
    if (status) throw new Error(`${label} 工作区尚未提交全部修改`)
  }

  private async assertCollaborationBranch(workspace: PrototypeCollaborationWorkspace): Promise<void> {
    const branch = await this.git(['branch', '--show-current'], workspace.worktreePath)
    if (branch !== workspace.branchName) throw new Error('协作 worktree 没有停留在绑定分支')
  }

  private async reviewMarkerPaths(revision: string): Promise<string[]> {
    const paths: string[] = []
    for (const path of await this.layerTreeFiles(revision)) {
      const content = await this.readTreeFile(revision, path)
      if (hasReviewMarker(content)) paths.push(path)
    }
    return paths
  }

  private async assertNoReviewMarkers(revision: string): Promise<void> {
    const paths = await this.reviewMarkerPaths(revision)
    if (paths.length) throw new Error(`仍有未解决的 REVIEW 标记：${paths.join('、')}`)
  }

  async buildIndex(revisionInput: string): Promise<PrototypeRevisionIndex> {
    const revision = await this.git(['rev-parse', '--verify', revisionInput])
    const knowledgePaths = (await this.treeFiles(revision, KNOWLEDGE_DIRECTORY))
      .filter((path) => path.endsWith('.md'))
    const knowledge = await Promise.all(knowledgePaths.map(async (path) => (
      parseStatement(path, await this.readTreeFile(revision, path))
    )))
    const byTitle = new Map<string, PrototypeKnowledgeIndexEntry>()
    for (const statement of knowledge) {
      const previous = byTitle.get(statement.title)
      if (previous) {
        throw new Error(
          `canonical title 重复：${statement.title}（${previous.path}、${statement.path}）`
        )
      }
      byTitle.set(statement.title, statement)
    }

    knowledge.sort((left, right) => left.title.localeCompare(right.title))
    const references = knowledge.flatMap((statement) => (
      parseKnowledgeStatementContent(statement.content).flatMap((part) => (
        part.kind === 'reference'
          ? [{
              sourceTitle: statement.title,
              targetTitle: part.targetTitle,
              resolved: byTitle.has(part.targetTitle)
            }]
          : []
      ))
    ))

    const artifactPaths = await this.treeFiles(revision, ARTIFACT_DIRECTORY)
    const artifactFiles = new Map<string, string[]>()
    for (const path of artifactPaths) {
      const parts = path.split('/')
      if (parts.length < 3 || parts[1].startsWith('.')) continue
      const files = artifactFiles.get(parts[1]) ?? []
      files.push(parts.slice(2).join('/'))
      artifactFiles.set(parts[1], files)
    }
    const artifacts = await Promise.all([...artifactFiles.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(async ([directoryName, files]): Promise<PrototypeArtifactIndexEntry> => {
        if (!files.includes('AGENTS.md')) {
          throw new Error(`Artifact 缺少根 AGENTS.md：${directoryName}`)
        }
        return {
          directoryName,
          attention: await this.readTreeFile(
            revision,
            `${ARTIFACT_DIRECTORY}/${directoryName}/AGENTS.md`
          ),
          files: files.sort()
        }
      }))

    return { revision, knowledge, references, artifacts }
  }

  async recordMaintainerHandoff(
    workspace: PrototypeCollaborationWorkspace,
    previousRevision: string
  ): Promise<PrototypeMaintainerHandoff> {
    await this.assertClean(workspace.worktreePath, 'Maintainer')
    await this.assertCollaborationBranch(workspace)
    if (await this.currentRevision() !== workspace.baseRevision) {
      throw new Error('目标分支已经离开协作 base')
    }
    const revision = await this.collaborationRevision(workspace)
    const parents = await this.commitParents(revision)
    if (parents.length !== 1 || parents[0] !== previousRevision) {
      throw new Error('Maintainer 必须在上一个 handoff commit 上增量提交一次')
    }
    const allChangedPaths = await this.allChangedPaths(previousRevision, revision)
    if (!allChangedPaths.length) throw new Error('Maintainer handoff commit 不能为空')
    const outsideLayer = allChangedPaths.find((path) => !isLayerPath(path))
    if (outsideLayer) throw new Error(`Maintainer 修改超出两个权威层：${outsideLayer}`)
    await this.assertNoReviewMarkers(revision)
    await this.buildIndex(revision)
    return {
      previousRevision,
      revision,
      changedPaths: await this.changedPaths(previousRevision, revision)
    }
  }

  async recordReviewerOutcome(
    workspace: PrototypeCollaborationWorkspace,
    reviewedRevision: string
  ): Promise<PrototypeReviewerOutcome> {
    await this.assertClean(workspace.worktreePath, 'Reviewer')
    await this.assertClean(this.repositoryPath, '目标分支')
    await this.assertCollaborationBranch(workspace)
    const branchRevision = await this.collaborationRevision(workspace)
    const targetRevision = await this.currentRevision()

    if (targetRevision !== workspace.baseRevision) {
      if (branchRevision !== reviewedRevision) {
        throw new Error('Reviewer merge 之后协作分支又发生了变化')
      }
      const parents = await this.commitParents(targetRevision)
      if (
        parents.length !== 2
        || parents[0] !== workspace.baseRevision
        || parents[1] !== reviewedRevision
      ) {
        throw new Error('目标分支没有通过预期的 Reviewer merge commit 前进')
      }
      const mergeChangedPaths = await this.allChangedPaths(reviewedRevision, targetRevision)
      if (mergeChangedPaths.length) {
        throw new Error('Reviewer merge tree 与被审阅 revision 不一致')
      }
      await this.assertNoReviewMarkers(targetRevision)
      await this.buildIndex(targetRevision)
      return {
        kind: 'accepted',
        reviewedRevision,
        mergeRevision: targetRevision,
        targetBranch: workspace.targetBranch
      }
    }

    if (branchRevision === reviewedRevision) {
      throw new Error('Reviewer 既没有提交问题标记，也没有合并协作分支')
    }
    const parents = await this.commitParents(branchRevision)
    if (parents.length !== 1 || parents[0] !== reviewedRevision) {
      throw new Error('Reviewer 必须在被审阅 revision 上增量提交一次')
    }
    const allChangedPaths = await this.allChangedPaths(reviewedRevision, branchRevision)
    const outsideLayer = allChangedPaths.find((path) => !isLayerPath(path))
    if (outsideLayer) throw new Error(`Reviewer 修改超出两个权威层：${outsideLayer}`)
    const markerPaths = await this.reviewMarkerPaths(branchRevision)
    if (!markerPaths.length) throw new Error('Reviewer commit 没有包含 REVIEW 标记')
    for (const path of markerPaths) {
      const content = await this.readTreeFile(branchRevision, path)
      if (!hasCompleteReviewMarkers(content)) {
        throw new Error(`REVIEW 标记格式不完整：${path}`)
      }
    }
    return {
      kind: 'changes_requested',
      reviewedRevision,
      revision: branchRevision,
      changedPaths: allChangedPaths,
      markerPaths
    }
  }
}

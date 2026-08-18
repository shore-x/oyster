import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type {
  KnowledgeTaskDefinition
} from '../../shared/knowledge-processing'
import {
  ARTIFACT_GIT_BINARY_PATH,
  createArtifactGitEnvironment
} from '../artifacts/git-runtime'
import {
  ARTIFACTS_DIRECTORY,
  KNOWLEDGE_DIRECTORY,
  OYSTER_TARGET_BRANCH,
  TASKS_DIRECTORY,
  OysterRepository
} from '../repository/oyster-repository'
import type {
  KnowledgeTaskInputPlan,
  TaskInputFile
} from './task-input'
import {
  normalizeSourceConversationSummary,
  normalizeStartKnowledgeTaskInput
} from './source-snapshot'

const execFileAsync = promisify(execFile)
export const TASK_FILE_NAME = 'TASK.md'
export const TASK_RECORD_FILE_NAME = 'task.json'

export const REVIEW_MARKER_START = '<<<<<<< REVIEW'
export const REVIEW_MARKER_COMMENT = '||||||| REVIEW COMMENT'
export const REVIEW_MARKER_END = '>>>>>>> REVIEW'

const REVIEW_MARKERS = [
  REVIEW_MARKER_START,
  REVIEW_MARKER_COMMENT,
  REVIEW_MARKER_END
] as const

export interface KnowledgeTaskWorktree {
  taskId: string
  /** The user-owned main checkout. Agents never use it as their cwd. */
  repositoryPath: string
  /** The linked checkout owned by this Task. */
  worktreePath: string
  /** Runtime-only Pi state outside Git. */
  runtimePath: string
  taskPath: string
  inputPath: string
  targetBranch: string
  branchName: string
  baseRepositoryRevision: string
}

export interface CreateKnowledgeTaskWorktreeInput {
  taskId?: string
  plan: KnowledgeTaskInputPlan
  kind?: 'task' | 'preview'
  taskDefinition?: KnowledgeTaskDefinition
}

export interface KnowledgeTaskGitRepositoryOptions {
  worktreesPath?: string
  runtimePath?: string
}

export interface MaintainerHandoff {
  previousRepositoryRevision: string
  candidateRepositoryRevision: string
  changedPaths: string[]
}

export interface ChangesRequested {
  kind: 'changes_requested'
  reviewedRepositoryRevision: string
  candidateRepositoryRevision: string
  changedPaths: string[]
  markerPaths: string[]
}

export interface ApprovedReview {
  kind: 'approved'
  reviewedRepositoryRevision: string
  candidateRepositoryRevision: string
  integratedRepositoryRevision: string
}

export type ReviewDecision = ChangesRequested | ApprovedReview

export interface RepositoryKnowledgeStatement {
  path: string
  title: string
  content: string
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 不能为空`)
  if (value.includes('\0')) throw new Error(`${label} 不能包含 NUL`)
  return value.trim()
}

function requiredTaskId(value: unknown): string {
  const taskId = requiredText(value, 'Task ID')
  if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) throw new Error('Task ID 格式无效')
  return taskId
}

/** Reads both the immutable v3 summary and the useful definition fields from old records. */
export function parseKnowledgeTaskDefinition(
  value: unknown,
  expectedTaskId: string
): KnowledgeTaskDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Knowledge Task 摘要格式无效：${expectedTaskId}`)
  }
  const record = value as Partial<KnowledgeTaskDefinition> & {
    formatVersion?: unknown
    sourceRef?: unknown
    result?: { sourceRef?: unknown }
  }
  const taskId = requiredTaskId(record.taskId)
  if (taskId !== expectedTaskId || ![1, 2, 3].includes(Number(record.formatVersion))) {
    throw new Error(`Knowledge Task 摘要格式无效：${expectedTaskId}`)
  }
  if (!record.input || !record.configuration?.maintainer || !record.configuration.reviewer) {
    throw new Error(`Knowledge Task 摘要缺少定义：${expectedTaskId}`)
  }
  const sourceRef = record.sourceRef ?? record.result?.sourceRef ?? `legacy:task:${taskId}`
  return {
    formatVersion: 3,
    taskId,
    startedAt: requiredText(record.startedAt, 'Task startedAt'),
    input: normalizeStartKnowledgeTaskInput(record.input),
    sourceRef: requiredText(sourceRef, 'Source reference'),
    ...(record.sourceConversation
      ? { sourceConversation: normalizeSourceConversationSummary(record.sourceConversation) }
      : {}),
    configuration: {
      maintainer: {
        connectionId: requiredText(record.configuration.maintainer.connectionId, 'Maintainer connectionId'),
        modelId: requiredText(record.configuration.maintainer.modelId, 'Maintainer modelId'),
        ...(record.configuration.maintainer.reasoningEffort
          ? { reasoningEffort: record.configuration.maintainer.reasoningEffort }
          : {})
      },
      reviewer: {
        connectionId: requiredText(record.configuration.reviewer.connectionId, 'Reviewer connectionId'),
        modelId: requiredText(record.configuration.reviewer.modelId, 'Reviewer modelId'),
        ...(record.configuration.reviewer.reasoningEffort
          ? { reasoningEffort: record.configuration.reviewer.reasoningEffort }
          : {})
      }
    }
  }
}

function childPath(rootPath: string, relativePath: string): string {
  const root = resolve(rootPath)
  const target = resolve(root, relativePath)
  const child = relative(root, target)
  if (!child || child === '..' || child.startsWith(`..${sep}`)) {
    throw new Error('Repository 文件路径无效')
  }
  return target
}

function validateTaskRelativePath(value: string): string {
  const path = requiredText(value, 'Task 文件路径')
  if (
    path.includes('\\')
    || path.startsWith('/')
    || path.split('/').some((part) => !part || part === '.' || part === '..')
  ) throw new Error(`Task 文件路径无效：${path}`)
  return path
}

function markdownChecklistItem(value: string): string {
  const lines = requiredText(value, '工作项').split(/\r?\n/)
  return [`- [ ] ${lines[0]}`, ...lines.slice(1).map((line) => `  ${line}`)].join('\n')
}

function serializeTask(input: CreateKnowledgeTaskWorktreeInput): string {
  if (!Array.isArray(input.plan.items) || !input.plan.items.length) {
    throw new Error('Task 工作清单不能为空')
  }
  return [
    '# Task',
    '',
    '## Checklist',
    '',
    ...input.plan.items.map(markdownChecklistItem),
    '',
    '## Knowledge–Evidence',
    '',
    'Maintainer records how each Knowledge change relates to Raw Evidence or existing Knowledge here.',
    '',
    '## Handoffs',
    '',
    'Maintainer and Reviewer append concise role-named handoffs here.',
    ''
  ].join('\n')
}

function taskFiles(files: readonly TaskInputFile[]): TaskInputFile[] {
  const result: TaskInputFile[] = files.map((file) => ({
    relativePath: validateTaskRelativePath(file.relativePath),
    content: file.content
  }))
  const paths = new Set<string>()
  for (const file of result) {
    if (!file.relativePath.startsWith('inputs/')) {
      throw new Error(`Task 输入文件必须位于 inputs/：${file.relativePath}`)
    }
    if (paths.has(file.relativePath)) throw new Error(`Task 文件路径重复：${file.relativePath}`)
    paths.add(file.relativePath)
  }
  return result
}

function hasPendingWork(document: string): boolean {
  return /^\s*- \[ \]/m.test(document)
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

function nulDelimitedPaths(output: string): string[] {
  return output ? output.split('\0').filter(Boolean).sort() : []
}

/** Git-backed Task records with one external linked worktree per concurrent writer. */
export class KnowledgeTaskGitRepository {
  readonly repositoryPath: string
  readonly worktreesPath: string
  readonly runtimePath: string
  private readonly repository: OysterRepository
  private worktreeMutationQueue: Promise<void> = Promise.resolve()

  constructor(
    repository: OysterRepository | string,
    options: KnowledgeTaskGitRepositoryOptions = {}
  ) {
    this.repository = typeof repository === 'string' ? new OysterRepository(repository) : repository
    this.repositoryPath = this.repository.rootPath
    const userDataPath = dirname(this.repositoryPath)
    this.worktreesPath = resolve(options.worktreesPath ?? join(userDataPath, 'worktrees'))
    this.runtimePath = resolve(options.runtimePath ?? join(userDataPath, 'agent-runtime'))
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

  private async gitSucceeds(args: string[], cwd: string): Promise<boolean> {
    try {
      await execFileAsync(ARTIFACT_GIT_BINARY_PATH, args, {
        cwd,
        env: createArtifactGitEnvironment(),
        maxBuffer: 16 * 1_024 * 1_024
      })
      return true
    } catch {
      return false
    }
  }

  async initialize(): Promise<string> {
    await this.repository.initialize()
    await Promise.all([
      mkdir(this.worktreesPath, { recursive: true }),
      mkdir(this.runtimePath, { recursive: true })
    ])
    return this.git(['rev-parse', '--verify', OYSTER_TARGET_BRANCH])
  }

  async currentRevision(): Promise<string> {
    return this.git(['rev-parse', OYSTER_TARGET_BRANCH])
  }

  private async removeOwnedWorktree(
    worktreePath: string,
    runtimePath: string,
    branchName: string,
    force: boolean
  ): Promise<void> {
    await this.git([
      'worktree', 'remove', ...(force ? ['--force'] : []), worktreePath
    ])
    await rm(runtimePath, { recursive: true, force: true })
    // Completed Task refs own their exact durable history projection. Preview refs are disposable.
    if (force) await this.git(['branch', '-D', branchName])
  }

  /** Reclaims a clean Task checkout only after its exact branch tip is part of main. */
  releaseCompletedWorktree(worktree: KnowledgeTaskWorktree): Promise<void> {
    const release = async (): Promise<void> => {
      this.assertWorktreeCoordinates(worktree)
      await this.assertWorktree(worktree)
      await this.assertWorktreeBranch(worktree)
      if (await this.worktreeStatus(worktree)) {
        throw new Error('已完成 Task 的 worktree 仍有未提交变化，拒绝清理')
      }
      const integrated = await this.gitSucceeds([
        'merge-base', '--is-ancestor', worktree.branchName, OYSTER_TARGET_BRANCH
      ], this.repositoryPath)
      if (!integrated) throw new Error('Task branch 尚未进入 main，拒绝清理')
      await this.removeOwnedWorktree(
        worktree.worktreePath,
        worktree.runtimePath,
        worktree.branchName,
        false
      )
    }
    const result = this.worktreeMutationQueue.then(release, release)
    this.worktreeMutationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  /** Startup cleanup for completed Tasks and disposable Previews left by an earlier process. */
  cleanupInactiveWorktrees(): Promise<string[]> {
    const cleanup = async (): Promise<string[]> => {
      await this.initialize()
      const cleaned: string[] = []
      const entries = await readdir(this.worktreesPath, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-zA-Z0-9_-]+$/.test(entry.name)) {
          continue
        }
        const taskId = entry.name
        const worktreePath = childPath(this.worktreesPath, taskId)
        const runtimePath = childPath(this.runtimePath, taskId)
        if (!await this.gitSucceeds(['rev-parse', '--is-inside-work-tree'], worktreePath)) continue
        const branchName = await this.git(['branch', '--show-current'], worktreePath)
        const kind = branchName === `task/${taskId}`
          ? 'task'
          : branchName === `preview/${taskId}` ? 'preview' : undefined
        if (!kind) continue
        if (kind === 'task') {
          const status = await this.git([
            'status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'
          ], worktreePath)
          if (status || !await this.gitSucceeds([
            'merge-base', '--is-ancestor', branchName, OYSTER_TARGET_BRANCH
          ], this.repositoryPath)) continue
        }
        await this.removeOwnedWorktree(
          worktreePath,
          runtimePath,
          branchName,
          kind === 'preview'
        )
        cleaned.push(taskId)
      }
      return cleaned
    }
    const result = this.worktreeMutationQueue.then(cleanup, cleanup)
    this.worktreeMutationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  createWorktree(input: CreateKnowledgeTaskWorktreeInput): Promise<KnowledgeTaskWorktree> {
    const result = this.worktreeMutationQueue.then(
      () => this.createWorktreeNow(input),
      () => this.createWorktreeNow(input)
    )
    this.worktreeMutationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  private async createWorktreeNow(
    input: CreateKnowledgeTaskWorktreeInput
  ): Promise<KnowledgeTaskWorktree> {
    await this.initialize()
    const repositoryRevision = await this.currentRevision()
    const taskId = requiredTaskId(input.taskId ?? randomUUID())
    const kind = input.kind ?? (input.taskDefinition ? 'task' : 'preview')
    if (kind === 'task' && (!input.taskDefinition || input.taskDefinition.taskId !== taskId)) {
      throw new Error('Knowledge Processing Task 缺少初始 task.json')
    }
    if (kind === 'preview' && input.taskDefinition) {
      throw new Error('Agent Preview 不得包含 Knowledge Processing Task 定义')
    }
    const branchName = `${kind}/${taskId}`
    const worktreePath = childPath(this.worktreesPath, taskId)
    const runtimePath = childPath(this.runtimePath, taskId)
    const taskPath = childPath(worktreePath, `${TASKS_DIRECTORY}/${taskId}`)
    const inputPath = join(taskPath, 'inputs')

    await this.git([
      'worktree', 'add', '--quiet', '-b', branchName, worktreePath, repositoryRevision
    ])
    await mkdir(runtimePath, { recursive: true })
    await mkdir(taskPath, { recursive: true })
    const files = taskFiles(input.plan.files)
    for (const file of files) {
      const path = childPath(taskPath, file.relativePath)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, file.content, { flag: 'wx' })
    }
    await writeFile(join(taskPath, TASK_FILE_NAME), serializeTask(input), 'utf8')
    const taskSummaryDocument = input.taskDefinition
      ? `${JSON.stringify(input.taskDefinition, null, 2)}\n`
      : undefined
    if (taskSummaryDocument) {
      await writeFile(
        join(taskPath, TASK_RECORD_FILE_NAME),
        taskSummaryDocument,
        'utf8'
      )
      await this.git([
        'add', '--force', '--', `${TASKS_DIRECTORY}/${taskId}`
      ], worktreePath)
      await this.git([
        'commit', '--quiet', '--no-gpg-sign', '-m', `Accept Knowledge Processing Task ${taskId}`
      ], worktreePath)
    }
    const baseRepositoryRevision = await this.git(['rev-parse', 'HEAD'], worktreePath)

    const provisional: KnowledgeTaskWorktree = {
      taskId,
      repositoryPath: this.repositoryPath,
      worktreePath,
      runtimePath,
      taskPath,
      inputPath,
      targetBranch: OYSTER_TARGET_BRANCH,
      branchName,
      baseRepositoryRevision
    }
    return provisional
  }

  private assertWorktreeCoordinates(worktree: KnowledgeTaskWorktree): void {
    const taskId = requiredTaskId(worktree.taskId)
    const expectedWorktreePath = childPath(this.worktreesPath, taskId)
    const expectedRuntimePath = childPath(this.runtimePath, taskId)
    const expectedTaskPath = childPath(expectedWorktreePath, `${TASKS_DIRECTORY}/${taskId}`)
    if (
      resolve(worktree.repositoryPath) !== resolve(this.repositoryPath)
      || resolve(worktree.worktreePath) !== expectedWorktreePath
      || resolve(worktree.runtimePath) !== expectedRuntimePath
      || resolve(worktree.taskPath) !== expectedTaskPath
      || resolve(worktree.inputPath) !== join(expectedTaskPath, 'inputs')
      || !['task', 'preview'].some((kind) => worktree.branchName === `${kind}/${taskId}`)
      || worktree.targetBranch !== OYSTER_TARGET_BRANCH
      || !/^[a-f0-9]{40,64}$/i.test(worktree.baseRepositoryRevision)
    ) throw new Error('Knowledge Processing Task 文件坐标无效')
  }

  async assertWorktree(worktree: KnowledgeTaskWorktree): Promise<void> {
    this.assertWorktreeCoordinates(worktree)
    const required = [worktree.worktreePath, worktree.taskPath, worktree.inputPath]
    for (const path of required) {
      const details = await lstat(path)
      if (!details.isDirectory() || details.isSymbolicLink()) {
        throw new Error('Knowledge Processing Task 目录无效')
      }
    }
    const taskFile = await lstat(join(worktree.taskPath, TASK_FILE_NAME))
    if (!taskFile.isFile() || taskFile.isSymbolicLink()) {
      throw new Error('Knowledge Processing Task 文件无效')
    }
  }

  private async assertWorktreeBranch(worktree: KnowledgeTaskWorktree): Promise<void> {
    const branch = await this.git(['branch', '--show-current'], worktree.worktreePath)
    if (branch !== worktree.branchName) throw new Error('Task worktree 没有停留在所属分支')
  }

  private async worktreeStatus(worktree: KnowledgeTaskWorktree): Promise<string> {
    return this.git([
      'status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'
    ], worktree.worktreePath)
  }

  async taskStartRevision(taskId: string, revision: string): Promise<string> {
    const path = `${TASKS_DIRECTORY}/${requiredTaskId(taskId)}/${TASK_RECORD_FILE_NAME}`
    const start = (await this.git([
      'log', '--reverse', '--diff-filter=A', '--format=%H', revision, '--', path
    ])).split(/\r?\n/).find(Boolean)
    if (!start) throw new Error(`Task branch 缺少初始 ${TASK_RECORD_FILE_NAME}`)
    return start
  }

  private async assertFixedTaskInput(
    worktree: KnowledgeTaskWorktree,
    revision: string
  ): Promise<void> {
    const taskId = requiredTaskId(worktree.taskId)
    const taskPath = `${TASKS_DIRECTORY}/${taskId}`
    const path = `${taskPath}/${TASK_RECORD_FILE_NAME}`
    const start = await this.taskStartRevision(taskId, revision)
    if (start !== worktree.baseRepositoryRevision) {
      throw new Error('Agent 不得改写 Host 创建的 Task-start commit')
    }
    const current = await this.readTreeFile(revision, path)
    parseKnowledgeTaskDefinition(JSON.parse(current), taskId)
    const fixedPaths = [
      `${taskPath}/inputs`,
      path
    ]
    if (!await this.gitSucceeds([
      'diff', '--quiet', start, revision, '--', ...fixedPaths
    ], worktree.worktreePath)) {
      throw new Error('Agent 不得修改 Task-start commit 固定的输入')
    }
    const introducedCommits = (await this.git([
      'rev-list', '--parents', revision, `^${start}^`
    ]))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.split(' '))
    for (const [commit, firstParent] of introducedCommits) {
      if (commit === start) continue
      const preservesFixedInput = firstParent
        ? await this.gitSucceeds([
            'diff', '--quiet', firstParent, commit, '--', ...fixedPaths
          ], worktree.worktreePath)
        : await this.gitSucceeds([
            'diff-tree', '--quiet', '--root', '-r', commit, '--', ...fixedPaths
          ], worktree.worktreePath)
      if (!preservesFixedInput) {
        throw new Error('Agent 不得修改 Task-start commit 固定的输入')
      }
    }
  }

  /** Reads the Agent-owned Task branch after an Invocation has finished. */
  async inspectAgentCommit(
    worktree: KnowledgeTaskWorktree,
    previousRevision: string
  ): Promise<MaintainerHandoff> {
    await this.assertWorktree(worktree)
    await this.assertWorktreeBranch(worktree)
    const status = await this.worktreeStatus(worktree)
    if (status) throw new Error('Agent 结束前必须提交 Task worktree 中的全部预期变化')
    const revision = await this.git(['rev-parse', 'HEAD'], worktree.worktreePath)
    if (revision === previousRevision) throw new Error('Agent 没有创建新的 Task commit')
    if (!await this.gitSucceeds(
      ['merge-base', '--is-ancestor', previousRevision, revision],
      worktree.worktreePath
    )) throw new Error('Agent commit 不属于当前 Task 历史')
    if (worktree.branchName.startsWith('task/')) {
      await this.assertFixedTaskInput(worktree, revision)
    }
    await this.validateRevision(revision)
    return {
      previousRepositoryRevision: previousRevision,
      candidateRepositoryRevision: revision,
      changedPaths: await this.changedPaths(previousRevision, revision)
    }
  }

  /** Reads Reviewer-owned commits and derives approval only after Agent promotion reached main. */
  async inspectReview(
    worktree: KnowledgeTaskWorktree,
    reviewedRevision: string,
    targetRevisionBeforeReview: string
  ): Promise<ReviewDecision> {
    await this.assertWorktree(worktree)
    await this.assertWorktreeBranch(worktree)
    const status = await this.worktreeStatus(worktree)
    if (status) throw new Error('Reviewer 结束前必须提交全部审阅变化')
    const taskRevision = await this.git(['rev-parse', 'HEAD'], worktree.worktreePath)
    const preservesReviewedRevision = await this.gitSucceeds(
      ['merge-base', '--is-ancestor', reviewedRevision, taskRevision],
      worktree.worktreePath
    )
    if (!preservesReviewedRevision) {
      throw new Error('Reviewer 结果必须保留已审阅的 Task revision')
    }
    const firstParentHistory = (await this.git([
      'rev-list', '--first-parent', taskRevision
    ], worktree.worktreePath)).split(/\r?\n/)
    if (!firstParentHistory.includes(reviewedRevision)) {
      throw new Error('Reviewer 必须在已审阅的 Task first-parent 历史上继续工作')
    }
    await this.assertFixedTaskInput(worktree, taskRevision)
    const pending = hasPendingWork(await this.readTreeFile(
      taskRevision,
      `${TASKS_DIRECTORY}/${worktree.taskId}/${TASK_FILE_NAME}`
    ))
    const markerPaths = await this.reviewMarkerPaths(taskRevision)
    if (pending || markerPaths.length) {
      if (taskRevision === reviewedRevision) {
        throw new Error('Reviewer 要求修改时必须在当前 Task 历史中创建 commit')
      }
      return {
        kind: 'changes_requested',
        reviewedRepositoryRevision: reviewedRevision,
        candidateRepositoryRevision: taskRevision,
        changedPaths: await this.changedPaths(reviewedRevision, taskRevision),
        markerPaths
      }
    }
    if (!await this.gitSucceeds(
      ['merge-base', '--is-ancestor', targetRevisionBeforeReview, taskRevision],
      worktree.worktreePath
    )) throw new Error('Reviewer 批准结果必须包含审阅开始时的目标分支 revision')
    const targetRevision = await this.git(['rev-parse', OYSTER_TARGET_BRANCH])
    if (targetRevision !== taskRevision) {
      throw new Error('Reviewer 批准后必须将精确 Task revision 快进合并到目标分支')
    }
    const checkedOutBranch = await this.git(['branch', '--show-current'], this.repositoryPath)
    const checkedOutHead = await this.git(['rev-parse', 'HEAD'], this.repositoryPath)
    const mainStatus = await this.git([
      'status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'
    ], this.repositoryPath)
    if (
      checkedOutBranch !== OYSTER_TARGET_BRANCH
      || checkedOutHead !== targetRevision
      || mainStatus
    ) throw new Error('Reviewer promotion 后主 checkout 必须与目标分支同步且 clean')
    await this.validateRevision(taskRevision)
    return {
      kind: 'approved',
      reviewedRepositoryRevision: reviewedRevision,
      candidateRepositoryRevision: taskRevision,
      integratedRepositoryRevision: targetRevision
    }
  }

  /** Pure read: the Runtime presents the Task branch as-is and never checkpoints Agent changes. */
  async prepareAgentTurn(
    worktree: KnowledgeTaskWorktree,
    expectedTaskRevision: string
  ): Promise<string> {
    await this.assertWorktree(worktree)
    await this.assertWorktreeBranch(worktree)
    const head = await this.git(['rev-parse', 'HEAD'], worktree.worktreePath)
    if (head !== expectedTaskRevision) throw new Error('Agent 输入 revision 已不是当前 Task HEAD')
    if (worktree.branchName.startsWith('task/')) {
      const fixedInputStatus = await this.git([
        'status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none', '--',
        `${TASKS_DIRECTORY}/${worktree.taskId}/inputs`,
        `${TASKS_DIRECTORY}/${worktree.taskId}/${TASK_RECORD_FILE_NAME}`
      ], worktree.worktreePath)
      if (fixedInputStatus) throw new Error('Task-start commit 固定的输入不得修改')
      await this.assertFixedTaskInput(worktree, head)
    }
    return head
  }

  private async treeFiles(revision: string, path?: string): Promise<string[]> {
    return nulDelimitedPaths(await this.git([
      'ls-tree', '-r', '-z', '--name-only', revision, ...(path ? ['--', path] : [])
    ]))
  }

  private async readTreeFile(revision: string, path: string): Promise<string> {
    return this.git(['show', `${revision}:${path}`], this.repositoryPath, false)
  }

  private async changedPaths(previousRevision: string, revision: string): Promise<string[]> {
    return nulDelimitedPaths(await this.git([
      'diff', '--name-only', '-z', previousRevision, revision
    ]))
  }

  async taskChangedPaths(taskId: string, revision: string): Promise<string[]> {
    const start = await this.taskStartRevision(taskId, revision)
    const latestMerge = (await this.git([
      'rev-list', '--first-parent', '--merges', '--max-count=1', `${start}..${revision}`
    ])).split(/\r?\n/).find(Boolean)
    const comparisonRevision = latestMerge
      ? await this.git(['rev-parse', `${latestMerge}^2`])
      : await this.git(['rev-parse', `${start}^`])
    return this.changedPaths(comparisonRevision, revision)
  }

  private async reviewMarkerPaths(revision: string): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync(ARTIFACT_GIT_BINARY_PATH, [
        'grep', '-I', '-l', '-z', '-F',
        ...REVIEW_MARKERS.flatMap((marker) => ['-e', marker]),
        revision,
        '--', KNOWLEDGE_DIRECTORY, ARTIFACTS_DIRECTORY
      ], {
        cwd: this.repositoryPath,
        env: createArtifactGitEnvironment(),
        maxBuffer: 16 * 1_024 * 1_024
      })
      return nulDelimitedPaths(stdout).map((path) => (
        path.startsWith(`${revision}:`) ? path.slice(revision.length + 1) : path
      ))
    } catch (error) {
      const details = error as Error & { code?: number | string; stderr?: string }
      if (details.code === 1) return []
      throw new Error(`Git REVIEW marker 检查失败：${details.stderr?.trim() || details.message}`, {
        cause: error
      })
    }
  }

  /** Validates the Knowledge/Artifact tree at a candidate revision without returning a snapshot. */
  private async validateRevision(revisionInput: string): Promise<void> {
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
    await this.treeFiles(revision, ARTIFACTS_DIRECTORY)
  }
}

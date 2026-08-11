import { execFile } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type {
  KnowledgeMaintenanceResult,
  KnowledgeTaskRecord,
  KnowledgeTaskResult,
  KnowledgeTaskSummary,
  KnowledgeTaskWorktreeView
} from '../../shared/knowledge-processing'
import { parseTerminalAgentInvocationRecord } from '../agent-runtime/agent-invocation-record'
import {
  ARTIFACT_GIT_BINARY_PATH,
  createArtifactGitEnvironment
} from '../artifacts/git-runtime'
import { OYSTER_TARGET_BRANCH, OysterRepository } from '../repository/oyster-repository'
import type {
  KnowledgeTaskWorktree,
  KnowledgeTaskGitRepository
} from './knowledge-task-git-repository'

const execFileAsync = promisify(execFile)
const TASK_RECORD_FILE = 'task.json'
const MAX_TASK_ID_LENGTH = 256

export interface KnowledgeTaskHistory {
  save(record: KnowledgeTaskRecord, worktree: KnowledgeTaskWorktree): Promise<void>
  list(): Promise<KnowledgeTaskSummary[]>
  read(taskId: string): Promise<KnowledgeTaskRecord | undefined>
}

function normalizedTaskId(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Task ID 必须是字符串')
  const taskId = value.trim()
  if (
    !taskId
    || taskId.length > MAX_TASK_ID_LENGTH
    || !/^[a-zA-Z0-9_-]+$/.test(taskId)
  ) throw new Error('Task ID 格式无效')
  return taskId
}

interface LegacyKnowledgeTaskWorkspaceView {
  taskId: string
  repositoryPath: string
  workspacePath: string
  briefPath: string
  progressPath: string
  inputPath: string
  branchName: string
  targetBranch: string
  baseRepositoryRevision: string
}

interface LegacyKnowledgeMaintenanceResult extends Omit<KnowledgeMaintenanceResult, 'worktree'> {
  workspace: LegacyKnowledgeTaskWorkspaceView
}

interface LegacyKnowledgeTaskResult extends Omit<KnowledgeTaskResult, 'worktree' | 'rounds'> {
  workspace: LegacyKnowledgeTaskWorkspaceView
  rounds: Array<Omit<KnowledgeTaskResult['rounds'][number], 'maintenance'> & {
    maintenance: LegacyKnowledgeMaintenanceResult
  }>
}

interface LegacyKnowledgeTaskRecord extends Omit<KnowledgeTaskRecord,
  'formatVersion' | 'status' | 'updatedAt' | 'lastError' | 'result'> {
  formatVersion: 1
  status: 'completed' | 'failed' | 'cancelled'
  completedAt: string
  result?: LegacyKnowledgeTaskResult
  error?: string
}

function migrateLegacyWorktree(
  workspace: LegacyKnowledgeTaskWorkspaceView
): KnowledgeTaskWorktreeView {
  return {
    taskId: workspace.taskId,
    repositoryPath: workspace.repositoryPath,
    worktreePath: workspace.repositoryPath,
    runtimePath: workspace.workspacePath,
    taskPath: workspace.workspacePath,
    briefPath: workspace.briefPath,
    progressPath: workspace.progressPath,
    inputPath: workspace.inputPath,
    branchName: workspace.branchName,
    targetBranch: workspace.targetBranch,
    baseRepositoryRevision: workspace.baseRepositoryRevision,
    taskStartRepositoryRevision: workspace.baseRepositoryRevision
  }
}

function migrateLegacyResult(result: LegacyKnowledgeTaskResult): KnowledgeTaskResult {
  const { workspace, rounds, ...rest } = result
  return {
    ...rest,
    worktree: migrateLegacyWorktree(workspace),
    rounds: rounds.map((round) => {
      const { workspace: roundWorkspace, ...maintenance } = round.maintenance
      return {
        ...round,
        maintenance: {
          ...maintenance,
          worktree: migrateLegacyWorktree(roundWorkspace)
        }
      }
    })
  }
}

function migrateLegacy(record: LegacyKnowledgeTaskRecord): KnowledgeTaskRecord {
  const {
    error,
    result,
    status,
    completedAt,
    ...rest
  } = record
  return {
    ...rest,
    formatVersion: 2,
    status: status === 'completed' ? 'completed' : 'abandoned',
    updatedAt: completedAt,
    ...(status === 'completed' ? { completedAt } : {}),
    ...(result ? { result: migrateLegacyResult(result) } : {}),
    ...(error ? { lastError: error } : {})
  }
}

function parseRecord(payload: string, expectedTaskId: string): KnowledgeTaskRecord {
  const parsed = JSON.parse(payload) as KnowledgeTaskRecord | LegacyKnowledgeTaskRecord
  const record = parsed?.formatVersion === 1
    ? migrateLegacy(parsed as LegacyKnowledgeTaskRecord)
    : parsed as KnowledgeTaskRecord
  if (
    !record
    || record.formatVersion !== 2
    || record.taskId !== expectedTaskId
    || !['open', 'completed', 'abandoned'].includes(record.status)
    || typeof record.startedAt !== 'string'
    || typeof record.updatedAt !== 'string'
    || !Number.isSafeInteger(record.durationMs)
    || record.durationMs < 0
    || !record.input
    || !record.configuration?.maintainer
    || !record.configuration?.reviewer
    || !Array.isArray(record.agentInvocations)
  ) throw new Error(`Knowledge Task 记录格式无效：${expectedTaskId}`)

  const agentInvocations = record.agentInvocations.map(parseTerminalAgentInvocationRecord)
  if (record.status === 'completed' && (!record.result || !record.completedAt)) {
    throw new Error(`已完成 Knowledge Task 缺少结果：${expectedTaskId}`)
  }
  if (record.status !== 'completed' && record.result) {
    throw new Error(`未完成 Knowledge Task 不应包含最终结果：${expectedTaskId}`)
  }
  return { ...record, agentInvocations }
}

function summary(record: KnowledgeTaskRecord): KnowledgeTaskSummary {
  const sourceConversation = record.sourceConversation ?? record.result?.sourceConversation
  return {
    taskId: record.taskId,
    status: record.status,
    updatedAt: record.updatedAt,
    durationMs: record.durationMs,
    sourceConversationTitle: sourceConversation?.title,
    sourceDisplayName: sourceConversation?.sourceDisplayName,
    projectPath: sourceConversation?.projectPath,
    statementCount: record.result?.knowledge.length ?? 0,
    maintainerModel: record.configuration.maintainer.modelId,
    agentInvocationCount: record.agentInvocations.length,
    modelCallCount: record.agentInvocations.reduce(
      (count, invocation) => count + invocation.modelCallCount,
      0
    ),
    error: record.lastError
  }
}

/** Reads Task state from task/* branches and writes it through the Task worktree. */
export class GitKnowledgeTaskHistory implements KnowledgeTaskHistory {
  readonly repositoryPath: string
  private readonly repository: OysterRepository

  constructor(
    repository: OysterRepository | string,
    private readonly tasks: KnowledgeTaskGitRepository
  ) {
    this.repository = typeof repository === 'string' ? new OysterRepository(repository) : repository
    this.repositoryPath = resolve(this.repository.rootPath)
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
      throw new Error(`Git Task 历史读取失败：${details.stderr?.trim() || details.message}`, {
        cause: error
      })
    }
  }

  private async tryGit(args: string[], trimOutput = true): Promise<string | undefined> {
    try {
      return await this.git(args, trimOutput)
    } catch {
      return undefined
    }
  }

  async save(record: KnowledgeTaskRecord, worktree: KnowledgeTaskWorktree): Promise<void> {
    const normalized = parseRecord(
      JSON.stringify(record),
      normalizedTaskId(record?.taskId)
    )
    await this.tasks.saveTaskRecord(
      worktree,
      normalized,
      normalized.status === 'completed'
        ? 'task: complete'
        : normalized.status === 'abandoned'
          ? 'task: abandon'
          : 'task: checkpoint execution state'
    )
  }

  private async readFromBranch(taskId: string): Promise<KnowledgeTaskRecord | undefined> {
    const payload = await this.tryGit([
      'show', `task/${taskId}:tasks/${taskId}/${TASK_RECORD_FILE}`
    ], false)
    return payload === undefined ? undefined : parseRecord(payload, taskId)
  }

  private async readFromMain(taskId: string): Promise<KnowledgeTaskRecord | undefined> {
    const payload = await this.tryGit([
      'show', `${OYSTER_TARGET_BRANCH}:tasks/${taskId}/${TASK_RECORD_FILE}`
    ], false)
    return payload === undefined ? undefined : parseRecord(payload, taskId)
  }

  private async readLegacyFile(taskId: string): Promise<KnowledgeTaskRecord | undefined> {
    try {
      const payload = await readFile(
        join(this.repository.tasksPath, taskId, TASK_RECORD_FILE),
        'utf8'
      )
      return parseRecord(payload, taskId)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async list(): Promise<KnowledgeTaskSummary[]> {
    await this.repository.initialize()
    const branchIds = (await this.git([
      'for-each-ref', '--format=%(refname:short)', 'refs/heads/task/'
    ]))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((branch) => branch.slice('task/'.length))
      .map(normalizedTaskId)

    const mainIds = (await this.tryGit([
      'ls-tree', '-d', '--name-only', `${OYSTER_TARGET_BRANCH}:tasks`
    ]))?.split(/\r?\n/).filter(Boolean).map(normalizedTaskId) ?? []
    const legacyIds = (await readdir(this.repository.tasksPath, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^[a-zA-Z0-9_-]+$/.test(entry.name))
      .map((entry) => entry.name)
    const ids = [...new Set([...branchIds, ...mainIds, ...legacyIds])]
    const records = (await Promise.all(ids.map((id) => this.read(id))))
      .filter((record): record is KnowledgeTaskRecord => Boolean(record))
    return records
      .map(summary)
      .sort((left, right) => (
        right.updatedAt.localeCompare(left.updatedAt)
        || right.taskId.localeCompare(left.taskId)
      ))
  }

  async read(taskId: string): Promise<KnowledgeTaskRecord | undefined> {
    const normalized = normalizedTaskId(taskId)
    return await this.readFromBranch(normalized)
      ?? await this.readFromMain(normalized)
      ?? await this.readLegacyFile(normalized)
  }
}

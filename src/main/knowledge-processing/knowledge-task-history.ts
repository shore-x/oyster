import { execFile } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type {
  KnowledgeTaskRecord,
  KnowledgeTaskResult,
  KnowledgeTaskSummary,
  KnowledgeTaskDefinition,
  KnowledgeTaskWorktreeView
} from '../../shared/knowledge-processing'
import type { SourceConversationSummary } from '../../shared/discovery'
import {
  ARTIFACT_GIT_BINARY_PATH,
  createArtifactGitEnvironment
} from '../artifacts/git-runtime'
import {
  OYSTER_TARGET_BRANCH,
  TASKS_DIRECTORY,
  OysterRepository
} from '../repository/oyster-repository'
import {
  TASK_RECORD_FILE_NAME,
  type KnowledgeTaskGitRepository,
  parseKnowledgeTaskDefinition
} from './knowledge-task-git-repository'
import {
  normalizeSourceConversationSummary,
  normalizeStartKnowledgeTaskInput
} from './source-snapshot'

const execFileAsync = promisify(execFile)
const MAX_TASK_ID_LENGTH = 256

export interface KnowledgeTaskHistory {
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

function listedTaskId(value: string): string | undefined {
  return value.length <= MAX_TASK_ID_LENGTH && /^[a-zA-Z0-9_-]+$/.test(value)
    ? value
    : undefined
}

function durationMs(startedAt: string, updatedAt: string): number {
  const duration = new Date(updatedAt).getTime() - new Date(startedAt).getTime()
  return Number.isFinite(duration) ? Math.max(0, duration) : 0
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
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
    changedPathCount: record.result?.changedPaths.length ?? 0,
    maintainerModel: record.configuration.maintainer.modelId
  }
}

/** Task lifecycle is a read projection of the retained task ref and main commit graph. */
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

  private async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    return (await this.tryGit(['merge-base', '--is-ancestor', ancestor, descendant])) !== undefined
  }

  private taskPath(taskId: string): string {
    return `${TASKS_DIRECTORY}/${taskId}/${TASK_RECORD_FILE_NAME}`
  }

  private async worktreeView(
    taskId: string,
    taskTip: string
  ): Promise<KnowledgeTaskWorktreeView> {
    const start = await this.tasks.taskStartRevision(taskId, taskTip)
    const worktreePath = join(this.tasks.worktreesPath, taskId)
    const taskPath = join(worktreePath, TASKS_DIRECTORY, taskId)
    return {
      taskId,
      repositoryPath: this.repositoryPath,
      worktreePath,
      runtimePath: join(this.tasks.runtimePath, taskId),
      taskPath,
      inputPath: join(taskPath, 'inputs'),
      branchName: `task/${taskId}`,
      targetBranch: OYSTER_TARGET_BRANCH,
      baseRepositoryRevision: start
    }
  }

  private async projectedRecord(
    definition: KnowledgeTaskDefinition,
    taskTip: string,
    completed: boolean
  ): Promise<KnowledgeTaskRecord> {
    const updatedAt = await this.git(['show', '-s', '--format=%cI', taskTip])
    const changedPaths = await this.tasks.taskChangedPaths(definition.taskId, taskTip)
    let result: KnowledgeTaskResult | undefined
    if (completed && definition.sourceConversation) {
      const worktree = await this.worktreeView(definition.taskId, taskTip)
      result = {
        taskId: definition.taskId,
        sourceConversation: structuredClone(definition.sourceConversation),
        sourceRef: definition.sourceRef,
        worktree,
        approvedRepositoryRevision: taskTip,
        integratedRepositoryRevision: taskTip,
        changedPaths,
        durationMs: durationMs(definition.startedAt, updatedAt),
        completedAt: updatedAt
      }
    }
    return {
      formatVersion: 3,
      taskId: definition.taskId,
      status: completed ? 'completed' : 'open',
      startedAt: definition.startedAt,
      updatedAt,
      ...(completed ? { completedAt: updatedAt } : {}),
      durationMs: durationMs(definition.startedAt, updatedAt),
      input: structuredClone(definition.input),
      sourceRef: definition.sourceRef,
      ...(definition.sourceConversation
        ? { sourceConversation: structuredClone(definition.sourceConversation) }
        : {}),
      configuration: structuredClone(definition.configuration),
      ...(result ? { result } : {})
    }
  }

  private async readFromTaskRef(taskId: string): Promise<KnowledgeTaskRecord | undefined> {
    const taskTip = await this.tryGit(['rev-parse', '--verify', `refs/heads/task/${taskId}`])
    if (!taskTip) return undefined
    const payload = await this.tryGit(['show', `${taskTip}:${this.taskPath(taskId)}`], false)
    if (payload === undefined) return undefined
    const definition = parseKnowledgeTaskDefinition(JSON.parse(payload), taskId)
    const completed = await this.isAncestor(taskTip, OYSTER_TARGET_BRANCH)
    return this.projectedRecord(definition, taskTip, completed)
  }

  /** Compatibility for old records whose task ref no longer exists. */
  private async readFromMain(taskId: string): Promise<KnowledgeTaskRecord | undefined> {
    const payload = await this.tryGit([
      'show', `${OYSTER_TARGET_BRANCH}:${this.taskPath(taskId)}`
    ], false)
    if (payload === undefined) return undefined
    const definition = parseKnowledgeTaskDefinition(JSON.parse(payload), taskId)
    const start = await this.tasks.taskStartRevision(taskId, OYSTER_TARGET_BRANCH)
    return this.projectedRecord(definition, start, true)
  }

  /** Compatibility for pre-Git Task records; never writes or migrates the source file. */
  private async readLegacyFile(taskId: string): Promise<KnowledgeTaskRecord | undefined> {
    try {
      const payload = JSON.parse(await readFile(
        join(this.repository.tasksPath, taskId, TASK_RECORD_FILE_NAME),
        'utf8'
      )) as Record<string, unknown>
      const configuration = recordValue(payload.configuration)
      const maintainer = recordValue(configuration?.maintainer)
      const reviewer = recordValue(configuration?.reviewer)
      if (payload.taskId !== taskId || !payload.input || !maintainer || !reviewer) return undefined
      const startedAt = stringValue(payload.startedAt)
        ?? new Date(0).toISOString()
      const legacyStatus = stringValue(payload.status)
      const completed = legacyStatus === 'completed'
      const completedAt = stringValue(payload.completedAt)
      const updatedAt = stringValue(payload.updatedAt)
        ?? completedAt
        ?? startedAt
      const legacyResult = recordValue(payload.result)
      const sourceConversationRecord = recordValue(payload.sourceConversation)
        ?? recordValue(legacyResult?.sourceConversation)
      const sourceConversation = sourceConversationRecord
        ? normalizeSourceConversationSummary(
            sourceConversationRecord as unknown as SourceConversationSummary
          )
        : undefined
      const sourceRef = stringValue(payload.sourceRef)
        ?? stringValue(legacyResult?.sourceRef)
        ?? `legacy:task:${taskId}`
      const approvedRepositoryRevision = stringValue(
        legacyResult?.approvedRepositoryRevision
      )
      const integratedRepositoryRevision = stringValue(
        legacyResult?.integratedRepositoryRevision
      ) ?? approvedRepositoryRevision
      const legacyWorktree = recordValue(legacyResult?.worktree)
        ?? recordValue(legacyResult?.workspace)
      let result: KnowledgeTaskResult | undefined
      if (
        completed
        && sourceConversation
        && approvedRepositoryRevision
        && integratedRepositoryRevision
      ) {
        const worktreePath = stringValue(legacyWorktree?.worktreePath)
          ?? stringValue(legacyWorktree?.repositoryPath)
          ?? this.repositoryPath
        const runtimePath = stringValue(legacyWorktree?.runtimePath)
          ?? stringValue(legacyWorktree?.workspacePath)
          ?? join(this.tasks.runtimePath, taskId)
        const taskPath = stringValue(legacyWorktree?.taskPath)
          ?? stringValue(legacyWorktree?.workspacePath)
          ?? join(this.repository.tasksPath, taskId)
        const worktree: KnowledgeTaskWorktreeView = {
          taskId,
          repositoryPath: stringValue(legacyWorktree?.repositoryPath) ?? this.repositoryPath,
          worktreePath,
          runtimePath,
          taskPath,
          inputPath: stringValue(legacyWorktree?.inputPath) ?? join(taskPath, 'inputs'),
          branchName: stringValue(legacyWorktree?.branchName) ?? `task/${taskId}`,
          targetBranch: stringValue(legacyWorktree?.targetBranch) ?? OYSTER_TARGET_BRANCH,
          baseRepositoryRevision: stringValue(legacyWorktree?.baseRepositoryRevision)
            ?? approvedRepositoryRevision
        }
        result = {
          taskId,
          sourceConversation: structuredClone(sourceConversation),
          sourceRef,
          worktree,
          approvedRepositoryRevision,
          integratedRepositoryRevision,
          changedPaths: stringArray(legacyResult?.changedPaths),
          durationMs: durationMs(startedAt, updatedAt),
          completedAt: completedAt ?? updatedAt
        }
      }
      return {
        formatVersion: 3,
        taskId,
        status: completed ? 'completed' : 'open',
        startedAt,
        updatedAt,
        ...(completed ? { completedAt: completedAt ?? updatedAt } : {}),
        durationMs: durationMs(startedAt, updatedAt),
        input: normalizeStartKnowledgeTaskInput(payload.input),
        sourceRef,
        ...(sourceConversation
          ? { sourceConversation: structuredClone(sourceConversation) }
          : {}),
        configuration: {
          maintainer: {
            connectionId: stringValue(maintainer.connectionId) ?? 'legacy:unknown',
            modelId: stringValue(maintainer.modelId) ?? 'legacy:unknown'
          },
          reviewer: {
            connectionId: stringValue(reviewer.connectionId) ?? 'legacy:unknown',
            modelId: stringValue(reviewer.modelId) ?? 'legacy:unknown'
          }
        },
        ...(result ? { result } : {})
      }
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
      .map((branch) => listedTaskId(branch.slice('task/'.length)))
      .filter((taskId): taskId is string => taskId !== undefined)
    const mainIds = (await this.tryGit([
      'ls-tree', '-d', '--name-only', `${OYSTER_TARGET_BRANCH}:${TASKS_DIRECTORY}`
    ]))?.split(/\r?\n/)
      .filter(Boolean)
      .map(listedTaskId)
      .filter((taskId): taskId is string => taskId !== undefined) ?? []
    const legacyIds = (await readdir(this.repository.tasksPath, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^[a-zA-Z0-9_-]+$/.test(entry.name))
      .map((entry) => entry.name)
    const ids = [...new Set([...branchIds, ...mainIds, ...legacyIds])]
    const records = (await Promise.allSettled(ids.map((id) => this.read(id))))
      .flatMap((result) => result.status === 'fulfilled' && result.value ? [result.value] : [])
    return records.map(summary).sort((left, right) => (
      right.updatedAt.localeCompare(left.updatedAt)
      || right.taskId.localeCompare(left.taskId)
    ))
  }

  async read(taskId: string): Promise<KnowledgeTaskRecord | undefined> {
    const normalized = normalizedTaskId(taskId)
    return await this.readFromTaskRef(normalized)
      ?? await this.readFromMain(normalized)
      ?? await this.readLegacyFile(normalized)
  }
}

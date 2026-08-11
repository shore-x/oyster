import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import type {
  KnowledgeTaskRecord,
  KnowledgeTaskSummary
} from '../../shared/knowledge-processing'
import { parseTerminalAgentInvocationRecord } from '../agent-runtime/agent-invocation-record'

const TASK_RECORD_FILE = 'task.json'
const TASK_RECORD_FORMAT_VERSION = 1
const MAX_TASK_ID_LENGTH = 256

class LegacyKnowledgeTaskRecordError extends Error {}

export interface KnowledgeTaskHistory {
  save(record: KnowledgeTaskRecord): void
  list(): KnowledgeTaskSummary[]
  read(taskId: string): KnowledgeTaskRecord | undefined
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

function parseRecord(payload: string, expectedTaskId: string): KnowledgeTaskRecord {
  const record = JSON.parse(payload) as KnowledgeTaskRecord
  if (
    record
    && Number.isSafeInteger(record.formatVersion)
    && record.formatVersion < TASK_RECORD_FORMAT_VERSION
  ) throw new LegacyKnowledgeTaskRecordError()
  if (
    !record
    || record.formatVersion !== TASK_RECORD_FORMAT_VERSION
    || record.taskId !== expectedTaskId
  ) throw new Error(`Knowledge Task 历史记录格式无效：${expectedTaskId}`)
  if (
    !['completed', 'failed', 'cancelled'].includes(record.status)
    || typeof record.startedAt !== 'string'
    || typeof record.completedAt !== 'string'
    || !Number.isSafeInteger(record.durationMs)
    || record.durationMs < 0
    || !record.input
    || !record.configuration?.maintainer
    || !record.configuration?.reviewer
    || !Array.isArray(record.agentInvocations)
  ) throw new Error(`Knowledge Task 历史 Envelope 无效：${expectedTaskId}`)

  const agentInvocations = record.agentInvocations.map(parseTerminalAgentInvocationRecord)
  if (new Set(agentInvocations.map((invocation) => invocation.id)).size !== agentInvocations.length) {
    throw new Error(`Knowledge Task 历史包含重复 Agent Invocation：${expectedTaskId}`)
  }

  if (record.status === 'completed') {
    if (
      !record.result
      || record.result.taskId !== expectedTaskId
      || record.result.workspace.taskId !== expectedTaskId
      || record.error !== undefined
      || !record.result.rounds.length
    ) throw new Error(`成功 Knowledge Task 历史记录格式无效：${expectedTaskId}`)
    if (record.result.rounds.some((round, index) => (
      round.sequence !== index + 1
      || !round.roundId
      || round.maintenance.agentId !== 'knowledge_maintainer'
      || round.review.agentId !== 'knowledge_reviewer'
    ))) throw new Error(`Knowledge Task Round 顺序无效：${expectedTaskId}`)

    const referencedInvocationIds = record.result.rounds.flatMap((round) => [
      round.maintenance.agentInvocationId,
      round.review.agentInvocationId
    ])
    if (
      referencedInvocationIds.length !== agentInvocations.length
      || new Set(referencedInvocationIds).size !== referencedInvocationIds.length
      || referencedInvocationIds.some((id) => {
        const invocation = agentInvocations.find((candidate) => candidate.id === id)
        return !invocation || invocation.status !== 'completed'
      })
    ) {
      throw new Error(`成功 Knowledge Task 未引用全部 Agent Invocation：${expectedTaskId}`)
    }
    const finalReview = record.result.rounds.at(-1)?.review
    if (
      !finalReview
      || finalReview.decision !== 'approved'
      || finalReview.candidateRepositoryRevision
        !== record.result.approvedRepositoryRevision
    ) throw new Error(`成功 Knowledge Task 缺少最终 Reviewer 批准：${expectedTaskId}`)
  } else if (
    record.result !== undefined
    || typeof record.error !== 'string'
    || !record.error
  ) {
    throw new Error(`未成功 Knowledge Task 历史记录格式无效：${expectedTaskId}`)
  }
  return { ...record, agentInvocations }
}

function summary(record: KnowledgeTaskRecord): KnowledgeTaskSummary {
  const sourceConversation = record.sourceConversation ?? record.result?.sourceConversation
  return {
    taskId: record.taskId,
    status: record.status,
    completedAt: record.completedAt,
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
    error: record.error
  }
}

/** Durable terminal Task records stored beside each Task workspace. */
export class FileKnowledgeTaskHistory implements KnowledgeTaskHistory {
  readonly tasksPath: string

  constructor(tasksPath: string) {
    this.tasksPath = resolve(tasksPath)
    mkdirSync(this.tasksPath, { recursive: true })
  }

  private recordPath(taskId: string): string {
    return join(this.tasksPath, normalizedTaskId(taskId), TASK_RECORD_FILE)
  }

  save(record: KnowledgeTaskRecord): void {
    const normalized = parseRecord(
      JSON.stringify(record),
      normalizedTaskId(record?.taskId)
    )
    const path = this.recordPath(normalized.taskId)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, `${JSON.stringify(normalized, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx'
    })
  }

  list(): KnowledgeTaskSummary[] {
    return readdirSync(this.tasksPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const record = this.read(entry.name)
        return record ? [summary(record)] : []
      })
      .sort((left, right) => (
        right.completedAt.localeCompare(left.completedAt)
        || right.taskId.localeCompare(left.taskId)
      ))
  }

  read(taskId: string): KnowledgeTaskRecord | undefined {
    const normalized = normalizedTaskId(taskId)
    try {
      return parseRecord(readFileSync(this.recordPath(normalized), 'utf8'), normalized)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      if (error instanceof LegacyKnowledgeTaskRecordError) {
        rmSync(join(this.tasksPath, normalized), { recursive: true, force: true })
        return undefined
      }
      throw error
    }
  }
}

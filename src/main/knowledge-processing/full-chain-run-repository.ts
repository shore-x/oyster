import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import type {
  KnowledgeFullChainRunRecord,
  KnowledgeFullChainRunSummary
} from '../../shared/knowledge-processing'
import { parseTerminalAgentRunRecord } from '../agent-runtime/agent-run-record'

const RUN_RECORD_FILE = 'run.json'
const MAX_RUN_ID_LENGTH = 256

export interface KnowledgeFullChainRunHistory {
  save(record: KnowledgeFullChainRunRecord): void
  list(): KnowledgeFullChainRunSummary[]
  read(runId: string): KnowledgeFullChainRunRecord | undefined
}

function normalizedRunId(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Run ID 必须是字符串')
  const runId = value.trim()
  if (
    !runId
    || runId.length > MAX_RUN_ID_LENGTH
    || !/^[a-zA-Z0-9_-]+$/.test(runId)
  ) throw new Error('Run ID 格式无效')
  return runId
}

function parseRecord(payload: string, expectedRunId: string): KnowledgeFullChainRunRecord {
  const record = JSON.parse(payload) as KnowledgeFullChainRunRecord
  if (!record || record.formatVersion !== 8 || record.runId !== expectedRunId) {
    throw new Error(`加工测试历史记录格式无效：${expectedRunId}`)
  }
  if (!['completed', 'failed', 'cancelled'].includes(record.status)
    || typeof record.startedAt !== 'string'
    || typeof record.completedAt !== 'string'
    || !Number.isSafeInteger(record.durationMs)
    || record.durationMs < 0
    || !record.input
    || !record.configuration?.maintainer
    || !record.configuration?.reviewer
    || !Array.isArray(record.agentRuns)) {
    throw new Error(`加工测试历史记录 Envelope 无效：${expectedRunId}`)
  }
  const agentRuns = record.agentRuns.map(parseTerminalAgentRunRecord)
  if (new Set(agentRuns.map((run) => run.id)).size !== agentRuns.length) {
    throw new Error(`加工测试历史包含重复 Agent Run：${expectedRunId}`)
  }
  if (record.status === 'completed') {
    if (!record.result || record.result.runId !== expectedRunId || record.error !== undefined) {
      throw new Error(`成功加工测试历史记录格式无效：${expectedRunId}`)
    }
    const referencedRunIds = [
      ...record.result.maintenanceRuns.map((run) => run.agentRunId),
      ...record.result.reviewRuns.map((run) => run.agentRunId)
    ]
    if (
      referencedRunIds.length !== agentRuns.length
      || new Set(referencedRunIds).size !== referencedRunIds.length
      || referencedRunIds.some((id) => {
        const run = agentRuns.find((candidate) => candidate.id === id)
        return !run || run.status !== 'completed'
      })
    ) throw new Error(`成功加工测试历史未引用全部已完成 Agent Run：${expectedRunId}`)
    const finalReview = record.result.reviewRuns.at(-1)
    if (!finalReview
      || finalReview.outcome !== 'approved'
      || finalReview.revision !== record.result.approvedRevision) {
      throw new Error(`成功加工测试历史缺少最终 Reviewer 批准：${expectedRunId}`)
    }
  } else if (record.result !== undefined || typeof record.error !== 'string' || !record.error) {
    throw new Error(`未成功加工测试历史记录格式无效：${expectedRunId}`)
  }
  return { ...record, agentRuns }
}

function summary(record: KnowledgeFullChainRunRecord): KnowledgeFullChainRunSummary {
  const session = record.session ?? record.result?.session
  return {
    runId: record.runId,
    status: record.status,
    completedAt: record.completedAt,
    durationMs: record.durationMs,
    sessionTitle: session?.title,
    sourceDisplayName: session?.sourceDisplayName,
    projectPath: session?.projectPath,
    statementCount: record.result?.knowledge.length ?? 0,
    maintainerModel: record.configuration.maintainer.modelId,
    agentRunCount: record.agentRuns.length,
    modelCallCount: record.agentRuns.reduce((count, run) => count + run.modelCalls.length, 0),
    error: record.error
  }
}

/** Durable terminal records stored beside each Run's WORK.md. */
export class FileKnowledgeFullChainRunRepository implements KnowledgeFullChainRunHistory {
  readonly runsPath: string

  constructor(runsPath: string) {
    this.runsPath = resolve(runsPath)
    mkdirSync(this.runsPath, { recursive: true })
  }

  private recordPath(runId: string): string {
    return join(this.runsPath, normalizedRunId(runId), RUN_RECORD_FILE)
  }

  save(record: KnowledgeFullChainRunRecord): void {
    const normalized = parseRecord(JSON.stringify(record), normalizedRunId(record?.runId))
    const path = this.recordPath(normalized.runId)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  }

  list(): KnowledgeFullChainRunSummary[] {
    return readdirSync(this.runsPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const record = this.read(entry.name)
        return record ? [summary(record)] : []
      })
      .sort((left, right) => (
        right.completedAt.localeCompare(left.completedAt) || right.runId.localeCompare(left.runId)
      ))
  }

  read(runId: string): KnowledgeFullChainRunRecord | undefined {
    const normalized = normalizedRunId(runId)
    try {
      return parseRecord(readFileSync(this.recordPath(normalized), 'utf8'), normalized)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
}

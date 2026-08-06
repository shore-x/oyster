import { DatabaseSync } from 'node:sqlite'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  KnowledgeFullChainRunRecord,
  KnowledgeFullChainRunSummary
} from '../../shared/knowledge-processing'
import { parseTerminalAgentRunRecord } from '../agent-runtime/agent-run-record'

const SCHEMA_VERSION = 5
/** Pre-V5 development schemas may be rebuilt once; stable schemas require migrations. */
const LAST_REBUILDABLE_SCHEMA_VERSION = 3
const MAX_RUN_ID_LENGTH = 256

interface FullChainRunSummaryRow {
  run_id: string
  status: KnowledgeFullChainRunSummary['status']
  completed_at: string
  duration_ms: number
  session_title: string | null
  source_display_name: string | null
  project_path: string | null
  statement_count: number
  maintainer_model: string
  agent_run_count: number
  model_call_count: number
  error: string | null
}

export interface KnowledgeFullChainRunHistory {
  save(record: KnowledgeFullChainRunRecord): void
  list(): KnowledgeFullChainRunSummary[]
  read(runId: string): KnowledgeFullChainRunRecord | undefined
}

function normalizedRunId(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Run ID 必须是字符串')
  const runId = value.trim()
  if (!runId || runId.length > MAX_RUN_ID_LENGTH) throw new Error('Run ID 格式无效')
  return runId
}

function parseRecord(payload: string, expectedRunId: string): KnowledgeFullChainRunRecord {
  const record = JSON.parse(payload) as KnowledgeFullChainRunRecord
  if (!record || record.formatVersion !== 6 || record.runId !== expectedRunId) {
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
    ) {
      throw new Error(`成功加工测试历史未引用全部已完成 Agent Run：${expectedRunId}`)
    }
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

/** Stores immutable terminal-run snapshots separately from production knowledge. */
export class SqliteKnowledgeFullChainRunRepository implements KnowledgeFullChainRunHistory {
  private readonly database: DatabaseSync
  private closed = false

  private constructor(readonly databasePath: string) {
    this.database = new DatabaseSync(databasePath)
    try {
      this.database.exec('PRAGMA busy_timeout = 5000')
      this.initializeSchema()
    } catch (error) {
      this.database.close()
      throw error
    }
  }

  static async open(databasePath: string): Promise<SqliteKnowledgeFullChainRunRepository> {
    await mkdir(dirname(databasePath), { recursive: true })
    return new SqliteKnowledgeFullChainRunRepository(databasePath)
  }

  private initializeSchema(): void {
    const version = Number((this.database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
    if (version > SCHEMA_VERSION) {
      throw new Error(`加工测试历史 Schema ${version} 高于当前支持版本 ${SCHEMA_VERSION}`)
    }
    if (version === SCHEMA_VERSION) return
    if (version === 4) {
      this.database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
      return
    }
    if (version > LAST_REBUILDABLE_SCHEMA_VERSION) {
      throw new Error(`加工测试历史 Schema ${version} 缺少到 ${SCHEMA_VERSION} 的显式迁移`)
    }
    this.database.exec(`
      BEGIN IMMEDIATE;
      DROP TABLE IF EXISTS knowledge_full_chain_runs;
      CREATE TABLE knowledge_full_chain_runs (
        run_id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK(status IN ('completed', 'failed', 'cancelled')),
        completed_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL CHECK(duration_ms >= 0),
        session_title TEXT,
        source_display_name TEXT,
        project_path TEXT,
        statement_count INTEGER NOT NULL CHECK(statement_count >= 0),
        maintainer_model TEXT NOT NULL,
        agent_run_count INTEGER NOT NULL CHECK(agent_run_count >= 0),
        model_call_count INTEGER NOT NULL CHECK(model_call_count >= 0),
        error TEXT,
        payload_json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX knowledge_full_chain_runs_completed_at
        ON knowledge_full_chain_runs(completed_at DESC, run_id);
      PRAGMA user_version = ${SCHEMA_VERSION};
      COMMIT;
    `)
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('加工测试历史仓库已关闭')
  }

  save(record: KnowledgeFullChainRunRecord): void {
    this.assertOpen()
    const runId = normalizedRunId(record?.runId)
    const normalized = parseRecord(JSON.stringify(record), runId)
    const session = normalized.session ?? normalized.result?.session
    const statementCount = normalized.result?.knowledge.length ?? 0
    const modelCallCount = normalized.agentRuns.reduce((count, run) => count + run.modelCalls.length, 0)
    this.database.prepare(`
      INSERT INTO knowledge_full_chain_runs (
        run_id,
        status,
        completed_at,
        duration_ms,
        session_title,
        source_display_name,
        project_path,
        statement_count,
        maintainer_model,
        agent_run_count,
        model_call_count,
        error,
        payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId,
      normalized.status,
      normalized.completedAt,
      normalized.durationMs,
      session?.title ?? null,
      session?.sourceDisplayName ?? null,
      session?.projectPath ?? null,
      statementCount,
      normalized.configuration.maintainer.modelId,
      normalized.agentRuns.length,
      modelCallCount,
      normalized.error ?? null,
      JSON.stringify(normalized)
    )
  }

  list(): KnowledgeFullChainRunSummary[] {
    this.assertOpen()
    const rows = this.database.prepare(`
      SELECT
        run_id,
        status,
        completed_at,
        duration_ms,
        session_title,
        source_display_name,
        project_path,
        statement_count,
        maintainer_model,
        agent_run_count,
        model_call_count,
        error
      FROM knowledge_full_chain_runs
      ORDER BY completed_at DESC, run_id
    `).all() as unknown as FullChainRunSummaryRow[]
    return rows.map((row) => ({
      runId: row.run_id,
      status: row.status,
      completedAt: row.completed_at,
      durationMs: row.duration_ms,
      sessionTitle: row.session_title ?? undefined,
      sourceDisplayName: row.source_display_name ?? undefined,
      projectPath: row.project_path ?? undefined,
      statementCount: row.statement_count,
      maintainerModel: row.maintainer_model,
      agentRunCount: row.agent_run_count,
      modelCallCount: row.model_call_count,
      error: row.error ?? undefined
    }))
  }

  read(runId: string): KnowledgeFullChainRunRecord | undefined {
    this.assertOpen()
    const normalized = normalizedRunId(runId)
    const row = this.database.prepare(`
      SELECT payload_json
      FROM knowledge_full_chain_runs
      WHERE run_id = ?
    `).get(normalized) as { payload_json: string } | undefined
    return row ? parseRecord(row.payload_json, normalized) : undefined
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.database.close()
  }
}

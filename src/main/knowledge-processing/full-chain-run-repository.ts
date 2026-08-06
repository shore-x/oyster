import { DatabaseSync } from 'node:sqlite'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  KnowledgeFullChainRunRecord,
  KnowledgeFullChainRunSummary
} from '../../shared/knowledge-processing'

const SCHEMA_VERSION = 3
const MAX_RUN_ID_LENGTH = 256

interface FullChainRunSummaryRow {
  run_id: string
  completed_at: string
  duration_ms: number
  session_title: string | null
  source_display_name: string
  project_path: string | null
  started_at: string | null
  ended_at: string | null
  statement_count: number
  maintainer_model: string
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
  if (
    record?.formatVersion !== 4
    || record.runId !== expectedRunId
    || record.result?.runId !== expectedRunId
    || !record.result.completedAt
    || !record.result.maintenance?.debugTrace
  ) throw new Error(`加工测试历史记录格式无效：${expectedRunId}`)
  return record
}

/** Stores immutable completed-run snapshots separately from production knowledge. */
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
    this.database.exec(`
      BEGIN IMMEDIATE;
      DROP TABLE IF EXISTS knowledge_full_chain_runs;
      CREATE TABLE knowledge_full_chain_runs (
        run_id TEXT PRIMARY KEY,
        completed_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL CHECK(duration_ms >= 0),
        session_title TEXT,
        source_display_name TEXT NOT NULL,
        project_path TEXT,
        started_at TEXT,
        ended_at TEXT,
        statement_count INTEGER NOT NULL CHECK(statement_count >= 0),
        maintainer_model TEXT NOT NULL,
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
    if (record.formatVersion !== 4) throw new Error('加工测试历史格式版本无效')
    if (record.result?.runId !== runId) throw new Error('加工测试历史与运行结果不匹配')
    const { result } = record
    this.database.prepare(`
      INSERT INTO knowledge_full_chain_runs (
        run_id,
        completed_at,
        duration_ms,
        session_title,
        source_display_name,
        project_path,
        started_at,
        ended_at,
        statement_count,
        maintainer_model,
        payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId,
      result.completedAt,
      result.durationMs,
      result.session.title ?? null,
      result.session.sourceDisplayName,
      result.session.projectPath ?? null,
      result.session.startedAt ?? null,
      result.session.endedAt ?? null,
      result.knowledge.statements.length,
      result.maintenance.execution.model,
      JSON.stringify(record)
    )
  }

  list(): KnowledgeFullChainRunSummary[] {
    this.assertOpen()
    const rows = this.database.prepare(`
      SELECT
        run_id,
        completed_at,
        duration_ms,
        session_title,
        source_display_name,
        project_path,
        started_at,
        ended_at,
        statement_count,
        maintainer_model
      FROM knowledge_full_chain_runs
      ORDER BY completed_at DESC, run_id
    `).all() as unknown as FullChainRunSummaryRow[]
    return rows.map((row) => ({
      runId: row.run_id,
      completedAt: row.completed_at,
      durationMs: row.duration_ms,
      sessionTitle: row.session_title ?? undefined,
      sourceDisplayName: row.source_display_name,
      projectPath: row.project_path ?? undefined,
      startedAt: row.started_at ?? undefined,
      endedAt: row.ended_at ?? undefined,
      statementCount: row.statement_count,
      maintainerModel: row.maintainer_model
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

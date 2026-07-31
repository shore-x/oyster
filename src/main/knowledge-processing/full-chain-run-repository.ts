import { DatabaseSync } from 'node:sqlite'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  KnowledgeFullChainRunRecord,
  KnowledgeFullChainRunSummary
} from '../../shared/knowledge-processing'

const SCHEMA_VERSION = 1
const MAX_RUN_ID_LENGTH = 256

interface FullChainRunRow {
  payload_json: string
}

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
  candidate_count: number
  preprocessor_model: string
  maintainer_model: string
}

type StoredKnowledgeFullChainRunRecordV1 = Omit<KnowledgeFullChainRunRecord, 'result'> & {
  result: Omit<KnowledgeFullChainRunRecord['result'], 'preprocessing'> & {
    preprocessing: Omit<KnowledgeFullChainRunRecord['result']['preprocessing'], 'debugTrace'>
  }
}

type StoredSessionV1 = Omit<
  KnowledgeFullChainRunRecord['result']['session'],
  'sourceRecordId'
> & {
  sourceRecordId?: unknown
  /** Legacy field written before source records were distinguished from user-facing Artifacts. */
  artifactId?: unknown
}

type ReadableStoredKnowledgeFullChainRunRecordV1 = Omit<
  StoredKnowledgeFullChainRunRecordV1,
  'result'
> & {
  result: Omit<StoredKnowledgeFullChainRunRecordV1['result'], 'session'> & {
    session: StoredSessionV1
  }
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

function summaryFromRow(row: FullChainRunSummaryRow): KnowledgeFullChainRunSummary {
  return {
    runId: row.run_id,
    completedAt: row.completed_at,
    durationMs: row.duration_ms,
    sessionTitle: row.session_title ?? undefined,
    sourceDisplayName: row.source_display_name,
    projectPath: row.project_path ?? undefined,
    startedAt: row.started_at ?? undefined,
    endedAt: row.ended_at ?? undefined,
    statementCount: row.statement_count,
    candidateCount: row.candidate_count,
    preprocessorModel: row.preprocessor_model,
    maintainerModel: row.maintainer_model
  }
}

function parseRecord(payload: string, expectedRunId: string): KnowledgeFullChainRunRecord {
  const stored = JSON.parse(payload) as ReadableStoredKnowledgeFullChainRunRecordV1
  const storedSourceRecordId = stored?.result?.session?.sourceRecordId
  const legacyArtifactId = stored?.result?.session?.artifactId
  const sourceRecordId = typeof storedSourceRecordId === 'string' && storedSourceRecordId
    ? storedSourceRecordId
    : typeof legacyArtifactId === 'string' && legacyArtifactId
      ? legacyArtifactId
      : undefined
  if (
    !stored
    || stored.formatVersion !== 1
    || stored.runId !== expectedRunId
    || stored.result?.runId !== expectedRunId
    || !stored.result.completedAt
    || !stored.result.maintenance?.debugTrace
    || !sourceRecordId
  ) {
    throw new Error(`加工测试历史记录格式无效：${expectedRunId}`)
  }
  const {
    artifactId: _legacyArtifactId,
    sourceRecordId: _storedSourceRecordId,
    ...storedSession
  } = stored.result.session
  return {
    ...stored,
    result: {
      ...stored.result,
      session: {
        ...storedSession,
        sourceRecordId
      },
      preprocessing: {
        ...stored.result.preprocessing,
        debugTrace: stored.result.maintenance.debugTrace
      }
    }
  }
}

function storedRecord(record: KnowledgeFullChainRunRecord): StoredKnowledgeFullChainRunRecordV1 {
  const { debugTrace: _duplicateTrace, ...preprocessing } = record.result.preprocessing
  return {
    ...record,
    result: {
      ...record.result,
      preprocessing
    }
  }
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
    if (version !== 0) throw new Error(`不支持的加工测试历史 Schema：${version}`)
    this.database.exec(`
      BEGIN IMMEDIATE;
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
        candidate_count INTEGER NOT NULL CHECK(candidate_count >= 0),
        preprocessor_model TEXT NOT NULL,
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
    if (record.formatVersion !== 1) throw new Error('加工测试历史格式版本无效')
    if (record.result?.runId !== runId) throw new Error('加工测试历史与运行结果不匹配')
    const { result } = record
    const payload = JSON.stringify(storedRecord(record))
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
        candidate_count,
        preprocessor_model,
        maintainer_model,
        payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      result.maintenance.statementCandidates.length,
      result.preprocessing.execution.model,
      result.maintenance.execution.model,
      payload
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
        candidate_count,
        preprocessor_model,
        maintainer_model
      FROM knowledge_full_chain_runs
      ORDER BY completed_at DESC, run_id
    `).all() as unknown as FullChainRunSummaryRow[]
    return rows.map(summaryFromRow)
  }

  read(runId: string): KnowledgeFullChainRunRecord | undefined {
    this.assertOpen()
    const normalized = normalizedRunId(runId)
    const row = this.database.prepare(`
      SELECT payload_json
      FROM knowledge_full_chain_runs
      WHERE run_id = ?
    `).get(normalized) as FullChainRunRow | undefined
    return row ? parseRecord(row.payload_json, normalized) : undefined
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.database.close()
  }
}

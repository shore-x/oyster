import { backup, DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type {
  KnowledgeCommitResult,
  KnowledgeContributionDraft,
  KnowledgeContributionRecord,
  KnowledgeBrowseResult,
  ClearKnowledgeResult,
  KnowledgeStatement,
  KnowledgeStatementDraft,
  ListKnowledgeStatementsOptions,
  BrowseKnowledgeInput
} from './model'
import {
  MAX_KNOWLEDGE_STATEMENT_CONTENT_LENGTH,
  MAX_KNOWLEDGE_STATEMENT_TITLE_LENGTH
} from './model'
import type {
  KnowledgeReader,
  KnowledgeStatementRecord
} from '../knowledge-processing/model'

const SCHEMA_VERSION = 3
const MAX_RUN_REF_LENGTH = 1_024
const MAX_LIST_LIMIT = 1_000
const MAX_SEARCH_LIMIT = 100

interface StatementRow {
  title: string
  content: string
}

interface StatementSummaryRow {
  title: string
  preview: string
}

interface ContributionRow {
  run_ref: string
  created_at: string
}

interface NormalizedContributionDraft {
  runRef: string
  statements: KnowledgeStatement[]
}

export interface SqliteKnowledgeStoreOptions {
  clock?: () => Date
}

function requiredTrimmed(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string') throw new Error(`${label} 必须是字符串`)
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} 不能为空`)
  if (normalized.length > maximum) throw new Error(`${label} 超出长度上限 ${maximum}`)
  return normalized
}

function normalizeLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`limit 必须是 1 到 ${maximum} 之间的整数`)
  }
  return value
}

function normalizeOffset(value: number | undefined): number {
  if (value === undefined) return 0
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('offset 必须是非负整数')
  return value
}

function normalizeDraft(draft: KnowledgeContributionDraft): NormalizedContributionDraft {
  if (!draft || typeof draft !== 'object') throw new Error('Knowledge Contribution 格式无效')
  const runRef = requiredTrimmed(draft.runRef, 'runRef', MAX_RUN_REF_LENGTH)
  if (!Array.isArray(draft.statements)) throw new Error('statements 必须是数组')

  const titles = new Set<string>()
  const statements = draft.statements.map((statement: KnowledgeStatementDraft, index): KnowledgeStatement => {
    if (!statement || typeof statement !== 'object') throw new Error(`Statement ${index + 1} 格式无效`)
    const title = requiredTrimmed(
      statement.title,
      `Statement ${index + 1} title`,
      MAX_KNOWLEDGE_STATEMENT_TITLE_LENGTH
    )
    if (titles.has(title)) throw new Error(`同一 Knowledge Contribution 中 canonical title 重复：${title}`)
    titles.add(title)
    if (typeof statement.content !== 'string' || !statement.content.trim()) {
      throw new Error(`${title} content 不能为空`)
    }
    if (statement.content.length > MAX_KNOWLEDGE_STATEMENT_CONTENT_LENGTH) {
      throw new Error(`${title} content 超出长度上限 ${MAX_KNOWLEDGE_STATEMENT_CONTENT_LENGTH}`)
    }
    return { title, content: statement.content }
  })

  return { runRef, statements }
}

function statementFromRow(row: StatementRow): KnowledgeStatement {
  return { title: row.title, content: row.content }
}

function contributionFromRow(row: ContributionRow): KnowledgeContributionRecord {
  return { runRef: row.run_ref, createdAt: row.created_at }
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`
}

function asSqlParameters(values: Array<string | number>): SQLInputValue[] {
  return values
}

/**
 * SQLite implementation of the MVP Knowledge Store.
 *
 * A trimmed canonical title is the exact read/upsert key. The body is otherwise
 * stored verbatim, including any dynamic `[[canonical title]]` references.
 */
export class SqliteKnowledgeStore implements KnowledgeReader {
  private readonly database: DatabaseSync
  private readonly clock: () => Date
  private closed = false

  constructor(
    readonly databasePath: string,
    options: SqliteKnowledgeStoreOptions = {}
  ) {
    this.clock = options.clock ?? (() => new Date())
    this.database = new DatabaseSync(databasePath)
    try {
      this.database.exec('PRAGMA foreign_keys = ON')
      this.database.exec('PRAGMA busy_timeout = 5000')
      this.initializeSchema()
    } catch (error) {
      this.database.close()
      throw error
    }
  }

  private initializeSchema(): void {
    const version = Number((this.database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
    if (version > SCHEMA_VERSION) {
      throw new Error(`Knowledge Store Schema ${version} 高于当前支持版本 ${SCHEMA_VERSION}`)
    }
    if (version === SCHEMA_VERSION) return
    if (version === 1 || version === 2) {
      this.migrateToCurrentSchema()
      return
    }
    if (version !== 0) throw new Error(`不支持的 Knowledge Store Schema：${version}`)

    this.database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE knowledge_contributions (
        run_ref TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE knowledge_statements (
        title TEXT NOT NULL PRIMARY KEY,
        content TEXT NOT NULL CHECK(length(trim(content)) > 0)
      ) STRICT;
      PRAGMA user_version = ${SCHEMA_VERSION};
      COMMIT;
    `)
  }

  /** Rebuild a prior Store from the fields that belong to the current model. */
  private migrateToCurrentSchema(): void {
    const duplicate = this.database.prepare(`
      SELECT trim(title) AS title, count(*) AS count
      FROM knowledge_statements
      GROUP BY trim(title)
      HAVING count(*) > 1
      ORDER BY trim(title)
      LIMIT 1
    `).get() as { title: string; count: number } | undefined
    if (duplicate) {
      throw new Error(
        `Knowledge Store 包含 ${duplicate.count} 条同名 Statement（${duplicate.title}），无法安全迁移到 canonical title 唯一的当前结构`
      )
    }

    const auxiliaryTables = this.database.prepare(`
      SELECT name
      FROM sqlite_schema
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
        AND name NOT IN ('knowledge_contributions', 'knowledge_statements')
      ORDER BY name
    `).all() as unknown as Array<{ name: string }>

    this.database.exec('PRAGMA foreign_keys = OFF')
    try {
      this.database.exec('BEGIN IMMEDIATE')
      for (const { name } of auxiliaryTables) {
        this.database.exec(`DROP TABLE ${quoteIdentifier(name)}`)
      }
      this.database.exec(`
        CREATE TABLE next_knowledge_contributions (
          run_ref TEXT PRIMARY KEY,
          created_at TEXT NOT NULL
        ) STRICT;
        INSERT INTO next_knowledge_contributions (run_ref, created_at)
        SELECT run_ref, created_at
        FROM knowledge_contributions;

        CREATE TABLE next_knowledge_statements (
          title TEXT NOT NULL PRIMARY KEY,
          content TEXT NOT NULL CHECK(length(trim(content)) > 0)
        ) STRICT;
        INSERT INTO next_knowledge_statements (title, content)
        SELECT trim(title), content
        FROM knowledge_statements;

        DROP TABLE knowledge_statements;
        DROP TABLE knowledge_contributions;
        ALTER TABLE next_knowledge_contributions RENAME TO knowledge_contributions;
        ALTER TABLE next_knowledge_statements RENAME TO knowledge_statements;
        PRAGMA user_version = ${SCHEMA_VERSION};
        COMMIT;
      `)
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    } finally {
      this.database.exec('PRAGMA foreign_keys = ON')
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Knowledge Store 已关闭')
  }

  async snapshotTo(destinationPath: string): Promise<void> {
    this.assertOpen()
    await backup(this.database, destinationPath)
  }

  commit(draft: KnowledgeContributionDraft): KnowledgeCommitResult {
    this.assertOpen()
    const normalized = normalizeDraft(draft)
    const contribution: KnowledgeContributionRecord = {
      runRef: normalized.runRef,
      createdAt: this.clock().toISOString()
    }

    this.database.exec('BEGIN IMMEDIATE')
    try {
      const duplicateRun = this.database.prepare(
        'SELECT run_ref FROM knowledge_contributions WHERE run_ref = ?'
      ).get(normalized.runRef)
      if (duplicateRun) throw new Error(`runRef 已提交 Knowledge Contribution：${normalized.runRef}`)

      const findStatement = this.database.prepare(
        'SELECT title FROM knowledge_statements WHERE title = ?'
      )
      const createdTitles: string[] = []
      const updatedTitles: string[] = []
      for (const statement of normalized.statements) {
        if (findStatement.get(statement.title)) updatedTitles.push(statement.title)
        else createdTitles.push(statement.title)
      }

      this.database.prepare(`
        INSERT INTO knowledge_contributions (run_ref, created_at)
        VALUES (?, ?)
      `).run(contribution.runRef, contribution.createdAt)

      const upsertStatement = this.database.prepare(`
        INSERT INTO knowledge_statements (title, content)
        VALUES (?, ?)
        ON CONFLICT(title) DO UPDATE SET content = excluded.content
      `)
      for (const statement of normalized.statements) {
        upsertStatement.run(statement.title, statement.content)
      }

      this.database.exec('COMMIT')
      return {
        contribution,
        statements: normalized.statements,
        createdTitles,
        updatedTitles
      }
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  async search(
    query: string,
    limit?: number,
    offset?: number,
    signal?: AbortSignal
  ): Promise<KnowledgeStatementRecord[]> {
    this.assertOpen()
    signal?.throwIfAborted()
    const normalizedQuery = requiredTrimmed(query, '搜索 query', 1_024)
    const normalizedLimit = normalizeLimit(limit, 8, MAX_SEARCH_LIMIT)
    const normalizedOffset = normalizeOffset(offset)
    const escaped = normalizedQuery.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
    const contains = `%${escaped}%`
    const prefix = `${escaped}%`
    const rows = this.database.prepare(`
      SELECT title, content
      FROM knowledge_statements
      WHERE title LIKE ? ESCAPE '\\' COLLATE NOCASE
         OR content LIKE ? ESCAPE '\\' COLLATE NOCASE
      ORDER BY
        CASE
          WHEN title = ? THEN 0
          WHEN title LIKE ? ESCAPE '\\' COLLATE NOCASE THEN 1
          ELSE 2
        END,
        title COLLATE NOCASE,
        title
      LIMIT ? OFFSET ?
    `).all(...asSqlParameters([
      contains,
      contains,
      normalizedQuery,
      prefix,
      normalizedLimit,
      normalizedOffset
    ])) as unknown as StatementRow[]
    signal?.throwIfAborted()
    return rows.map(statementFromRow)
  }

  async read(title: string, signal?: AbortSignal): Promise<KnowledgeStatement | undefined> {
    signal?.throwIfAborted()
    const statement = this.getStatement(title)
    signal?.throwIfAborted()
    return statement
  }

  listStatements(options: ListKnowledgeStatementsOptions = {}): KnowledgeStatement[] {
    this.assertOpen()
    const limit = normalizeLimit(options.limit, 100, MAX_LIST_LIMIT)
    const offset = normalizeOffset(options.offset)
    const rows = this.database.prepare(`
      SELECT title, content
      FROM knowledge_statements
      ORDER BY title COLLATE NOCASE, title
      LIMIT ? OFFSET ?
    `).all(limit, offset) as unknown as StatementRow[]
    return rows.map(statementFromRow)
  }

  browse(input: BrowseKnowledgeInput = {}): KnowledgeBrowseResult {
    this.assertOpen()
    const limit = normalizeLimit(input.limit, 100, MAX_LIST_LIMIT)
    const offset = normalizeOffset(input.offset)
    const query = typeof input.query === 'string' ? input.query.trim() : ''
    if (query.length > 1_024) throw new Error('搜索 query 超出长度上限 1024')
    let rows: StatementSummaryRow[]
    let total: number

    if (query) {
      const escaped = query.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
      const contains = `%${escaped}%`
      const prefix = `${escaped}%`
      total = Number((this.database.prepare(`
        SELECT count(*) AS count
        FROM knowledge_statements
        WHERE title LIKE ? ESCAPE '\\' COLLATE NOCASE
           OR content LIKE ? ESCAPE '\\' COLLATE NOCASE
      `).get(contains, contains) as { count: number }).count)
      rows = this.database.prepare(`
        SELECT title, substr(content, 1, 280) AS preview
        FROM knowledge_statements
        WHERE title LIKE ? ESCAPE '\\' COLLATE NOCASE
           OR content LIKE ? ESCAPE '\\' COLLATE NOCASE
        ORDER BY
          CASE
            WHEN title = ? THEN 0
            WHEN title LIKE ? ESCAPE '\\' COLLATE NOCASE THEN 1
            ELSE 2
          END,
          title COLLATE NOCASE,
          title
        LIMIT ? OFFSET ?
      `).all(contains, contains, query, prefix, limit, offset) as unknown as StatementSummaryRow[]
    } else {
      total = Number((this.database.prepare(`
        SELECT count(*) AS count FROM knowledge_statements
      `).get() as { count: number }).count)
      rows = this.database.prepare(`
        SELECT title, substr(content, 1, 280) AS preview
        FROM knowledge_statements
        ORDER BY title COLLATE NOCASE, title
        LIMIT ? OFFSET ?
      `).all(limit, offset) as unknown as StatementSummaryRow[]
    }

    return {
      statements: rows,
      total,
      ...(offset + rows.length < total ? { nextOffset: offset + rows.length } : {})
    }
  }

  getStatement(title: string): KnowledgeStatement | undefined {
    this.assertOpen()
    const normalizedTitle = requiredTrimmed(
      title,
      'title',
      MAX_KNOWLEDGE_STATEMENT_TITLE_LENGTH
    )
    const row = this.database.prepare(`
      SELECT title, content
      FROM knowledge_statements
      WHERE title = ?
    `).get(normalizedTitle) as StatementRow | undefined
    return row ? statementFromRow(row) : undefined
  }

  getContributionByRunRef(runRef: string): KnowledgeContributionRecord | undefined {
    this.assertOpen()
    const normalizedRunRef = requiredTrimmed(runRef, 'runRef', MAX_RUN_REF_LENGTH)
    const row = this.database.prepare(`
      SELECT run_ref, created_at
      FROM knowledge_contributions
      WHERE run_ref = ?
    `).get(normalizedRunRef) as ContributionRow | undefined
    return row ? contributionFromRow(row) : undefined
  }

  clear(): ClearKnowledgeResult {
    this.assertOpen()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const deletedStatementCount = Number((this.database.prepare(`
        SELECT count(*) AS count FROM knowledge_statements
      `).get() as { count: number }).count)
      const deletedContributionCount = Number((this.database.prepare(`
        SELECT count(*) AS count FROM knowledge_contributions
      `).get() as { count: number }).count)
      this.database.exec(`
        DELETE FROM knowledge_statements;
        DELETE FROM knowledge_contributions;
        COMMIT;
      `)
      return { deletedStatementCount, deletedContributionCount }
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.database.close()
  }
}

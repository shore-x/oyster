import { randomUUID } from 'node:crypto'
import { backup, DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type {
  KnowledgeCommitResult,
  KnowledgeContributionDraft,
  KnowledgeContributionRecord,
  KnowledgeRelationDraft,
  KnowledgeRelationKind,
  KnowledgeSourceDraft,
  KnowledgeStatement,
  KnowledgeStatementDetails,
  KnowledgeStatementDraft,
  KnowledgeStatementRelation,
  KnowledgeStatementSource,
  ListKnowledgeStatementsOptions
} from './model'
import { KNOWLEDGE_RELATION_KINDS } from './model'
import type {
  KnowledgeReader,
  KnowledgeStatementRecord
} from '../knowledge-processing/model'

const SCHEMA_VERSION = 1
const MAX_STATEMENTS_PER_CONTRIBUTION = 100
const MAX_LOCAL_REF_LENGTH = 128
const MAX_RUN_REF_LENGTH = 1_024
const MAX_TITLE_LENGTH = 2_048
const MAX_CONTENT_LENGTH = 1024 * 1024
const MAX_SOURCE_REF_LENGTH = 2_048
const MAX_SELECTOR_LENGTH = 2_048
const MAX_LIST_LIMIT = 1_000
const MAX_SEARCH_LIMIT = 100

interface StatementRow {
  id: string
  title: string
  content: string
  origin_ref: string
  created_at: string
}

interface ContributionRow {
  id: string
  run_ref: string
  created_at: string
}

interface SourceRow {
  statement_id: string
  source_ref: string
  selector: string
}

interface RelationRow {
  source_statement_id: string
  relation: KnowledgeRelationKind
  target_statement_id: string
}

interface NormalizedStatementDraft {
  localRef: string
  title: string
  content: string
  sources: KnowledgeSourceDraft[]
  relations: KnowledgeRelationDraft[]
}

interface NormalizedContributionDraft {
  runRef: string
  statements: NormalizedStatementDraft[]
}

export interface SqliteKnowledgeStoreOptions {
  clock?: () => Date
  idFactory?: () => string
}

function requiredTrimmed(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string') throw new Error(`${label} 必须是字符串`)
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} 不能为空`)
  if (normalized.length > maximum) throw new Error(`${label} 超出长度上限 ${maximum}`)
  return normalized
}

function optionalTrimmed(value: unknown, label: string, maximum: number): string | undefined {
  if (value === undefined) return undefined
  return requiredTrimmed(value, label, maximum)
}

function statementFromRow(row: StatementRow): KnowledgeStatement {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    originRef: row.origin_ref,
    createdAt: row.created_at
  }
}

function contributionFromRow(row: ContributionRow): KnowledgeContributionRecord {
  return {
    id: row.id,
    runRef: row.run_ref,
    createdAt: row.created_at
  }
}

function sourceFromRow(row: SourceRow): KnowledgeStatementSource {
  return {
    statementId: row.statement_id,
    sourceRef: row.source_ref,
    selector: row.selector || undefined
  }
}

function relationFromRow(row: RelationRow): KnowledgeStatementRelation {
  return {
    sourceStatementId: row.source_statement_id,
    relation: row.relation,
    targetStatementId: row.target_statement_id
  }
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

function isRelationKind(value: unknown): value is KnowledgeRelationKind {
  return typeof value === 'string' && KNOWLEDGE_RELATION_KINDS.includes(value as KnowledgeRelationKind)
}

function normalizeSource(source: KnowledgeSourceDraft, statementRef: string): KnowledgeSourceDraft {
  if (!source || typeof source !== 'object') throw new Error(`${statementRef} 的来源格式无效`)
  return {
    sourceRef: requiredTrimmed(source.sourceRef, `${statementRef} sourceRef`, MAX_SOURCE_REF_LENGTH),
    selector: optionalTrimmed(source.selector, `${statementRef} selector`, MAX_SELECTOR_LENGTH)
  }
}

function normalizeRelation(
  relation: KnowledgeRelationDraft,
  statementRef: string
): KnowledgeRelationDraft {
  if (!relation || typeof relation !== 'object') throw new Error(`${statementRef} 的关系格式无效`)
  if (!isRelationKind(relation.relation)) {
    throw new Error(`${statementRef} 的关系只允许 derived_from 或 revises`)
  }
  if (!relation.target || typeof relation.target !== 'object') {
    throw new Error(`${statementRef} 的关系目标无效`)
  }
  if (relation.target.kind === 'statement') {
    return {
      relation: relation.relation,
      target: {
        kind: 'statement',
        statementId: requiredTrimmed(
          relation.target.statementId,
          `${statementRef} target statementId`,
          MAX_SOURCE_REF_LENGTH
        )
      }
    }
  }
  if (relation.target.kind === 'draft') {
    return {
      relation: relation.relation,
      target: {
        kind: 'draft',
        localRef: requiredTrimmed(
          relation.target.localRef,
          `${statementRef} target localRef`,
          MAX_LOCAL_REF_LENGTH
        )
      }
    }
  }
  throw new Error(`${statementRef} 的关系目标类型无效`)
}

function normalizeDraft(draft: KnowledgeContributionDraft): NormalizedContributionDraft {
  if (!draft || typeof draft !== 'object') throw new Error('Knowledge Contribution 格式无效')
  const runRef = requiredTrimmed(draft.runRef, 'runRef', MAX_RUN_REF_LENGTH)
  if (!Array.isArray(draft.statements)) throw new Error('statements 必须是数组')
  if (draft.statements.length > MAX_STATEMENTS_PER_CONTRIBUTION) {
    throw new Error(`一次 Contribution 最多包含 ${MAX_STATEMENTS_PER_CONTRIBUTION} 条 Statement`)
  }

  const localRefs = new Set<string>()
  const statements = draft.statements.map((statement, index): NormalizedStatementDraft => {
    if (!statement || typeof statement !== 'object') throw new Error(`Statement ${index + 1} 格式无效`)
    const localRef = requiredTrimmed(statement.localRef, `Statement ${index + 1} localRef`, MAX_LOCAL_REF_LENGTH)
    if (localRefs.has(localRef)) throw new Error(`Statement localRef 重复：${localRef}`)
    localRefs.add(localRef)
    const title = requiredTrimmed(statement.title, `${localRef} title`, MAX_TITLE_LENGTH)
    if (typeof statement.content !== 'string' || !statement.content.trim()) {
      throw new Error(`${localRef} content 不能为空`)
    }
    if (statement.content.length > MAX_CONTENT_LENGTH) {
      throw new Error(`${localRef} content 超出长度上限 ${MAX_CONTENT_LENGTH}`)
    }
    if (statement.sources !== undefined && !Array.isArray(statement.sources)) {
      throw new Error(`${localRef} sources 必须是数组`)
    }
    if (statement.relations !== undefined && !Array.isArray(statement.relations)) {
      throw new Error(`${localRef} relations 必须是数组`)
    }
    const sources = (statement.sources ?? []).map((source) => normalizeSource(source, localRef))
    const relations = (statement.relations ?? []).map((relation) => normalizeRelation(relation, localRef))

    const sourceKeys = new Set<string>()
    for (const source of sources) {
      const key = `${source.sourceRef}\u0000${source.selector ?? ''}`
      if (sourceKeys.has(key)) throw new Error(`${localRef} 包含重复来源`)
      sourceKeys.add(key)
    }
    const relationKeys = new Set<string>()
    for (const relation of relations) {
      const targetKey = relation.target.kind === 'statement'
        ? `statement:${relation.target.statementId}`
        : `draft:${relation.target.localRef}`
      const key = `${relation.relation}\u0000${targetKey}`
      if (relationKeys.has(key)) throw new Error(`${localRef} 包含重复关系`)
      relationKeys.add(key)
    }

    return { localRef, title, content: statement.content, sources, relations }
  })

  for (const statement of statements) {
    for (const relation of statement.relations) {
      if (relation.target.kind !== 'draft') continue
      if (!localRefs.has(relation.target.localRef)) {
        throw new Error(`${statement.localRef} 引用了不存在的 draft：${relation.target.localRef}`)
      }
      if (relation.target.localRef === statement.localRef) {
        throw new Error(`${statement.localRef} 不能关联自身`)
      }
    }
    const hasKnowledgeProvenance = statement.relations.some(
      (relation) => relation.relation === 'derived_from'
    )
    if (!statement.sources.length && !hasKnowledgeProvenance) {
      throw new Error(`${statement.localRef} 必须包含 Observation 来源或 derived_from 关系`)
    }
  }

  assertNoDraftCycles(statements)
  return { runRef, statements }
}

function assertNoDraftCycles(statements: NormalizedStatementDraft[]): void {
  const edges = new Map<string, string[]>()
  for (const statement of statements) {
    edges.set(
      statement.localRef,
      statement.relations.flatMap((relation) => relation.target.kind === 'draft'
        ? [relation.target.localRef]
        : [])
    )
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()

  const visit = (localRef: string): void => {
    if (visiting.has(localRef)) throw new Error('Knowledge Statement 的本地关系不能形成循环')
    if (visited.has(localRef)) return
    visiting.add(localRef)
    for (const target of edges.get(localRef) ?? []) visit(target)
    visiting.delete(localRef)
    visited.add(localRef)
  }

  for (const localRef of edges.keys()) visit(localRef)
}

function asSqlParameters(values: Array<string | number>): SQLInputValue[] {
  return values
}

/**
 * The authoritative Knowledge Store. Statement content is immutable free text;
 * only Oyster Core's contribution boundary can add Statements and integrity edges.
 */
export class SqliteKnowledgeStore implements KnowledgeReader {
  private readonly database: DatabaseSync
  private readonly clock: () => Date
  private readonly idFactory: () => string
  private closed = false

  constructor(
    readonly databasePath: string,
    options: SqliteKnowledgeStoreOptions = {}
  ) {
    this.clock = options.clock ?? (() => new Date())
    this.idFactory = options.idFactory ?? randomUUID
    this.database = new DatabaseSync(databasePath)
    this.database.exec('PRAGMA foreign_keys = ON')
    this.database.exec('PRAGMA busy_timeout = 5000')
    this.initializeSchema()
  }

  private initializeSchema(): void {
    const version = Number((this.database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
    if (version > SCHEMA_VERSION) {
      throw new Error(`Knowledge Store Schema ${version} 高于当前支持版本 ${SCHEMA_VERSION}`)
    }
    if (version === SCHEMA_VERSION) return

    this.database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE knowledge_contributions (
        id TEXT PRIMARY KEY,
        run_ref TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE knowledge_statements (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL CHECK(length(trim(title)) > 0),
        content TEXT NOT NULL CHECK(length(trim(content)) > 0),
        origin_ref TEXT NOT NULL REFERENCES knowledge_contributions(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE statement_sources (
        statement_id TEXT NOT NULL REFERENCES knowledge_statements(id) ON DELETE RESTRICT,
        source_ref TEXT NOT NULL,
        selector TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (statement_id, source_ref, selector)
      ) STRICT;
      CREATE TABLE statement_relations (
        source_statement_id TEXT NOT NULL REFERENCES knowledge_statements(id) ON DELETE RESTRICT,
        relation TEXT NOT NULL CHECK(relation IN ('derived_from', 'revises')),
        target_statement_id TEXT NOT NULL REFERENCES knowledge_statements(id) ON DELETE RESTRICT,
        CHECK(source_statement_id <> target_statement_id),
        PRIMARY KEY (source_statement_id, relation, target_statement_id)
      ) STRICT;
      CREATE INDEX statement_relations_target
        ON statement_relations(target_statement_id, relation);
      CREATE INDEX knowledge_statements_created_at
        ON knowledge_statements(created_at DESC, id DESC);
      CREATE TRIGGER knowledge_statements_are_immutable
        BEFORE UPDATE ON knowledge_statements
        BEGIN
          SELECT RAISE(ABORT, 'Knowledge Statements are immutable');
        END;
      PRAGMA user_version = ${SCHEMA_VERSION};
      COMMIT;
    `)
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
    const createdAt = this.clock().toISOString()
    const contribution: KnowledgeContributionRecord = {
      id: this.idFactory(),
      runRef: normalized.runRef,
      createdAt
    }
    const statementIdsByLocalRef: Record<string, string> = Object.create(null) as Record<string, string>
    for (const statement of normalized.statements) {
      statementIdsByLocalRef[statement.localRef] = this.idFactory()
    }

    this.database.exec('BEGIN IMMEDIATE')
    try {
      const duplicate = this.database.prepare(
        'SELECT id FROM knowledge_contributions WHERE run_ref = ?'
      ).get(normalized.runRef)
      if (duplicate) throw new Error(`runRef 已提交 Knowledge Contribution：${normalized.runRef}`)

      const existingStatement = this.database.prepare(
        'SELECT id FROM knowledge_statements WHERE id = ?'
      )
      for (const statement of normalized.statements) {
        for (const relation of statement.relations) {
          if (relation.target.kind === 'statement' && !existingStatement.get(relation.target.statementId)) {
            throw new Error(`${statement.localRef} 引用了不存在的 Statement：${relation.target.statementId}`)
          }
        }
      }

      this.database.prepare(`
        INSERT INTO knowledge_contributions (id, run_ref, created_at)
        VALUES (?, ?, ?)
      `).run(contribution.id, contribution.runRef, contribution.createdAt)

      const insertStatement = this.database.prepare(`
        INSERT INTO knowledge_statements (id, title, content, origin_ref, created_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      const statements: KnowledgeStatement[] = normalized.statements.map((statement) => {
        const record: KnowledgeStatement = {
          id: statementIdsByLocalRef[statement.localRef],
          title: statement.title,
          content: statement.content,
          originRef: contribution.id,
          createdAt
        }
        insertStatement.run(record.id, record.title, record.content, record.originRef, record.createdAt)
        return record
      })

      const insertSource = this.database.prepare(`
        INSERT INTO statement_sources (statement_id, source_ref, selector)
        VALUES (?, ?, ?)
      `)
      const sources: KnowledgeStatementSource[] = []
      for (const statement of normalized.statements) {
        const statementId = statementIdsByLocalRef[statement.localRef]
        for (const source of statement.sources) {
          const record: KnowledgeStatementSource = {
            statementId,
            sourceRef: source.sourceRef,
            selector: source.selector
          }
          insertSource.run(record.statementId, record.sourceRef, record.selector ?? '')
          sources.push(record)
        }
      }

      const insertRelation = this.database.prepare(`
        INSERT INTO statement_relations (source_statement_id, relation, target_statement_id)
        VALUES (?, ?, ?)
      `)
      const relations: KnowledgeStatementRelation[] = []
      for (const statement of normalized.statements) {
        const sourceStatementId = statementIdsByLocalRef[statement.localRef]
        for (const relation of statement.relations) {
          const targetStatementId = relation.target.kind === 'statement'
            ? relation.target.statementId
            : statementIdsByLocalRef[relation.target.localRef]
          const record: KnowledgeStatementRelation = {
            sourceStatementId,
            relation: relation.relation,
            targetStatementId
          }
          insertRelation.run(record.sourceStatementId, record.relation, record.targetStatementId)
          relations.push(record)
        }
      }

      this.database.exec('COMMIT')
      return { contribution, statements, sources, relations, statementIdsByLocalRef }
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  async search(query: string, limit?: number, signal?: AbortSignal): Promise<KnowledgeStatementRecord[]> {
    this.assertOpen()
    signal?.throwIfAborted()
    const normalizedQuery = requiredTrimmed(query, '搜索 query', 1_024)
    const normalizedLimit = normalizeLimit(limit, 8, MAX_SEARCH_LIMIT)
    const contains = `%${normalizedQuery.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`
    const prefix = `${normalizedQuery.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`
    const rows = this.database.prepare(`
      SELECT s.id, s.title, s.content, s.origin_ref, s.created_at
      FROM knowledge_statements s
      WHERE (s.title LIKE ? ESCAPE '\\' COLLATE NOCASE OR s.content LIKE ? ESCAPE '\\' COLLATE NOCASE)
        AND NOT EXISTS (
          SELECT 1 FROM statement_relations revision
          WHERE revision.relation = 'revises' AND revision.target_statement_id = s.id
        )
      ORDER BY
        CASE
          WHEN s.title = ? COLLATE NOCASE THEN 0
          WHEN s.title LIKE ? ESCAPE '\\' COLLATE NOCASE THEN 1
          ELSE 2
        END,
        s.created_at DESC,
        s.id DESC
      LIMIT ?
    `).all(...asSqlParameters([contains, contains, normalizedQuery, prefix, normalizedLimit])) as unknown as StatementRow[]
    signal?.throwIfAborted()
    return rows.map((row) => ({ id: row.id, title: row.title, content: row.content }))
  }

  async read(statementId: string, signal?: AbortSignal): Promise<KnowledgeStatementRecord | undefined> {
    signal?.throwIfAborted()
    const details = this.getStatement(statementId)
    signal?.throwIfAborted()
    return details
      ? { id: details.statement.id, title: details.statement.title, content: details.statement.content }
      : undefined
  }

  listStatements(options: ListKnowledgeStatementsOptions = {}): KnowledgeStatement[] {
    this.assertOpen()
    const limit = normalizeLimit(options.limit, 100, MAX_LIST_LIMIT)
    const offset = normalizeOffset(options.offset)
    const currentOnly = options.includeRevised
      ? ''
      : `WHERE NOT EXISTS (
          SELECT 1 FROM statement_relations revision
          WHERE revision.relation = 'revises' AND revision.target_statement_id = s.id
        )`
    const rows = this.database.prepare(`
      SELECT s.id, s.title, s.content, s.origin_ref, s.created_at
      FROM knowledge_statements s
      ${currentOnly}
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset) as unknown as StatementRow[]
    return rows.map(statementFromRow)
  }

  getStatement(statementId: string): KnowledgeStatementDetails | undefined {
    this.assertOpen()
    const normalizedId = requiredTrimmed(statementId, 'statementId', MAX_SOURCE_REF_LENGTH)
    const row = this.database.prepare(`
      SELECT id, title, content, origin_ref, created_at
      FROM knowledge_statements
      WHERE id = ?
    `).get(normalizedId) as StatementRow | undefined
    if (!row) return undefined

    const sourceRows = this.database.prepare(`
      SELECT statement_id, source_ref, selector
      FROM statement_sources
      WHERE statement_id = ?
      ORDER BY source_ref, selector
    `).all(normalizedId) as unknown as SourceRow[]
    const outgoingRows = this.database.prepare(`
      SELECT source_statement_id, relation, target_statement_id
      FROM statement_relations
      WHERE source_statement_id = ?
      ORDER BY relation, target_statement_id
    `).all(normalizedId) as unknown as RelationRow[]
    const incomingRows = this.database.prepare(`
      SELECT source_statement_id, relation, target_statement_id
      FROM statement_relations
      WHERE target_statement_id = ?
      ORDER BY relation, source_statement_id
    `).all(normalizedId) as unknown as RelationRow[]
    return {
      statement: statementFromRow(row),
      sources: sourceRows.map(sourceFromRow),
      outgoingRelations: outgoingRows.map(relationFromRow),
      incomingRelations: incomingRows.map(relationFromRow)
    }
  }

  getContributionByRunRef(runRef: string): KnowledgeContributionRecord | undefined {
    this.assertOpen()
    const normalizedRunRef = requiredTrimmed(runRef, 'runRef', MAX_RUN_REF_LENGTH)
    const row = this.database.prepare(`
      SELECT id, run_ref, created_at
      FROM knowledge_contributions
      WHERE run_ref = ?
    `).get(normalizedRunRef) as ContributionRow | undefined
    return row ? contributionFromRow(row) : undefined
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.database.close()
  }
}


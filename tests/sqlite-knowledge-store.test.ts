import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteKnowledgeStore } from '../src/main/knowledge-store/sqlite-knowledge-store'
import { SqliteKnowledgeStoreManager } from '../src/main/knowledge-store/knowledge-store-manager'
import { MAX_KNOWLEDGE_STATEMENT_CONTENT_LENGTH } from '../src/shared/knowledge'

const temporaryDirectories: string[] = []
const closeables: Array<{ close(): void }> = []

async function temporaryPath(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

function createV1Database(
  databasePath: string,
  statements: Array<{ id: string; title: string; content: string }>
): void {
  const database = new DatabaseSync(databasePath)
  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
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
      CREATE TRIGGER knowledge_statements_are_immutable
        BEFORE UPDATE ON knowledge_statements
        BEGIN
          SELECT RAISE(ABORT, 'Knowledge Statements are immutable');
        END;
      INSERT INTO knowledge_contributions (id, run_ref, created_at)
      VALUES ('legacy-contribution', 'run:legacy', '2026-07-27T00:00:00.000Z');
      PRAGMA user_version = 1;
    `)
    const insert = database.prepare(`
      INSERT INTO knowledge_statements (id, title, content, origin_ref, created_at)
      VALUES (?, ?, ?, 'legacy-contribution', '2026-07-27T00:00:00.000Z')
    `)
    for (const statement of statements) {
      insert.run(statement.id, statement.title, statement.content)
      database.prepare(`
        INSERT INTO statement_sources (statement_id, source_ref, selector)
        VALUES (?, 'raw:legacy', 'L000001-L000002')
      `).run(statement.id)
    }
  } finally {
    database.close()
  }
}

afterEach(async () => {
  for (const closeable of closeables.splice(0)) closeable.close()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )))
})

describe('SqliteKnowledgeStore', () => {
  it('records an empty runtime envelope without inventing Statements', async () => {
    const directory = await temporaryPath('oyster-knowledge-store-')
    const store = new SqliteKnowledgeStore(join(directory, 'knowledge.sqlite'))
    closeables.push(store)

    const result = store.commit({ runRef: 'run:empty', statements: [] })

    expect(result.statements).toEqual([])
    expect(result.createdTitles).toEqual([])
    expect(result.updatedTitles).toEqual([])
    expect(store.getContributionByRunRef('run:empty')).toEqual(result.contribution)
    expect(store.listStatements()).toEqual([])
    expect(() => store.commit({ runRef: 'run:empty', statements: [] })).toThrow('runRef 已提交')
  })

  it('creates and updates one Statement by its trimmed canonical title', async () => {
    const directory = await temporaryPath('oyster-knowledge-store-')
    const store = new SqliteKnowledgeStore(join(directory, 'knowledge.sqlite'))
    closeables.push(store)
    const originalContent = '  Original Markdown body.\n'

    const created = store.commit({
      runRef: 'run:create',
      statements: [{ title: '  Oyster Knowledge Store  ', content: originalContent }]
    })

    expect(created.createdTitles).toEqual(['Oyster Knowledge Store'])
    expect(created.updatedTitles).toEqual([])
    expect(created.statements).toEqual([{
      title: 'Oyster Knowledge Store',
      content: originalContent
    }])
    expect(store.getStatement(' Oyster Knowledge Store ')).toEqual(created.statements[0])

    const updatedContent = 'The store uses [[canonical title]] references as plain text.'
    const updated = store.commit({
      runRef: 'run:update',
      statements: [{ title: 'Oyster Knowledge Store', content: updatedContent }]
    })

    expect(updated.createdTitles).toEqual([])
    expect(updated.updatedTitles).toEqual(['Oyster Knowledge Store'])
    expect(store.listStatements()).toEqual([{
      title: 'Oyster Knowledge Store',
      content: updatedContent
    }])
  })

  it('preserves dynamic title references verbatim while their targets update independently', async () => {
    const directory = await temporaryPath('oyster-knowledge-store-')
    const store = new SqliteKnowledgeStore(join(directory, 'knowledge.sqlite'))
    closeables.push(store)
    const referencingBody = [
      'This depends on [[Target Statement]].',
      'It also names [[Context Statement|the current context]].'
    ].join('\n')

    store.commit({
      runRef: 'run:references',
      statements: [
        { title: 'Referencing Statement', content: referencingBody },
        { title: 'Target Statement', content: 'Old target meaning.' },
        { title: 'Context Statement', content: 'Context meaning.' }
      ]
    })
    store.commit({
      runRef: 'run:update-target',
      statements: [{ title: 'Target Statement', content: 'Current target meaning.' }]
    })

    expect(await store.read('Referencing Statement')).toEqual({
      title: 'Referencing Statement',
      content: referencingBody
    })
    expect(await store.read('Target Statement')).toEqual({
      title: 'Target Statement',
      content: 'Current target meaning.'
    })
  })

  it('atomically rejects duplicate canonical titles in one Contribution after trimming', async () => {
    const directory = await temporaryPath('oyster-knowledge-store-')
    const store = new SqliteKnowledgeStore(join(directory, 'knowledge.sqlite'))
    closeables.push(store)

    expect(() => store.commit({
      runRef: 'run:duplicate-titles',
      statements: [
        { title: 'Duplicate', content: 'First body.' },
        { title: ' Duplicate ', content: 'Second body.' }
      ]
    })).toThrow('canonical title 重复：Duplicate')

    expect(store.getContributionByRunRef('run:duplicate-titles')).toBeUndefined()
    expect(store.listStatements()).toEqual([])
  })

  it('enforces the shared per-Statement content boundary', async () => {
    const directory = await temporaryPath('oyster-knowledge-store-')
    const store = new SqliteKnowledgeStore(join(directory, 'knowledge.sqlite'))
    closeables.push(store)

    expect(() => store.commit({
      runRef: 'run:oversized-statement',
      statements: [{
        title: 'Oversized Statement',
        content: 'x'.repeat(MAX_KNOWLEDGE_STATEMENT_CONTENT_LENGTH + 1)
      }]
    })).toThrow(`content 超出长度上限 ${MAX_KNOWLEDGE_STATEMENT_CONTENT_LENGTH}`)

    expect(store.getContributionByRunRef('run:oversized-statement')).toBeUndefined()
  })

  it('searches title and body while exact title reads remain exact', async () => {
    const directory = await temporaryPath('oyster-knowledge-store-')
    const store = new SqliteKnowledgeStore(join(directory, 'knowledge.sqlite'))
    closeables.push(store)
    store.commit({
      runRef: 'run:search',
      statements: [
        { title: 'Database', content: 'A general storage concept.' },
        { title: 'Oyster Database', content: 'The local SQLite knowledge store.' },
        { title: 'Persistence boundary', content: 'The database is behind this boundary.' }
      ]
    })

    const results = await store.search('Database', 2)
    expect(results[0]).toEqual({ title: 'Database', content: 'A general storage concept.' })
    expect(results).toHaveLength(2)
    expect(await store.search('Database', 2, 2)).toEqual([
      { title: 'Persistence boundary', content: 'The database is behind this boundary.' }
    ])
    expect(await store.read('Database')).toEqual(results[0])
    expect(await store.read('database')).toBeUndefined()
  })

  it('migrates an unambiguous v1 Store and archives all legacy structures', async () => {
    const directory = await temporaryPath('oyster-knowledge-migration-')
    const databasePath = join(directory, 'knowledge.sqlite')
    createV1Database(databasePath, [
      { id: 'legacy-a', title: ' Legacy A ', content: 'Legacy A body.' },
      { id: 'legacy-b', title: 'Legacy B', content: 'Legacy B body.' }
    ])

    const store = new SqliteKnowledgeStore(databasePath)
    closeables.push(store)

    expect(store.listStatements()).toEqual([
      { title: 'Legacy A', content: 'Legacy A body.' },
      { title: 'Legacy B', content: 'Legacy B body.' }
    ])
    expect(store.getContributionByRunRef('run:legacy')).toBeDefined()

    const database = new DatabaseSync(databasePath)
    closeables.push({ close: () => database.close() })
    expect((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2)
    const archivedTables = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'legacy_v1_%'
      ORDER BY name
    `).all() as unknown as Array<{ name: string }>
    expect(archivedTables.map(({ name }) => name)).toEqual([
      'legacy_v1_knowledge_contributions',
      'legacy_v1_knowledge_statements',
      'legacy_v1_statement_relations',
      'legacy_v1_statement_sources'
    ])
    expect((database.prepare(`
      SELECT count(*) AS count FROM legacy_v1_statement_sources
    `).get() as { count: number }).count).toBe(2)
  })

  it('refuses an ambiguous v1 migration without changing or hiding legacy data', async () => {
    const directory = await temporaryPath('oyster-knowledge-migration-')
    const databasePath = join(directory, 'knowledge.sqlite')
    createV1Database(databasePath, [
      { id: 'legacy-a', title: 'Duplicate title', content: 'First legacy meaning.' },
      { id: 'legacy-b', title: 'Duplicate title', content: 'Second legacy meaning.' }
    ])

    expect(() => new SqliteKnowledgeStore(databasePath)).toThrow(
      '包含 2 条同名 Statement（Duplicate title），无法安全迁移'
    )

    const database = new DatabaseSync(databasePath)
    closeables.push({ close: () => database.close() })
    expect((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1)
    expect((database.prepare(`
      SELECT count(*) AS count FROM knowledge_statements
    `).get() as { count: number }).count).toBe(2)
    expect(database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'legacy_v1_knowledge_statements'
    `).get()).toBeUndefined()
  })
})

describe('SqliteKnowledgeStoreManager', () => {
  it('isolates title-based updates inside disposable Sandbox snapshots', async () => {
    const directory = await temporaryPath('oyster-knowledge-manager-')
    const manager = await SqliteKnowledgeStoreManager.open(directory)
    closeables.push(manager)
    manager.production.commit({
      runRef: 'run:production-baseline',
      statements: [{ title: 'Shared title', content: 'Production meaning.' }]
    })

    const first = await manager.createSandbox()
    first.store.commit({
      runRef: 'run:sandbox-update',
      statements: [
        { title: 'Shared title', content: 'Sandbox meaning.' },
        { title: 'Sandbox-only title', content: 'Only visible in this Sandbox.' }
      ]
    })

    expect(first.store.getStatement('Shared title')?.content).toBe('Sandbox meaning.')
    expect(manager.production.getStatement('Shared title')?.content).toBe('Production meaning.')
    expect(manager.production.getStatement('Sandbox-only title')).toBeUndefined()
    expect((await manager.listSandboxes()).map((sandbox) => sandbox.id)).toContain(first.id)

    const second = await manager.createSandbox()
    expect(second.store.getStatement('Shared title')?.content).toBe('Production meaning.')
    expect(second.store.getStatement('Sandbox-only title')).toBeUndefined()

    await manager.discardSandbox(first.id)
    await expect(stat(first.databasePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects paths that are not Core-issued Sandbox IDs', async () => {
    const directory = await temporaryPath('oyster-knowledge-manager-')
    const manager = await SqliteKnowledgeStoreManager.open(directory)
    closeables.push(manager)

    await expect(manager.openSandbox('../knowledge.sqlite')).rejects.toThrow('Sandbox ID 无效')
    await expect(manager.discardSandbox('../knowledge.sqlite')).rejects.toThrow('Sandbox ID 无效')
  })
})

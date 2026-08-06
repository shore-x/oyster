import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteKnowledgeStore } from '../src/main/knowledge-store/sqlite-knowledge-store'
import { MAX_KNOWLEDGE_STATEMENT_CONTENT_LENGTH } from '../src/shared/knowledge'

const temporaryDirectories: string[] = []
const closeables: Array<{ close(): void }> = []

async function temporaryPath(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

function createPriorDatabase(
  databasePath: string,
  statements: Array<{ title: string; content: string }>
): void {
  const database = new DatabaseSync(databasePath)
  try {
    database.exec(`
      CREATE TABLE knowledge_contributions (
        run_ref TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE knowledge_statements (
        title TEXT NOT NULL CHECK(length(trim(title)) > 0),
        content TEXT NOT NULL CHECK(length(trim(content)) > 0)
      ) STRICT;
      CREATE TABLE discarded_auxiliary (
        payload TEXT NOT NULL
      ) STRICT;
      INSERT INTO knowledge_contributions (run_ref, created_at)
      VALUES ('run:prior', '2026-07-27T00:00:00.000Z');
      INSERT INTO discarded_auxiliary (payload) VALUES ('not part of the current model');
      PRAGMA user_version = 2;
    `)
    const insert = database.prepare(`
      INSERT INTO knowledge_statements (title, content)
      VALUES (?, ?)
    `)
    for (const statement of statements) {
      insert.run(statement.title, statement.content)
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

  it('atomically clears Statements and their Contribution records', async () => {
    const directory = await temporaryPath('oyster-knowledge-store-')
    const store = new SqliteKnowledgeStore(join(directory, 'knowledge.sqlite'))
    closeables.push(store)
    store.commit({
      runRef: 'run:clear-one',
      statements: [{ title: 'First Statement', content: 'First body.' }]
    })
    store.commit({
      runRef: 'run:clear-two',
      statements: [{ title: 'Second Statement', content: 'Second body.' }]
    })

    expect(store.clear()).toEqual({
      deletedStatementCount: 2,
      deletedContributionCount: 2
    })
    expect(store.listStatements()).toEqual([])
    expect(store.getContributionByRunRef('run:clear-one')).toBeUndefined()
    expect(store.clear()).toEqual({
      deletedStatementCount: 0,
      deletedContributionCount: 0
    })
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

  it('browses compact previews with search ranking and pagination', async () => {
    const directory = await temporaryPath('oyster-knowledge-browser-')
    const store = new SqliteKnowledgeStore(join(directory, 'knowledge.sqlite'))
    closeables.push(store)
    store.commit({
      runRef: 'run:browse',
      statements: [
        { title: 'Database', content: `General database concept. ${'x'.repeat(400)}` },
        { title: 'Oyster Database', content: 'The local SQLite knowledge store.' },
        { title: 'Persistence boundary', content: 'The database sits behind this boundary.' }
      ]
    })

    const firstPage = store.browse({ limit: 2 })
    expect(firstPage.total).toBe(3)
    expect(firstPage.statements).toHaveLength(2)
    expect(firstPage.statements[0].preview.length).toBeLessThanOrEqual(280)
    expect(firstPage.nextOffset).toBe(2)
    const secondPage = store.browse({ limit: 2, offset: firstPage.nextOffset })
    expect(secondPage).toMatchObject({
      total: 3,
      statements: [{ title: 'Persistence boundary' }]
    })
    expect(secondPage.nextOffset).toBeUndefined()

    const search = store.browse({ query: 'Database', limit: 3 })
    expect(search.statements.map(({ title }) => title)).toEqual([
      'Database',
      'Oyster Database',
      'Persistence boundary'
    ])
  })

  it('rebuilds an unambiguous prior Store from only the current model fields', async () => {
    const directory = await temporaryPath('oyster-knowledge-migration-')
    const databasePath = join(directory, 'knowledge.sqlite')
    createPriorDatabase(databasePath, [
      { title: ' Prior A ', content: 'Prior A body.' },
      { title: 'Prior B', content: 'Prior B body.' }
    ])

    const store = new SqliteKnowledgeStore(databasePath)
    closeables.push(store)

    expect(store.listStatements()).toEqual([
      { title: 'Prior A', content: 'Prior A body.' },
      { title: 'Prior B', content: 'Prior B body.' }
    ])
    expect(store.getContributionByRunRef('run:prior')).toEqual({
      runRef: 'run:prior',
      createdAt: '2026-07-27T00:00:00.000Z'
    })

    const database = new DatabaseSync(databasePath)
    closeables.push({ close: () => database.close() })
    expect((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(3)
    const tables = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as unknown as Array<{ name: string }>
    expect(tables.map(({ name }) => name)).toEqual([
      'knowledge_contributions',
      'knowledge_statements'
    ])
    expect((database.prepare('PRAGMA table_info(knowledge_contributions)').all() as Array<{ name: string }>)
      .map(({ name }) => name)).toEqual(['run_ref', 'created_at'])
    expect((database.prepare('PRAGMA table_info(knowledge_statements)').all() as Array<{ name: string }>)
      .map(({ name }) => name)).toEqual(['title', 'content'])
  })

  it('refuses an ambiguous migration before changing the prior Store', async () => {
    const directory = await temporaryPath('oyster-knowledge-migration-')
    const databasePath = join(directory, 'knowledge.sqlite')
    createPriorDatabase(databasePath, [
      { title: 'Duplicate title', content: 'First prior meaning.' },
      { title: 'Duplicate title', content: 'Second prior meaning.' }
    ])

    expect(() => new SqliteKnowledgeStore(databasePath)).toThrow(
      '包含 2 条同名 Statement（Duplicate title），无法安全迁移'
    )

    const database = new DatabaseSync(databasePath)
    closeables.push({ close: () => database.close() })
    expect((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2)
    expect((database.prepare(`
      SELECT count(*) AS count FROM knowledge_statements
    `).get() as { count: number }).count).toBe(2)
    expect(database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'discarded_auxiliary'
    `).get()).toBeDefined()
  })
})

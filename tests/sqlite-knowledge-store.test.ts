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

afterEach(async () => {
  for (const closeable of closeables.splice(0)) closeable.close()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('SqliteKnowledgeStore', () => {
  it('records an explicit no-op contribution without inventing Statements', async () => {
    const directory = await temporaryPath('oyster-knowledge-store-')
    const store = new SqliteKnowledgeStore(join(directory, 'knowledge.sqlite'))
    closeables.push(store)

    const result = store.commit({ runRef: 'run:empty', statements: [] })

    expect(result.statements).toEqual([])
    expect(result.sources).toEqual([])
    expect(result.relations).toEqual([])
    expect(result.statementIdsByLocalRef).toEqual({})
    expect(store.getContributionByRunRef('run:empty')).toEqual(result.contribution)
    expect(store.listStatements()).toEqual([])
    expect(() => store.commit({ runRef: 'run:empty', statements: [] })).toThrow('runRef 已提交')
  })

  it('does not impose an arbitrary Statement count on one atomic Contribution', async () => {
    const directory = await temporaryPath('oyster-knowledge-store-')
    const store = new SqliteKnowledgeStore(join(directory, 'knowledge.sqlite'))
    closeables.push(store)
    const statements = Array.from({ length: 101 }, (_, index) => ({
      localRef: `statement-${index}`,
      title: `Statement ${index}`,
      content: `Knowledge ${index}.`,
      sources: [{ sourceRef: 'raw:large-contribution' }]
    }))

    const result = store.commit({ runRef: 'run:large-contribution', statements })

    expect(result.statements).toHaveLength(101)
    expect(result.sources).toHaveLength(101)
  })

  it('enforces the shared per-Statement content boundary', async () => {
    const directory = await temporaryPath('oyster-knowledge-store-')
    const store = new SqliteKnowledgeStore(join(directory, 'knowledge.sqlite'))
    closeables.push(store)

    expect(() => store.commit({
      runRef: 'run:oversized-statement',
      statements: [{
        localRef: 'oversized',
        title: 'Oversized Statement',
        content: 'x'.repeat(MAX_KNOWLEDGE_STATEMENT_CONTENT_LENGTH + 1),
        sources: [{ sourceRef: 'raw:oversized' }]
      }]
    })).toThrow(`content 超出长度上限 ${MAX_KNOWLEDGE_STATEMENT_CONTENT_LENGTH}`)

    expect(store.getContributionByRunRef('run:oversized-statement')).toBeUndefined()
  })

  it('atomically commits free-text Statements, provenance, and minimal relations', async () => {
    const directory = await temporaryPath('oyster-knowledge-store-')
    const store = new SqliteKnowledgeStore(join(directory, 'knowledge.sqlite'))
    closeables.push(store)

    const baseline = store.commit({
      runRef: 'run:baseline',
      statements: [{
        localRef: 'old-preference',
        title: 'Old editor preference',
        content: 'The user preferred Editor A.',
        sources: [{ sourceRef: 'raw:session-1@sha256:old', selector: 'L000001-L000004' }]
      }]
    })
    const oldId = baseline.statementIdsByLocalRef['old-preference']

    const result = store.commit({
      runRef: 'run:update',
      statements: [
        {
          localRef: 'current-preference',
          title: 'Current editor preference',
          content: 'The user now prefers **Editor B**.\n\nKeep this Markdown.',
          sources: [{ sourceRef: 'raw:session-2@sha256:new', selector: 'L000020-L000024' }],
          relations: [{
            relation: 'revises',
            target: { kind: 'statement', statementId: oldId }
          }]
        },
        {
          localRef: 'workflow-choice',
          title: 'Workflow choice',
          content: 'Use Editor B for the current workflow.',
          relations: [{
            relation: 'derived_from',
            target: { kind: 'draft', localRef: 'current-preference' }
          }]
        }
      ]
    })

    expect(Object.keys(result.statementIdsByLocalRef)).toEqual([
      'current-preference',
      'workflow-choice'
    ])
    expect(result.sources).toEqual([expect.objectContaining({
      statementId: result.statementIdsByLocalRef['current-preference'],
      sourceRef: 'raw:session-2@sha256:new',
      selector: 'L000020-L000024'
    })])
    expect(result.relations).toEqual(expect.arrayContaining([
      {
        sourceStatementId: result.statementIdsByLocalRef['current-preference'],
        relation: 'revises',
        targetStatementId: oldId
      },
      {
        sourceStatementId: result.statementIdsByLocalRef['workflow-choice'],
        relation: 'derived_from',
        targetStatementId: result.statementIdsByLocalRef['current-preference']
      }
    ]))

    const currentIds = store.listStatements().map((statement) => statement.id)
    expect(currentIds).toContain(result.statementIdsByLocalRef['current-preference'])
    expect(currentIds).toContain(result.statementIdsByLocalRef['workflow-choice'])
    expect(currentIds).not.toContain(oldId)
    expect(store.listStatements({ includeRevised: true }).map((statement) => statement.id)).toContain(oldId)

    const oldDetails = store.getStatement(oldId)
    expect(oldDetails?.incomingRelations).toContainEqual(expect.objectContaining({
      relation: 'revises',
      sourceStatementId: result.statementIdsByLocalRef['current-preference']
    }))
    expect(await store.search('editor preference', 10)).toEqual([
      expect.objectContaining({ id: result.statementIdsByLocalRef['current-preference'] })
    ])
    expect(await store.read(oldId)).toEqual(expect.objectContaining({ id: oldId }))
  })

  it('rolls back the entire Contribution when any target is invalid', async () => {
    const directory = await temporaryPath('oyster-knowledge-store-')
    const store = new SqliteKnowledgeStore(join(directory, 'knowledge.sqlite'))
    closeables.push(store)

    expect(() => store.commit({
      runRef: 'run:invalid',
      statements: [{
        localRef: 'invalid-target',
        title: 'Would otherwise be valid',
        content: 'This row must not survive the failed transaction.',
        sources: [{ sourceRef: 'raw:session' }],
        relations: [{
          relation: 'revises',
          target: { kind: 'statement', statementId: 'missing-statement' }
        }]
      }]
    })).toThrow('不存在的 Statement')

    expect(store.getContributionByRunRef('run:invalid')).toBeUndefined()
    expect(store.listStatements({ includeRevised: true })).toEqual([])
  })

  it('rejects source-less knowledge and cyclic draft relations before writing', async () => {
    const directory = await temporaryPath('oyster-knowledge-store-')
    const store = new SqliteKnowledgeStore(join(directory, 'knowledge.sqlite'))
    closeables.push(store)

    expect(() => store.commit({
      runRef: 'run:no-source',
      statements: [{ localRef: 'orphan', title: 'Orphan', content: 'No provenance.' }]
    })).toThrow('必须包含 Observation 来源或 derived_from 关系')

    expect(() => store.commit({
      runRef: 'run:cycle',
      statements: [
        {
          localRef: 'a',
          title: 'A',
          content: 'A derives from B.',
          relations: [{ relation: 'derived_from', target: { kind: 'draft', localRef: 'b' } }]
        },
        {
          localRef: 'b',
          title: 'B',
          content: 'B derives from A.',
          relations: [{ relation: 'derived_from', target: { kind: 'draft', localRef: 'a' } }]
        }
      ]
    })).toThrow('不能形成循环')

    expect(store.listStatements({ includeRevised: true })).toEqual([])
  })

  it('detects a deeply nested draft cycle without recursive stack growth', async () => {
    const directory = await temporaryPath('oyster-knowledge-store-')
    const store = new SqliteKnowledgeStore(join(directory, 'knowledge.sqlite'))
    closeables.push(store)
    const statementCount = 15_000
    const statements = Array.from({ length: statementCount }, (_, index) => ({
      localRef: `deep-${index}`,
      title: `Deep ${index}`,
      content: `Deep relation ${index}.`,
      relations: [{
        relation: 'derived_from' as const,
        target: {
          kind: 'draft' as const,
          localRef: `deep-${(index + 1) % statementCount}`
        }
      }]
    }))

    expect(() => store.commit({
      runRef: 'run:deep-cycle',
      statements
    })).toThrow('Knowledge Statement 的本地关系不能形成循环')
    expect(store.getContributionByRunRef('run:deep-cycle')).toBeUndefined()
  })

  it('enforces Statement immutability at the database boundary', async () => {
    const directory = await temporaryPath('oyster-knowledge-store-')
    const databasePath = join(directory, 'knowledge.sqlite')
    const store = new SqliteKnowledgeStore(databasePath)
    closeables.push(store)
    const result = store.commit({
      runRef: 'run:immutable',
      statements: [{
        localRef: 'statement',
        title: 'Immutable',
        content: 'Original content.',
        sources: [{ sourceRef: 'raw:immutable' }]
      }]
    })

    const direct = new DatabaseSync(databasePath)
    closeables.push({ close: () => direct.close() })
    expect(() => direct.prepare(
      'UPDATE knowledge_statements SET content = ? WHERE id = ?'
    ).run('Changed content.', result.statements[0].id)).toThrow('Knowledge Statements are immutable')
    expect(store.getStatement(result.statements[0].id)?.statement.content).toBe('Original content.')
  })
})

describe('SqliteKnowledgeStoreManager', () => {
  it('creates repeatable physical sandboxes without changing production knowledge', async () => {
    const directory = await temporaryPath('oyster-knowledge-manager-')
    const manager = await SqliteKnowledgeStoreManager.open(directory)
    closeables.push(manager)
    const baseline = manager.production.commit({
      runRef: 'run:production-baseline',
      statements: [{
        localRef: 'baseline',
        title: 'Production baseline',
        content: 'This Statement exists before the test.',
        sources: [{ sourceRef: 'raw:baseline' }]
      }]
    })

    const first = await manager.createSandbox()
    expect(first.store.getStatement(baseline.statements[0].id)?.statement.title).toBe('Production baseline')
    const sandboxOnly = first.store.commit({
      runRef: 'run:sandbox-only',
      statements: [{
        localRef: 'sandbox-only',
        title: 'Sandbox-only result',
        content: 'This must never appear in production.',
        sources: [{ sourceRef: 'raw:test-session' }]
      }]
    })
    expect(first.store.getStatement(sandboxOnly.statements[0].id)).toBeDefined()
    expect(manager.production.getStatement(sandboxOnly.statements[0].id)).toBeUndefined()
    expect((await manager.listSandboxes()).map((sandbox) => sandbox.id)).toContain(first.id)

    const second = await manager.createSandbox()
    expect(second.store.getStatement(baseline.statements[0].id)).toBeDefined()
    expect(second.store.getStatement(sandboxOnly.statements[0].id)).toBeUndefined()

    await manager.discardSandbox(first.id)
    await expect(stat(first.databasePath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(manager.production.getStatement(baseline.statements[0].id)).toBeDefined()
  })

  it('rejects paths that are not Core-issued Sandbox IDs', async () => {
    const directory = await temporaryPath('oyster-knowledge-manager-')
    const manager = await SqliteKnowledgeStoreManager.open(directory)
    closeables.push(manager)

    await expect(manager.openSandbox('../knowledge.sqlite')).rejects.toThrow('Sandbox ID 无效')
    await expect(manager.discardSandbox('../knowledge.sqlite')).rejects.toThrow('Sandbox ID 无效')
  })
})

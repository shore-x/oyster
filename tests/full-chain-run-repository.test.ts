import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  KnowledgeFullChainResult,
  KnowledgeFullChainRunRecord
} from '../src/shared/knowledge-processing'
import { SqliteKnowledgeFullChainRunRepository } from '../src/main/knowledge-processing/full-chain-run-repository'

const temporaryDirectories: string[] = []

function record(
  runId: string,
  completedAt: string,
  title: string
): KnowledgeFullChainRunRecord {
  const debugTrace = {
    id: runId,
    origin: 'full_chain' as const,
    status: 'completed' as const,
    startedAt: completedAt
  }
  const result = {
    runId,
    session: {
      sourceRecordId: `source-record:${runId}`,
      sourceId: 'source:codex',
      agentType: 'codex',
      sourceDisplayName: 'Codex',
      externalId: `session:${runId}`,
      title,
      projectPath: '/projects/oyster',
      startedAt: '2026-07-20T10:00:00.000Z',
      endedAt: '2026-07-20T10:30:00.000Z',
      sizeBytes: 512,
      revision: 'a'.repeat(64)
    },
    sandbox: { id: `sandbox:${runId}`, baselineCreatedAt: completedAt },
    sourceRef: `raw:${runId}`,
    preprocessing: {
      statementCandidates: [{
        expression: 'Database',
        question: 'What does Database denote?',
        locations: [{ line: 1, offset: 0 }]
      }],
      execution: { model: 'small-preprocessor' },
      debugTrace
    },
    maintenance: {
      execution: { model: 'maintainer' },
      todos: [{
        id: 'T000001',
        content: 'Investigate the observed name or expression: Database',
        status: 'completed'
      }],
      debugTrace
    },
    commit: { statements: [] },
    knowledge: {
      writtenStatementTitles: ['Database'],
      statements: [{ title: 'Database', content: `Body for ${runId}` }]
    },
    durationMs: 1_500,
    completedAt
  } as unknown as KnowledgeFullChainResult
  return {
    formatVersion: 2,
    runId,
    attention: 'Focus on names.',
    configuration: {
      preprocessor: {
        connectionId: 'model:preprocessor',
        modelId: 'small-preprocessor',
        instructions: 'Find candidate names.'
      },
      maintainer: {
        connectionId: 'model:maintainer',
        modelId: 'maintainer',
        instructions: 'Maintain Statements.'
      }
    },
    result
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => rm(directory, { recursive: true, force: true })
  ))
})

describe('SqliteKnowledgeFullChainRunRepository', () => {
  it('persists immutable details while listing only compact summaries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oyster-processing-history-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'history.sqlite')
    const repository = await SqliteKnowledgeFullChainRunRepository.open(databasePath)
    repository.save(record('run-1', '2026-07-20T10:31:00.000Z', 'First Session'))
    repository.save(record('run-2', '2026-07-21T10:31:00.000Z', 'Second Session'))

    expect(repository.list()).toEqual([
      expect.objectContaining({
        runId: 'run-2',
        sessionTitle: 'Second Session',
        statementCount: 1,
        candidateCount: 1,
        preprocessorModel: 'small-preprocessor',
        maintainerModel: 'maintainer'
      }),
      expect.objectContaining({ runId: 'run-1', sessionTitle: 'First Session' })
    ])
    expect(JSON.stringify(repository.list())).not.toContain('Body for run-1')
    repository.close()

    const reopened = await SqliteKnowledgeFullChainRunRepository.open(databasePath)
    expect(reopened.read('run-1')).toEqual(record(
      'run-1',
      '2026-07-20T10:31:00.000Z',
      'First Session'
    ))
    expect(reopened.list().map((run) => run.runId)).toEqual(['run-2', 'run-1'])
    reopened.close()
  })

  it('stores the shared full-chain Debug Trace only once', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oyster-processing-history-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'history.sqlite')
    const repository = await SqliteKnowledgeFullChainRunRepository.open(databasePath)
    repository.save(record('run-1', '2026-07-20T10:31:00.000Z', 'First Session'))
    repository.close()

    const database = new DatabaseSync(databasePath)
    const row = database.prepare(`
      SELECT payload_json
      FROM knowledge_full_chain_runs
      WHERE run_id = ?
    `).get('run-1') as { payload_json: string }
    database.close()
    expect(row.payload_json.match(/\"debugTrace\"/g)).toHaveLength(1)
  })

  it('migrates V1 Candidate history and legacy artifactId into V2 Todos and sourceRecordId', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oyster-processing-history-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'history.sqlite')
    const repository = await SqliteKnowledgeFullChainRunRepository.open(databasePath)
    repository.save(record('legacy-run', '2026-07-20T10:31:00.000Z', 'Legacy Session'))
    repository.close()

    const database = new DatabaseSync(databasePath)
    const row = database.prepare(`
      SELECT payload_json
      FROM knowledge_full_chain_runs
      WHERE run_id = ?
    `).get('legacy-run') as { payload_json: string }
    const payload = JSON.parse(row.payload_json) as {
      formatVersion: number
      result: {
        session: Record<string, unknown>
        maintenance: Record<string, unknown>
      }
    }
    payload.formatVersion = 1
    const { sourceRecordId, ...legacySession } = payload.result.session
    payload.result.session = { ...legacySession, artifactId: sourceRecordId }
    delete payload.result.maintenance.todos
    payload.result.maintenance.statementCandidates = [{
      ref: 'C000001',
      expression: 'Database',
      question: 'What does Database denote?',
      evidenceLocations: ['L000001:C0'],
      status: 'resolved',
      resolution: 'Covered by Database.'
    }]
    database.prepare(`
      UPDATE knowledge_full_chain_runs
      SET payload_json = ?
      WHERE run_id = ?
    `).run(JSON.stringify(payload), 'legacy-run')
    database.close()

    const reopened = await SqliteKnowledgeFullChainRunRepository.open(databasePath)
    const restored = reopened.read('legacy-run')
    expect(restored?.formatVersion).toBe(2)
    expect(restored?.result.session.sourceRecordId).toBe('source-record:legacy-run')
    expect(restored?.result.session).not.toHaveProperty('artifactId')
    expect(restored?.result.maintenance.todos).toEqual([expect.objectContaining({
      id: 'T000001',
      content: expect.stringContaining('Database'),
      status: 'completed'
    })])
    expect(restored?.result.maintenance).not.toHaveProperty('statementCandidates')
    expect(JSON.stringify(restored?.result.maintenance)).not.toContain('Covered by Database')
    reopened.close()
  })

  it('does not silently replace an existing completed run', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oyster-processing-history-'))
    temporaryDirectories.push(directory)
    const repository = await SqliteKnowledgeFullChainRunRepository.open(join(directory, 'history.sqlite'))
    const first = record('run-1', '2026-07-20T10:31:00.000Z', 'First Session')
    repository.save(first)
    expect(() => repository.save(first)).toThrow()
    expect(() => repository.save({
      ...first,
      formatVersion: 1
    } as unknown as KnowledgeFullChainRunRecord)).toThrow('加工测试历史格式版本无效')
    expect(() => repository.read('')).toThrow('Run ID 格式无效')
    repository.close()
  })
})

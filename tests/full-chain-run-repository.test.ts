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
      artifactId: `artifact:${runId}`,
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
      execution: { model: 'small-preprocessor' },
      debugTrace
    },
    maintenance: {
      execution: { model: 'maintainer' },
      statementCandidates: [{ expression: 'Database', status: 'resolved' }],
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
    formatVersion: 1,
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

  it('does not silently replace an existing completed run', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oyster-processing-history-'))
    temporaryDirectories.push(directory)
    const repository = await SqliteKnowledgeFullChainRunRepository.open(join(directory, 'history.sqlite'))
    const first = record('run-1', '2026-07-20T10:31:00.000Z', 'First Session')
    repository.save(first)
    expect(() => repository.save(first)).toThrow()
    expect(() => repository.save({
      ...first,
      formatVersion: 2
    } as unknown as KnowledgeFullChainRunRecord)).toThrow('加工测试历史格式版本无效')
    expect(() => repository.read('')).toThrow('Run ID 格式无效')
    repository.close()
  })
})

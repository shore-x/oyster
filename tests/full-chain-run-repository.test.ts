import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { KnowledgeFullChainRunRecord } from '../src/shared/knowledge-processing'
import { SqliteKnowledgeFullChainRunRepository } from '../src/main/knowledge-processing/full-chain-run-repository'
import { completedAgentRun } from './agent-run-fixture'

const temporaryDirectories: string[] = []

function record(runId: string, completedAt: string, title: string): KnowledgeFullChainRunRecord {
  const statement = { title: 'Database', content: `Body for ${runId}` }
  const debugTrace = {
    origin: 'full_chain' as const,
    run: completedAgentRun(runId, ['read_evidence'])
  }
  return {
    formatVersion: 4,
    runId,
    attention: 'Focus on names.',
    configuration: {
      maintainer: {
        connectionId: 'model:maintainer',
        modelId: 'maintainer',
        instructions: 'Maintain Statements.'
      }
    },
    result: {
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
      maintenance: {
        stageId: 'knowledge_maintenance_agent',
        sourceRef: `raw:${runId}`,
        evidenceSegmentCount: 1,
        contribution: { runRef: `full-chain:${runId}`, statements: [statement] },
        todos: [{ id: 'T000001', content: 'Inspect Raw Evidence segment 1 of 1.', status: 'completed' }],
        debugTrace,
        durationMs: 500,
        completedAt,
        execution: {
          connectionId: 'model:maintainer',
          connectionName: 'Maintainer',
          backendKind: 'coding_plan',
          providerId: 'openai_codex',
          model: 'maintainer',
          runtime: 'pi_agent_core',
          modelCallCount: 1,
          toolCalls: ['read_evidence']
        }
      },
      commit: {
        contribution: { runRef: `full-chain:${runId}`, createdAt: completedAt },
        statements: [statement],
        createdTitles: [statement.title],
        updatedTitles: []
      },
      knowledge: { writtenStatementTitles: [statement.title], statements: [statement] },
      durationMs: 1_500,
      completedAt
    }
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => rm(directory, { recursive: true, force: true })
  ))
})

describe('SqliteKnowledgeFullChainRunRepository', () => {
  it('persists immutable details while listing compact Maintainer summaries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oyster-processing-history-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'history.sqlite')
    const repository = await SqliteKnowledgeFullChainRunRepository.open(databasePath)
    repository.save(record('run-1', '2026-07-20T10:31:00.000Z', 'First Session'))
    repository.save(record('run-2', '2026-07-21T10:31:00.000Z', 'Second Session'))

    expect(repository.list()).toEqual([
      expect.objectContaining({ runId: 'run-2', sessionTitle: 'Second Session', statementCount: 1, maintainerModel: 'maintainer' }),
      expect.objectContaining({ runId: 'run-1', sessionTitle: 'First Session' })
    ])
    expect(JSON.stringify(repository.list())).not.toContain('Body for run-1')
    expect(repository.read('run-1')).toEqual(record('run-1', '2026-07-20T10:31:00.000Z', 'First Session'))
    expect(() => repository.save(record('run-1', '2026-07-20T10:31:00.000Z', 'First Session'))).toThrow()
    repository.close()
  })

  it('rebuilds old schema data instead of maintaining legacy record compatibility', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oyster-processing-history-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'history.sqlite')
    const database = new DatabaseSync(databasePath)
    database.exec(`
      CREATE TABLE knowledge_full_chain_runs (run_id TEXT PRIMARY KEY, payload_json TEXT);
      INSERT INTO knowledge_full_chain_runs VALUES ('legacy', '{}');
      PRAGMA user_version = 1;
    `)
    database.close()

    const repository = await SqliteKnowledgeFullChainRunRepository.open(databasePath)
    expect(repository.list()).toEqual([])
    expect(repository.read('legacy')).toBeUndefined()
    repository.close()
  })
})

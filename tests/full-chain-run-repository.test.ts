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
  const session = {
    sourceRecordId: `source-record:${runId}`,
    sourceId: 'source:codex',
    agentType: 'codex' as const,
    sourceDisplayName: 'Codex',
    externalId: `session:${runId}`,
    title,
    projectPath: '/projects/oyster',
    startedAt: '2026-07-20T10:00:00.000Z',
    endedAt: '2026-07-20T10:30:00.000Z',
    sizeBytes: 512,
    revision: 'a'.repeat(64)
  }
  const agentRun = completedAgentRun(
    `${runId}:agent:1`,
    ['read_evidence'],
    1,
    'knowledge_maintenance_agent'
  )
  return {
    formatVersion: 5,
    runId,
    status: 'completed',
    startedAt: '2026-07-20T10:30:58.500Z',
    completedAt,
    durationMs: 1_500,
    input: {
      sourceRecordId: session.sourceRecordId,
      expectedRevision: session.revision,
      attention: 'Focus on names.'
    },
    session,
    configuration: {
      maintainer: {
        connectionId: 'model:maintainer',
        modelId: 'maintainer',
        instructions: 'Maintain Statements.'
      }
    },
    agentRuns: [agentRun],
    result: {
      runId,
      session,
      sandbox: { id: `sandbox:${runId}`, baselineCreatedAt: completedAt },
      sourceRef: `raw:${runId}`,
      maintenance: {
        stageId: 'knowledge_maintenance_agent',
        sourceRef: `raw:${runId}`,
        evidenceSegmentCount: 1,
        contribution: { runRef: `full-chain:${runId}`, statements: [statement] },
        todos: [{ id: 'T000001', content: 'Inspect Raw Evidence segment 1 of 1.', status: 'completed' }],
        agentRunId: agentRun.id,
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

function failedRecord(runId: string, completedAt: string): KnowledgeFullChainRunRecord {
  const failed = record(runId, completedAt, 'Failed Session')
  failed.status = 'failed'
  failed.error = 'Maintainer model unavailable'
  delete failed.result
  const agentRun = failed.agentRuns[0]
  agentRun.status = 'failed'
  agentRun.error = 'Maintainer model unavailable'
  const modelCall = agentRun.modelCalls[0]
  if (modelCall) {
    modelCall.status = 'failed'
    modelCall.error = 'Maintainer model unavailable'
  }
  return failed
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

  it('persists failed terminal details while keeping the list compact', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oyster-processing-history-'))
    temporaryDirectories.push(directory)
    const repository = await SqliteKnowledgeFullChainRunRepository.open(join(directory, 'history.sqlite'))
    const failed = failedRecord('run-failed', '2026-07-22T10:31:00.000Z')

    repository.save(failed)

    expect(repository.list()).toEqual([expect.objectContaining({
      runId: 'run-failed',
      status: 'failed',
      statementCount: 0,
      agentRunCount: 1,
      modelCallCount: 1,
      error: 'Maintainer model unavailable'
    })])
    expect(JSON.stringify(repository.list())).not.toContain('Body for run-failed')
    expect(repository.read('run-failed')).toEqual(failed)
    repository.close()
  })

  it('rejects non-terminal and unknown-version Agent Run records at the shared boundary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oyster-processing-history-'))
    temporaryDirectories.push(directory)
    const repository = await SqliteKnowledgeFullChainRunRepository.open(join(directory, 'history.sqlite'))
    const running = record('run-running', '2026-07-22T10:31:00.000Z', 'Running Session')
    running.agentRuns[0].status = 'running'
    delete running.agentRuns[0].completedAt
    delete running.agentRuns[0].durationMs
    expect(() => repository.save(running)).toThrow('尚未终态化')

    const incomplete = record('run-incomplete', '2026-07-22T10:31:30.000Z', 'Incomplete Session')
    incomplete.agentRuns[0].modelCalls[0].status = 'running'
    delete incomplete.agentRuns[0].modelCalls[0].completedAt
    delete incomplete.agentRuns[0].modelCalls[0].durationMs
    expect(() => repository.save(incomplete)).toThrow('仍包含运行中活动')

    const unknownVersion = record('run-unknown', '2026-07-22T10:32:00.000Z', 'Unknown Session')
    unknownVersion.agentRuns[0].formatVersion = 99 as 1
    expect(() => repository.save(unknownVersion)).toThrow('格式版本无效')
    expect(repository.list()).toEqual([])
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

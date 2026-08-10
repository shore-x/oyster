import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileKnowledgeFullChainRunRepository } from '../src/main/knowledge-processing/full-chain-run-repository'
import type { KnowledgeFullChainRunRecord } from '../src/shared/knowledge-processing'
import { completedAgentRun } from './agent-run-fixture'

function record(runId = 'run-history'): KnowledgeFullChainRunRecord {
  const maintainer = completedAgentRun('maintainer-run', ['read'], 1, 'knowledge_maintenance_agent')
  const reviewer = completedAgentRun('reviewer-run', ['read'], 1, 'knowledge_reviewer_agent')
  const revision = 'b'.repeat(40)
  const processingRun = {
    id: runId,
    repositoryPath: '/tmp/oyster/repository',
    runPath: `/tmp/oyster/repository/runs/${runId}`,
    taskPath: `/tmp/oyster/repository/runs/${runId}/TASK.md`,
    workPath: `/tmp/oyster/repository/runs/${runId}/WORK.md`,
    inputPath: `/tmp/oyster/repository/runs/${runId}/inputs`,
    workspaceRevision: 'c'.repeat(64),
    targetBranch: 'main',
    branchName: `processing/${runId}`,
    baseRevision: 'a'.repeat(40)
  }
  return {
    formatVersion: 8,
    runId,
    status: 'completed',
    startedAt: '2026-08-06T00:00:00.000Z',
    completedAt: '2026-08-06T00:00:01.000Z',
    durationMs: 1_000,
    input: { sourceRecordId: 'source-1', expectedRevision: 'revision-1' },
    session: {
      sourceRecordId: 'source-1',
      sourceId: 'source:codex',
      agentType: 'codex',
      sourceDisplayName: 'Codex',
      externalId: 'session-1',
      title: 'History session',
      sizeBytes: 100,
      revision: 'revision-1'
    },
    configuration: {
      maintainer: { connectionId: 'connection', modelId: 'maintainer', instructions: 'Maintain.' },
      reviewer: { connectionId: 'connection', modelId: 'reviewer', instructions: 'Review.' }
    },
    agentRuns: [maintainer, reviewer],
    result: {
      runId,
      session: {
        sourceRecordId: 'source-1',
        sourceId: 'source:codex',
        agentType: 'codex',
        sourceDisplayName: 'Codex',
        externalId: 'session-1',
        title: 'History session',
        sizeBytes: 100,
        revision: 'revision-1'
      },
      sourceRef: 'source-1@revision-1',
      run: processingRun,
      maintenanceRuns: [{
        stageId: 'knowledge_maintenance_agent',
        sourceRef: 'source-1@revision-1',
        activitySegmentCount: 1,
        run: processingRun,
        previousRevision: processingRun.baseRevision,
        revision,
        changedPaths: ['knowledge/subject.md'],
        agentRunId: maintainer.id,
        durationMs: 500,
        completedAt: '2026-08-06T00:00:00.500Z',
        execution: {
          connectionId: 'connection', connectionName: 'Connection', backendKind: 'api',
          providerId: 'openai_compatible', model: 'maintainer', runtime: 'pi_agent_core',
          modelCallCount: 1, toolCalls: ['read']
        }
      }],
      reviewRuns: [{
        stageId: 'knowledge_reviewer_agent',
        outcome: 'approved',
        reviewedRevision: revision,
        revision,
        changedPaths: [],
        markerPaths: [],
        agentRunId: reviewer.id,
        durationMs: 500,
        completedAt: '2026-08-06T00:00:01.000Z',
        execution: {
          connectionId: 'connection', connectionName: 'Connection', backendKind: 'api',
          providerId: 'openai_compatible', model: 'reviewer', runtime: 'pi_agent_core',
          modelCallCount: 1, toolCalls: ['read']
        }
      }],
      approvedRevision: revision,
      changedPaths: ['knowledge/subject.md'],
      knowledge: [{ title: 'Subject', content: 'Body.' }],
      artifactPaths: [],
      durationMs: 1_000,
      completedAt: '2026-08-06T00:00:01.000Z'
    }
  }
}

describe('FileKnowledgeFullChainRunRepository', () => {
  it('stores terminal history in runs/<run-id>/run.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oyster-run-history-'))
    const repository = new FileKnowledgeFullChainRunRepository(join(root, 'runs'))
    const value = record()
    repository.save(value)
    expect(repository.read(value.runId)).toEqual(value)
    expect(repository.list()).toEqual([
      expect.objectContaining({ runId: value.runId, agentRunCount: 2, statementCount: 1 })
    ])
  })

  it('does not overwrite an existing terminal record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oyster-run-history-'))
    const repository = new FileKnowledgeFullChainRunRepository(join(root, 'runs'))
    repository.save(record())
    expect(() => repository.save(record())).toThrow()
  })
})

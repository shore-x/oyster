import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AiBackendSnapshot, AiConnection } from '../src/shared/ai-backends'
import type { ModelGenerationRequest, ModelRuntime } from '../src/main/ai-backends/model'
import type {
  AiBackendPort,
  KnowledgeMaintainerRunInput,
  KnowledgeMaintainerRuntime,
  RepositoryAgentRunResult
} from '../src/main/knowledge-processing/model'
import { KnowledgeProcessingService } from '../src/main/knowledge-processing/knowledge-processing-service'
import { InMemoryKnowledgeProcessingRepository } from '../src/main/knowledge-processing/repository'
import {
  KNOWLEDGE_MAINTENANCE_AGENT_PROMPT,
  KNOWLEDGE_REVIEWER_AGENT_PROMPT
} from '../src/main/knowledge-processing/prompts'
import type { AgentObservation } from '../src/main/observation/model'
import { CollaborationRepository } from '../src/main/knowledge-processing/collaboration-repository'
import {
  FixtureKnowledgeMaintainerRuntime,
  FixtureKnowledgeReviewerRuntime
} from '../src/main/knowledge-processing/fixture'

const temporaryDirectories: string[] = []

function observation(lines: string[]): AgentObservation {
  return {
    rawEvidence: { formatVersion: 'test-raw-v1', lines, skillHints: [] },
    canonicalActivity: {
      formatVersion: 'test-activity-v1',
      items: [{
        kind: 'user_message',
        content: lines.join('\n'),
        rawRanges: lines.map((line, index) => ({
          start: { line: index + 1, offset: 0 },
          end: { line: index + 1, offset: line.length }
        }))
      }],
      attachments: []
    }
  }
}

function connection(): AiConnection {
  return {
    id: 'model:maintainer',
    adapterId: 'openai-compatible',
    backendKind: 'api',
    providerId: 'openai_compatible',
    displayName: 'Maintainer Model',
    credentialMode: 'oyster_keychain',
    status: 'ready',
    models: [{ id: 'maintainer', displayName: 'Maintainer', reasoningEfforts: ['low'] }],
    defaultModelId: 'maintainer',
    modelConfig: {
      providerId: 'openai_compatible',
      protocol: 'openai_responses',
      baseUrl: 'https://example.test/v1',
      model: 'maintainer',
      hasApiKey: true,
      reasoningEfforts: ['low']
    }
  }
}

const MODEL_RUNTIME: ModelRuntime = {
  model: { id: 'maintainer', contextWindow: 128_000 } as ModelRuntime['model'],
  streamFn: (() => { throw new Error('not used') }) as ModelRuntime['streamFn']
}

class FakeBackend implements AiBackendPort {
  defaultLlm: AiBackendSnapshot['defaultLlm'] = {
    connectionId: 'model:maintainer',
    modelId: 'maintainer'
  }

  snapshot(): AiBackendSnapshot {
    return {
      options: [],
      connections: [connection()],
      ...(this.defaultLlm ? { defaultLlm: this.defaultLlm } : {})
    }
  }

  subscribe(): () => void {
    return () => undefined
  }

  async generateWithModel(
    _connectionId: string,
    _modelId: string,
    _request: ModelGenerationRequest
  ): Promise<{ text: string }> {
    throw new Error('standalone generation is not part of knowledge maintenance')
  }

  async withModelRuntime<T>(
    _connectionId: string,
    _modelId: string,
    operation: (runtime: ModelRuntime) => Promise<T>
  ): Promise<T> {
    return operation(MODEL_RUNTIME)
  }
}

class CapturingMaintainer implements KnowledgeMaintainerRuntime {
  readonly calls: KnowledgeMaintainerRunInput[] = []
  private readonly delegate = new FixtureKnowledgeMaintainerRuntime()

  async run(input: KnowledgeMaintainerRunInput): Promise<RepositoryAgentRunResult> {
    this.calls.push(input)
    return this.delegate.run(input)
  }
}

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'oyster-processing-service-'))
  temporaryDirectories.push(directory)
  const collaborations = new CollaborationRepository(join(directory, 'repository'))
  const maintainer = new CapturingMaintainer()
  const backend = new FakeBackend()
  const service = new KnowledgeProcessingService(
    new InMemoryKnowledgeProcessingRepository({
      stages: [
        { stageId: 'knowledge_maintenance_agent' },
        { stageId: 'knowledge_reviewer_agent' }
      ]
    }),
    backend,
    collaborations,
    maintainer,
    new FixtureKnowledgeReviewerRuntime()
  )
  await service.initialize()
  return { service, maintainer, backend, collaborations }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => rm(directory, { recursive: true, force: true })
  ))
})

describe('KnowledgeProcessingService', () => {
  it('exposes Maintainer and Reviewer without installing Todo or contribution tools', async () => {
    const { service } = await harness()
    const snapshot = service.snapshot()

    expect(snapshot.stages).toHaveLength(2)
    expect(snapshot.stages[0]).toMatchObject({
      id: 'knowledge_maintenance_agent',
      runtime: 'pi_agent_core',
      builtInInstructions: KNOWLEDGE_MAINTENANCE_AGENT_PROMPT
    })
    expect(snapshot.stages[1]).toMatchObject({
      id: 'knowledge_reviewer_agent',
      builtInInstructions: KNOWLEDGE_REVIEWER_AGENT_PROMPT
    })
    expect(snapshot.stages[0].tools.map((tool) => tool.name)).toEqual([
      'read', 'bash', 'edit', 'write',
      'read_activity', 'read_activity_attachment', 'read_evidence'
    ])
    expect(snapshot.stages[1].tools.map((tool) => tool.name)).toEqual([
      'read', 'bash', 'edit', 'write'
    ])
    expect(snapshot.stages.flatMap((stage) => stage.tools).map((tool) => tool.name))
      .not.toEqual(expect.arrayContaining(['list_todos', 'add_todos', 'complete_todos']))
  })

  it('creates a real worktree, supplies observation tools, and validates the Maintainer commit', async () => {
    const { service, maintainer, collaborations } = await harness()
    const baseRevision = await collaborations.currentRevision()
    const result = await service.runKnowledgeMaintenance(
      observation(['first line', 'second line']),
      'session:codex:one@revision',
      'Inspect the repository model.'
    )

    expect(maintainer.calls).toHaveLength(1)
    expect(maintainer.calls[0].sourceRef).toBe('session:codex:one@revision')
    expect(maintainer.calls[0].systemPrompt).toBe(KNOWLEDGE_MAINTENANCE_AGENT_PROMPT)
    expect(await readFile(
      join(result.workspace.worktreePath, '.oyster', 'WORK.md'),
      'utf8'
    )).toContain('Inspect the repository model.')
    expect(result.activitySegmentCount).toBe(1)
    expect(result.previousRevision).toBe(result.workspace.workOrderRevision)
    expect(result.revision).not.toBe(result.previousRevision)
    expect(result.changedPaths).toEqual(expect.arrayContaining([
      '.oyster/WORK.md',
      'knowledge/knowledge-processing.md'
    ]))
    expect(result.workspace.worktreePath).toBe(maintainer.calls[0].workspace.worktreePath)
    expect(await collaborations.currentRevision()).toBe(baseRevision)
    expect(service.snapshot().debugTraces[0]?.run.id).toBe(result.agentRunId)
  })

  it('rejects malformed Canonical Activity before starting the Agent', async () => {
    const { service, maintainer } = await harness()
    const input = observation(['line'])
    input.canonicalActivity.items[0].rawRanges[0].end.offset = 99

    await expect(service.runKnowledgeMaintenance(input, 'session:test'))
      .rejects.toThrow('Canonical Activity Raw locator 无效')
    expect(maintainer.calls).toHaveLength(0)
  })

  it('requires a configured default LLM before creating a collaboration', async () => {
    const { service, maintainer, backend } = await harness()
    backend.defaultLlm = undefined

    await expect(service.runKnowledgeMaintenance(observation(['line']), 'session:test'))
      .rejects.toThrow('AI 后端页面配置默认 LLM')
    expect(maintainer.calls).toHaveLength(0)
  })

  it('rejects visual evidence when the selected Maintainer Model cannot receive images', async () => {
    const { service, maintainer } = await harness()
    const input = observation(['image data'])
    input.canonicalActivity.items[0].kind = 'attachment'
    input.canonicalActivity.items[0].attachmentId = 'ATT000001'
    input.canonicalActivity.attachments.push({
      id: 'ATT000001',
      mimeType: 'image/png',
      data: 'aW1hZ2U=',
      byteLength: 5,
      sha256: '0'.repeat(64),
      rawRange: {
        start: { line: 1, offset: 0 },
        end: { line: 1, offset: 10 }
      }
    })

    await expect(service.runKnowledgeMaintenance(input, 'session:test'))
      .rejects.toThrow('不支持图片输入')
    expect(maintainer.calls).toHaveLength(0)
  })
})

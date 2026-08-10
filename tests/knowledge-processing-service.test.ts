import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AiBackendSnapshot, AiConnection } from '../src/shared/ai-backends'
import type { ModelGenerationRequest, ModelRuntime } from '../src/main/ai-backends/model'
import type {
  AiBackendPort,
  KnowledgeMaintainerRunInput,
  KnowledgeMaintainerRuntime,
  KnowledgeReviewerRuntime,
  RepositoryAgentRunResult
} from '../src/main/knowledge-processing/model'
import { KnowledgeProcessingService } from '../src/main/knowledge-processing/knowledge-processing-service'
import { InMemoryKnowledgeProcessingRepository } from '../src/main/knowledge-processing/repository'
import {
  KNOWLEDGE_MAINTENANCE_AGENT_PROMPT,
  KNOWLEDGE_REVIEWER_AGENT_PROMPT
} from '../src/main/knowledge-processing/prompts'
import type { AgentObservation } from '../src/main/observation/model'
import { ProcessingRepository } from '../src/main/knowledge-processing/processing-repository'
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
  const collaborations = new ProcessingRepository(join(directory, 'repository'))
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
      'read', 'bash', 'edit', 'write'
    ])
    expect(snapshot.stages[1].tools.map((tool) => tool.name)).toEqual([
      'read', 'bash', 'edit', 'write'
    ])
    expect(snapshot.stages.flatMap((stage) => stage.tools).map((tool) => tool.name))
      .not.toEqual(expect.arrayContaining(['list_todos', 'add_todos', 'complete_todos']))
  })

  it('creates a file-backed Run workspace and validates the Maintainer commit', async () => {
    const { service, maintainer, collaborations } = await harness()
    const baseRevision = await collaborations.currentRevision()
    const result = await service.runKnowledgeMaintenance(
      observation(['first line', 'second line']),
      'session:codex:one@revision',
      'Inspect the repository model.'
    )

    expect(maintainer.calls).toHaveLength(1)
    expect(maintainer.calls[0].systemPrompt).toBe(KNOWLEDGE_MAINTENANCE_AGENT_PROMPT)
    expect(await readFile(result.run.taskPath, 'utf8')).toContain('session:codex:one@revision')
    expect(await readFile(result.run.taskPath, 'utf8')).toContain('Inspect the repository model.')
    expect(await readFile(join(result.run.inputPath, 'README.md'), 'utf8'))
      .toContain('fixed, Host-materialized input view')
    expect(await readdir(join(result.run.inputPath, 'activity'))).toEqual([
      'segment-000001-page-000001.md'
    ])
    expect(await readdir(join(result.run.inputPath, 'evidence'))).toEqual([
      'INDEX.md', 'page-000001.txt'
    ])
    await expect(collaborations.assertRunWorkspace(maintainer.calls[0].run))
      .resolves.toBeUndefined()
    expect(result.activitySegmentCount).toBe(1)
    expect(result.previousRevision).toBe(result.run.baseRevision)
    expect(result.revision).not.toBe(result.previousRevision)
    expect(result.changedPaths).toEqual(expect.arrayContaining([
      'knowledge/knowledge-processing.md'
    ]))
    expect(result.run.repositoryPath).toBe(maintainer.calls[0].run.repositoryPath)
    expect(await readdir(result.run.runPath)).not.toContain('run.json')
    expect(await collaborations.currentRevision()).toBe(baseRevision)
    expect(service.snapshot().debugTraces[0]?.run.id).toBe(result.agentRunId)
  })

  it('rejects Knowledge or Artifact drift between Run creation and initial Agent start', async () => {
    const { service, maintainer } = await harness()

    await expect(service.runKnowledgeMaintenance(
      observation(['first line']),
      'session:test',
      undefined,
      {
        onRunCreated: (run) => {
          writeFileSync(
            join(run.repositoryPath, 'knowledge', 'late-edit.md'),
            '# Late edit\n\nCreated after the Run snapshot.\n'
          )
        }
      }
    )).rejects.toThrow('Run 初始 Knowledge/Artifact working tree 已发生变化')

    expect(maintainer.calls).toHaveLength(0)
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
      sha256: createHash('sha256').update('image').digest('hex'),
      rawRange: {
        start: { line: 1, offset: 0 },
        end: { line: 1, offset: 10 }
      }
    })

    await expect(service.runKnowledgeMaintenance(input, 'session:test'))
      .rejects.toThrow('不支持图片输入')
    expect(maintainer.calls).toHaveLength(0)
  })

  it('does not reuse a Run with a different source or Observation', async () => {
    const { service, maintainer } = await harness()
    const first = await service.runKnowledgeMaintenance(
      observation(['first']),
      'session:first'
    )

    await expect(service.runKnowledgeMaintenance(
      observation(['different']),
      'session:different',
      undefined,
      { run: first.run, previousRevision: first.revision }
    )).rejects.toThrow('固定工作空间不一致')
    expect(maintainer.calls).toHaveLength(1)
  })

  it('does not reuse a Run with a different initial work checklist', async () => {
    const { service, maintainer } = await harness()
    const firstInput = observation(['first'])
    const first = await service.runKnowledgeMaintenance(firstInput, 'session:first')
    const changedHints = observation(['first'])
    changedHints.rawEvidence.skillHints.push({
      location: { line: 1, offset: 0 },
      name: 'example-skill',
      source: 'runtime_injection'
    })

    await expect(service.runKnowledgeMaintenance(
      changedHints,
      'session:first',
      undefined,
      { run: first.run, previousRevision: first.revision }
    )).rejects.toThrow('固定工作空间不一致')
    expect(maintainer.calls).toHaveLength(1)
  })

  it('validates fixed inputs before starting the Reviewer', async () => {
    const { service } = await harness()
    const maintained = await service.runKnowledgeMaintenance(
      observation(['first']),
      'session:first'
    )
    await writeFile(join(maintained.run.inputPath, 'unlisted.txt'), 'changed evidence\n')
    let reviewerCalls = 0
    const reviewer: KnowledgeReviewerRuntime = {
      run: async (input) => {
        reviewerCalls += 1
        return new FixtureKnowledgeReviewerRuntime().run(input)
      }
    }

    await expect(service.runKnowledgeReview(maintained.run, maintained.revision, { agent: reviewer }))
      .rejects.toThrow('固定输入文件树已被修改')
    expect(reviewerCalls).toBe(0)
  })

  it('does not run Maintainer and Reviewer concurrently on the shared working tree', async () => {
    const { service } = await harness()
    const maintained = await service.runKnowledgeMaintenance(
      observation(['first']),
      'session:first'
    )
    let releaseReviewer!: () => void
    let reviewerStarted!: () => void
    const release = new Promise<void>((resolve) => { releaseReviewer = resolve })
    const started = new Promise<void>((resolve) => { reviewerStarted = resolve })
    const reviewer: KnowledgeReviewerRuntime = {
      run: async (input) => {
        reviewerStarted()
        await release
        return new FixtureKnowledgeReviewerRuntime().run(input)
      }
    }
    const review = service.runKnowledgeReview(maintained.run, maintained.revision, { agent: reviewer })
    await started

    await expect(service.runKnowledgeMaintenance(observation(['second']), 'session:second'))
      .rejects.toThrow('另一个知识加工角色正在运行')
    releaseReviewer()
    await expect(review).resolves.toMatchObject({ outcome: 'approved' })
  })
})

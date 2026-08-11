import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AiBackendSnapshot, AiConnection } from '../src/shared/ai-backends'
import type { ModelGenerationRequest, SelectedModelStream } from '../src/main/ai-backends/model'
import type {
  AiBackendPort,
  KnowledgeMaintainerInvocationInput,
  KnowledgeMaintainerRuntime,
  KnowledgeReviewerRuntime,
  RepositoryAgentInvocationResult
} from '../src/main/knowledge-processing/model'
import { KnowledgeProcessingService } from '../src/main/knowledge-processing/knowledge-processing-service'
import { InMemoryKnowledgeProcessingConfigurationRepository } from '../src/main/knowledge-processing/repository'
import {
  KNOWLEDGE_MAINTENANCE_AGENT_PROMPT,
  KNOWLEDGE_REVIEWER_AGENT_PROMPT
} from '../src/main/knowledge-processing/prompts'
import type { AgentObservation } from '../src/main/observation/model'
import { KnowledgeTaskWorkspaceRepository } from '../src/main/knowledge-processing/knowledge-task-workspace-repository'
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

const MODEL_STREAM: SelectedModelStream = {
  model: { id: 'maintainer', contextWindow: 128_000 } as SelectedModelStream['model'],
  streamFn: (() => { throw new Error('not used') }) as SelectedModelStream['streamFn']
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

  async withModelStream<T>(
    _connectionId: string,
    _modelId: string,
    operation: (modelStream: SelectedModelStream) => Promise<T>
  ): Promise<T> {
    return operation(MODEL_STREAM)
  }
}

class CapturingMaintainer implements KnowledgeMaintainerRuntime {
  readonly calls: KnowledgeMaintainerInvocationInput[] = []
  private readonly delegate = new FixtureKnowledgeMaintainerRuntime()

  async invoke(input: KnowledgeMaintainerInvocationInput): Promise<RepositoryAgentInvocationResult> {
    this.calls.push(input)
    return this.delegate.invoke(input)
  }
}

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'oyster-processing-service-'))
  temporaryDirectories.push(directory)
  const collaborations = new KnowledgeTaskWorkspaceRepository(join(directory, 'repository'))
  const maintainer = new CapturingMaintainer()
  const backend = new FakeBackend()
  const service = new KnowledgeProcessingService(
    new InMemoryKnowledgeProcessingConfigurationRepository({
      agents: [
        { agentId: 'knowledge_maintainer' },
        { agentId: 'knowledge_reviewer' }
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
    const snapshot = service.stateView()

    expect(snapshot.agents).toHaveLength(2)
    expect(snapshot.agents[0]).toMatchObject({
      id: 'knowledge_maintainer',
      runtime: 'pi_coding_agent',
      builtInInstructions: KNOWLEDGE_MAINTENANCE_AGENT_PROMPT
    })
    expect(snapshot.agents[1]).toMatchObject({
      id: 'knowledge_reviewer',
      builtInInstructions: KNOWLEDGE_REVIEWER_AGENT_PROMPT
    })
    expect(snapshot.agents[0].tools.map((tool) => tool.name)).toEqual([
      'read', 'bash', 'edit', 'write'
    ])
    expect(snapshot.agents[1].tools.map((tool) => tool.name)).toEqual([
      'read', 'bash', 'edit', 'write'
    ])
    expect(snapshot.agents.flatMap((stage) => stage.tools).map((tool) => tool.name))
      .not.toEqual(expect.arrayContaining(['list_todos', 'add_todos', 'complete_todos']))
  })

  it('creates a file-backed Task workspace and validates the Maintainer commit', async () => {
    const { service, maintainer, collaborations } = await harness()
    const baseRepositoryRevision = await collaborations.currentRevision()
    const result = await service.executeMaintenance(
      observation(['first line', 'second line']),
      'raw:source-conversation-one@sha256:revision',
      'Inspect the repository model.'
    )

    expect(maintainer.calls).toHaveLength(1)
    expect(maintainer.calls[0].systemPrompt).toBe(KNOWLEDGE_MAINTENANCE_AGENT_PROMPT)
    expect(await readFile(result.workspace.briefPath, 'utf8'))
      .toContain('raw:source-conversation-one@sha256:revision')
    expect(await readFile(result.workspace.briefPath, 'utf8'))
      .toContain('Inspect the repository model.')
    expect(await readFile(join(result.workspace.inputPath, 'README.md'), 'utf8'))
      .toContain('fixed, Host-materialized input view')
    expect(await readdir(join(result.workspace.inputPath, 'activity'))).toEqual([
      'segment-000001-page-000001.md'
    ])
    expect(await readdir(join(result.workspace.inputPath, 'evidence'))).toEqual([
      'INDEX.md', 'page-000001.txt'
    ])
    await expect(collaborations.assertWorkspaceIntegrity(maintainer.calls[0].workspace))
      .resolves.toBeUndefined()
    expect(result.activitySegmentCount).toBe(1)
    expect(result.previousRepositoryRevision).toBe(result.workspace.baseRepositoryRevision)
    expect(result.candidateRepositoryRevision).not.toBe(result.previousRepositoryRevision)
    expect(result.changedPaths).toEqual(expect.arrayContaining([
      'knowledge/knowledge-processing.md'
    ]))
    expect(result.workspace.repositoryPath).toBe(maintainer.calls[0].workspace.repositoryPath)
    expect(await readdir(result.workspace.workspacePath)).not.toContain('task.json')
    expect(await collaborations.currentRevision()).toBe(baseRepositoryRevision)
    expect(service.stateView().liveInvocations[0]?.invocation.id).toBe(result.agentInvocationId)
  })

  it('rejects Knowledge or Artifact drift between Task creation and initial Agent start', async () => {
    const { service, maintainer } = await harness()

    await expect(service.executeMaintenance(
      observation(['first line']),
      'session:test',
      undefined,
      {
        onWorkspaceCreated: (workspace) => {
          writeFileSync(
            join(workspace.repositoryPath, 'knowledge', 'late-edit.md'),
            '# Late edit\n\nCreated after the Task snapshot.\n'
          )
        }
      }
    )).rejects.toThrow('Task 初始 Knowledge/Artifact working tree 已发生变化')

    expect(maintainer.calls).toHaveLength(0)
  })

  it('rejects malformed Canonical Activity before starting the Agent', async () => {
    const { service, maintainer } = await harness()
    const input = observation(['line'])
    input.canonicalActivity.items[0].rawRanges[0].end.offset = 99

    await expect(service.executeMaintenance(input, 'session:test'))
      .rejects.toThrow('Canonical Activity Raw locator 无效')
    expect(maintainer.calls).toHaveLength(0)
  })

  it('requires a configured default LLM before creating a collaboration', async () => {
    const { service, maintainer, backend } = await harness()
    backend.defaultLlm = undefined

    await expect(service.executeMaintenance(observation(['line']), 'session:test'))
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

    await expect(service.executeMaintenance(input, 'session:test'))
      .rejects.toThrow('不支持图片输入')
    expect(maintainer.calls).toHaveLength(0)
  })

  it('does not reuse a Task workspace with a different source or Observation', async () => {
    const { service, maintainer } = await harness()
    const first = await service.executeMaintenance(
      observation(['first']),
      'session:first'
    )

    await expect(service.executeMaintenance(
      observation(['different']),
      'session:different',
      undefined,
      { workspace: first.workspace, previousRepositoryRevision: first.candidateRepositoryRevision }
    )).rejects.toThrow('固定工作空间不一致')
    expect(maintainer.calls).toHaveLength(1)
  })

  it('does not reuse a Task workspace with a different initial checklist', async () => {
    const { service, maintainer } = await harness()
    const firstInput = observation(['first'])
    const first = await service.executeMaintenance(firstInput, 'session:first')
    const changedHints = observation(['first'])
    changedHints.rawEvidence.skillHints.push({
      location: { line: 1, offset: 0 },
      name: 'example-skill',
      source: 'runtime_injection'
    })

    await expect(service.executeMaintenance(
      changedHints,
      'session:first',
      undefined,
      { workspace: first.workspace, previousRepositoryRevision: first.candidateRepositoryRevision }
    )).rejects.toThrow('固定工作空间不一致')
    expect(maintainer.calls).toHaveLength(1)
  })

  it('validates fixed inputs before starting the Reviewer', async () => {
    const { service } = await harness()
    const maintained = await service.executeMaintenance(
      observation(['first']),
      'session:first'
    )
    await writeFile(join(maintained.workspace.inputPath, 'unlisted.txt'), 'changed evidence\n')
    let reviewerCalls = 0
    const reviewer: KnowledgeReviewerRuntime = {
      invoke: async (input) => {
        reviewerCalls += 1
        return new FixtureKnowledgeReviewerRuntime().invoke(input)
      }
    }

    await expect(service.executeReview(maintained.workspace, maintained.candidateRepositoryRevision, { agent: reviewer }))
      .rejects.toThrow('固定输入文件树已被修改')
    expect(reviewerCalls).toBe(0)
  })

  it('does not run Maintainer and Reviewer concurrently on the shared working tree', async () => {
    const { service } = await harness()
    const maintained = await service.executeMaintenance(
      observation(['first']),
      'session:first'
    )
    let releaseReviewer!: () => void
    let reviewerStarted!: () => void
    const release = new Promise<void>((resolve) => { releaseReviewer = resolve })
    const started = new Promise<void>((resolve) => { reviewerStarted = resolve })
    const reviewer: KnowledgeReviewerRuntime = {
      invoke: async (input) => {
        reviewerStarted()
        await release
        return new FixtureKnowledgeReviewerRuntime().invoke(input)
      }
    }
    const review = service.executeReview(maintained.workspace, maintained.candidateRepositoryRevision, { agent: reviewer })
    await started

    await expect(service.executeMaintenance(observation(['second']), 'session:second'))
      .rejects.toThrow('另一个知识 Agent 正在执行')
    releaseReviewer()
    await expect(review).resolves.toMatchObject({ decision: 'approved' })
  })
})

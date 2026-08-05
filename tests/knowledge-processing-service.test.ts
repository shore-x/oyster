import { describe, expect, it } from 'vitest'
import type { AiBackendSnapshot, AiConnection } from '../src/shared/ai-backends'
import type { ModelGenerationRequest, ModelRuntime } from '../src/main/ai-backends/model'
import type {
  AiBackendPort,
  KnowledgeAgentRunInput,
  KnowledgeAgentRunResult,
  KnowledgeAgentRuntime
} from '../src/main/knowledge-processing/model'
import { KnowledgeProcessingService } from '../src/main/knowledge-processing/knowledge-processing-service'
import { InMemoryKnowledgeProcessingRepository } from '../src/main/knowledge-processing/repository'
import { KNOWLEDGE_MAINTENANCE_AGENT_PROMPT } from '../src/main/knowledge-processing/prompts'

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
  model: { id: 'maintainer' } as ModelRuntime['model'],
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

class CapturingAgent implements KnowledgeAgentRuntime {
  calls: KnowledgeAgentRunInput[] = []

  async run(input: KnowledgeAgentRunInput): Promise<KnowledgeAgentRunResult> {
    this.calls.push(input)
    input.onTrace?.({ type: 'model_started', callNumber: 1 })
    input.onTrace?.({ type: 'model_completed', callNumber: 1, status: 'completed', output: 'done' })
    return {
      contribution: {
        runRef: input.contributionRunRef,
        statements: [{ title: 'Raw Evidence', content: 'Raw Evidence is inspected by the Maintainer.' }]
      },
      todos: (input.initialTodos ?? []).map((content, index) => ({
        id: `T${String(index + 1).padStart(6, '0')}`,
        content,
        status: 'completed'
      })),
      modelCallCount: 1,
      toolCalls: ['list_todos', 'read_evidence', 'complete_todos']
    }
  }
}

async function harness() {
  const agent = new CapturingAgent()
  const backend = new FakeBackend()
  const service = new KnowledgeProcessingService(
    new InMemoryKnowledgeProcessingRepository({
      stages: [{
        stageId: 'knowledge_maintenance_agent'
      }]
    }),
    backend,
    agent
  )
  await service.initialize()
  return { service, agent, backend }
}

describe('KnowledgeProcessingService', () => {
  it('exposes one Pi Agent stage with generic Todo and knowledge tools', async () => {
    const { service } = await harness()
    const snapshot = service.snapshot()

    expect(snapshot.stages).toHaveLength(1)
    expect(snapshot.stages[0]).toMatchObject({
      id: 'knowledge_maintenance_agent',
      runtime: 'pi_agent_core',
      builtInInstructions: KNOWLEDGE_MAINTENANCE_AGENT_PROMPT,
      effectiveInstructions: KNOWLEDGE_MAINTENANCE_AGENT_PROMPT
    })
    expect(snapshot.stages[0].tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'read_evidence',
      'list_todos',
      'add_todos',
      'complete_todos',
      'upsert_contribution_statement'
    ]))
    expect(KNOWLEDGE_MAINTENANCE_AGENT_PROMPT).toMatch(/Skill activation/i)
    expect(KNOWLEDGE_MAINTENANCE_AGENT_PROMPT).toMatch(/SKILL\.md/i)
  })

  it('binds deterministic evidence pages and Skill hints as ordinary initial Todos', async () => {
    const { service, agent } = await harness()
    const result = await service.runKnowledgeMaintenance({
      formatVersion: 'codex-jsonl-raw-v1',
      lines: ['first line', 'Skill call evidence'],
      skillHints: [{
        name: 'deep-research',
        tool: 'Skill',
        source: 'tool_call',
        location: { line: 2, offset: 0 }
      }]
    }, 'session:codex:one@revision', 'Inspect Skill use', {
      initialTodos: ['Check a user-requested concern.']
    })

    expect(agent.calls).toHaveLength(1)
    expect(agent.calls[0]).toMatchObject({
      evidenceLines: ['first line', 'Skill call evidence'],
      evidenceFormatVersion: 'codex-jsonl-raw-v1',
      sourceRef: 'session:codex:one@revision',
      attention: 'Inspect Skill use'
    })
    expect(agent.calls[0].initialTodos).toHaveLength(2)
    expect(agent.calls[0].initialTodos?.[0]).toContain('Inspect Raw Evidence segment 1 of 1')
    expect(agent.calls[0].initialTodos?.[0]).toContain('possible Skill activation “deep-research”')
    expect(agent.calls[0].initialTodos?.[1]).toBe('Check a user-requested concern.')
    expect(result.evidenceSegmentCount).toBe(1)
    expect(result.sourceRef).toBe('session:codex:one@revision')
    expect(result.todos.every((todo) => todo.status === 'completed')).toBe(true)
    expect(result.debugTrace.maintenance.modelCallCount).toBe(1)
  })

  it('rejects malformed Raw Evidence before starting the Agent', async () => {
    const { service, agent } = await harness()
    await expect(service.runKnowledgeMaintenance({
      formatVersion: 'test-v1',
      lines: ['line'],
      skillHints: [{ source: 'tool_call', location: { line: 2, offset: 0 } }]
    }, 'session:test')).rejects.toThrow('Raw Evidence Skill hint 无效')
    expect(agent.calls).toHaveLength(0)
  })

  it('blocks a new Maintainer run when the application default LLM is not configured', async () => {
    const { service, agent, backend } = await harness()
    backend.defaultLlm = undefined

    await expect(service.runKnowledgeMaintenance({
      formatVersion: 'test-v1',
      lines: ['line'],
      skillHints: []
    }, 'session:test')).rejects.toThrow('AI 后端页面配置默认 LLM')
    expect(agent.calls).toHaveLength(0)
  })
})

import type { AiConnection } from '../../shared/ai-backends'
import type { AvailableModel, ModelProviderId } from '../../shared/ai-backends'
import { AiBackendService, type CodingPlanBackend } from './ai-backend-service'
import { MemoryCredentialStore } from './credential-store'
import type {
  AgentBackendAdapter,
  AgentTaskRequest,
  ModelBackendAdapter,
  ModelGenerationRequest,
  StoredModelConnection
} from './model'
import { InMemoryAiBackendRepository } from './repository'

class FixtureAgentAdapter implements AgentBackendAdapter {
  readonly id = 'codex' as const

  async inspect(): Promise<AiConnection> {
    return {
      id: 'runtime:codex',
      adapterId: 'codex',
      backendKind: 'coding_plan',
      providerId: 'openai_codex',
      displayName: 'OpenAI Codex',
      credentialMode: 'provider_runtime',
      status: 'ready',
      models: [],
      executablePath: '/opt/homebrew/bin/codex',
      accountLabel: 'demo@example.com',
      planType: 'pro',
      lastCheckedAt: '2026-07-26T00:00:00.000Z'
    }
  }

  async connect(): Promise<undefined> { return undefined }
  cancelConnect(): void {}
  async runTask(_request: AgentTaskRequest): Promise<{ text: string }> { return { text: 'OYSTER' } }
  subscribe(_listener: () => void): () => void { return () => undefined }
  dispose(): void {}
}

class FixtureCodingPlanBackend implements CodingPlanBackend {
  readonly models: AvailableModel[] = [{
    id: 'fixture-codex-small',
    displayName: 'Fixture Codex Small',
    reasoningEfforts: ['low', 'medium', 'high']
  }]

  listModels(): AvailableModel[] { return structuredClone(this.models) }
  async inspectAuth() { return { status: 'ready' as const } }
  async connect(): Promise<void> {}
  cancelConnect(): void {}
  async generate(): Promise<{ text: string }> { return { text: 'OYSTER' } }
  runtime(): never { throw new Error('Fixture Coding Plan runtime is not used') }
  dispose(): void {}
}

class FixtureModelAdapter implements ModelBackendAdapter {
  readonly id = 'openai-compatible' as const
  async listModels(
    _providerId: ModelProviderId,
    _baseUrl: string,
    _apiKey?: string
  ): Promise<AvailableModel[]> {
    return [{ id: 'fixture-model', displayName: 'Fixture Model', reasoningEfforts: [] }]
  }
  async generate(
    _connection: StoredModelConnection,
    _apiKey: string | undefined,
    request: ModelGenerationRequest
  ): Promise<{ text: string }> {
    if (request.systemPrompt) {
      return {
        text: JSON.stringify({
          candidates: [{
            expression: '知识加工链路',
            question: '“知识加工链路”在该项目中具体指哪些相互衔接的阶段？',
            locations: [{ line: 1, offset: 0 }]
          }]
        })
      }
    }
    return { text: 'OYSTER' }
  }
}

export function createFixtureAiBackendService(): AiBackendService {
  const credentials = new MemoryCredentialStore()
  credentials.values.set('model:fixture', 'fixture-secret')
  return new AiBackendService(
    new InMemoryAiBackendRepository({
      connections: [{
        id: 'model:fixture',
        adapterId: 'openai-compatible',
        providerId: 'openai_compatible',
        protocol: 'openai_chat_completions',
        baseUrl: 'http://localhost:11434/v1',
        model: 'fixture-model',
        credentialRef: 'model:fixture'
      }]
    }),
    credentials,
    new FixtureAgentAdapter(),
    new FixtureModelAdapter(),
    new FixtureCodingPlanBackend()
  )
}

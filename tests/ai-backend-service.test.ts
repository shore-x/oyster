import { describe, expect, it, vi } from 'vitest'
import type { Api, Model } from '@earendil-works/pi-ai'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import type {
  AiConnection,
  AvailableModel,
  CodingPlanAuthentication,
  CodingPlanLoginMethod,
  ModelProviderId,
  ReasoningEffort
} from '../src/shared/ai-backends'
import {
  AiBackendService,
  type CodingPlanBackend
} from '../src/main/ai-backends/ai-backend-service'
import { MemoryCredentialStore } from '../src/main/ai-backends/credential-store'
import { ModelConnectionFailureError } from '../src/main/ai-backends/model'
import type {
  AgentBackendAdapter,
  AiBackendRepository,
  AgentTaskRequest,
  ModelBackendAdapter,
  ModelGenerationRequest,
  ModelRuntime,
  StoredModelConnection
} from '../src/main/ai-backends/model'
import { InMemoryAiBackendRepository } from '../src/main/ai-backends/repository'

function runtime(modelId: string): ModelRuntime {
  return {
    model: {
      id: modelId,
      name: modelId,
      provider: 'test-provider',
      api: 'openai-responses',
      baseUrl: 'https://example.test/v1',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000,
      maxTokens: 100
    } as Model<Api>,
    streamFn: (() => {
      throw new Error('fake stream must not be called by AiBackendService tests')
    }) as StreamFn
  }
}

class FakeCodexDiscovery implements AgentBackendAdapter {
  readonly id = 'codex' as const

  async inspect(): Promise<AiConnection> {
    return {
      id: 'runtime:codex',
      adapterId: 'codex',
      backendKind: 'coding_plan',
      providerId: 'openai_codex',
      displayName: 'Codex discovery',
      credentialMode: 'provider_runtime',
      status: 'ready',
      models: [],
      executablePath: '/usr/local/bin/codex',
      accountLabel: 'user@example.com',
      planType: 'pro'
    }
  }

  async connect(): Promise<undefined> { return undefined }
  cancelConnect(): void {}
  async runTask(_request: AgentTaskRequest): Promise<{ text: string }> { return { text: 'DISCOVERY' } }
  subscribe(_listener: () => void): () => void { return () => undefined }
  dispose(): void {}
}

interface CodingPlanCall {
  modelId: string
  request: ModelGenerationRequest
}

class FakeCodingPlanBackend implements CodingPlanBackend {
  models: AvailableModel[] = [
    {
      id: 'gpt-codex-mini',
      displayName: 'GPT Codex mini',
      reasoningEfforts: ['low', 'medium']
    },
    {
      id: 'gpt-codex-large',
      displayName: 'GPT Codex large',
      reasoningEfforts: ['low', 'medium', 'high']
    }
  ]
  calls: CodingPlanCall[] = []
  runtimeCalls: string[] = []
  loginMethods: CodingPlanLoginMethod[] = []
  connectHandler?: (
    loginMethod: CodingPlanLoginMethod,
    onAuthenticationUpdate?: (authentication: CodingPlanAuthentication) => void
  ) => Promise<void>
  cancelHandler?: () => void
  cancelCalls = 0
  failure?: Error

  listModels(): AvailableModel[] { return structuredClone(this.models) }
  async inspectAuth() { return { status: 'ready' as const } }
  async connect(
    loginMethod: CodingPlanLoginMethod,
    onAuthenticationUpdate?: (authentication: CodingPlanAuthentication) => void
  ): Promise<void> {
    this.loginMethods.push(loginMethod)
    await this.connectHandler?.(loginMethod, onAuthenticationUpdate)
  }
  cancelConnect(): void {
    this.cancelCalls += 1
    this.cancelHandler?.()
  }

  async generate(modelId: string, request: ModelGenerationRequest): Promise<{ text: string }> {
    this.calls.push({ modelId, request })
    request.signal?.throwIfAborted()
    if (this.failure) throw this.failure
    return { text: 'CODING_PLAN' }
  }

  runtime(modelId: string): ModelRuntime {
    this.runtimeCalls.push(modelId)
    return runtime(modelId)
  }

  dispose(): void {}
}

class FakeModelAdapter implements ModelBackendAdapter {
  readonly id = 'openai-compatible' as const
  calls: Array<{
    connection: StoredModelConnection
    apiKey?: string
    request: ModelGenerationRequest
  }> = []
  failure?: Error
  discoveredModels: AvailableModel[] = []
  listCalls: Array<{ providerId: ModelProviderId; baseUrl: string; apiKey?: string }> = []

  async listModels(
    providerId: ModelProviderId,
    baseUrl: string,
    apiKey?: string
  ): Promise<AvailableModel[]> {
    this.listCalls.push({ providerId, baseUrl, apiKey })
    return structuredClone(this.discoveredModels)
  }

  async generate(
    connection: StoredModelConnection,
    apiKey: string | undefined,
    request: ModelGenerationRequest
  ): Promise<{ text: string }> {
    this.calls.push({ connection, apiKey, request })
    request.signal?.throwIfAborted()
    if (this.failure) throw this.failure
    return { text: 'MODEL' }
  }
}

function createService(repository: AiBackendRepository = new InMemoryAiBackendRepository()) {
  const credentials = new MemoryCredentialStore()
  const discovery = new FakeCodexDiscovery()
  const model = new FakeModelAdapter()
  const codingPlan = new FakeCodingPlanBackend()
  const apiRuntimeCalls: Array<{ modelId: string; apiKey?: string }> = []
  const service = new AiBackendService(
    repository,
    credentials,
    discovery,
    model,
    codingPlan,
    (connection, apiKey) => {
      apiRuntimeCalls.push({ modelId: connection.model, apiKey })
      return runtime(connection.model)
    }
  )
  return { service, repository, credentials, discovery, model, codingPlan, apiRuntimeCalls }
}

async function saveApiConnection(
  service: AiBackendService,
  model = 'default-model',
  apiKey?: string
): Promise<string> {
  const snapshot = await service.saveModelConnection({
    providerId: 'openai_compatible',
    protocol: 'openai_responses',
    baseUrl: 'http://localhost:11434/v1',
    model,
    apiKey
  })
  return snapshot.connections.find(
    (connection) => connection.backendKind === 'api' && connection.defaultModelId === model
  )!.id
}

describe('AiBackendService', () => {
  it('discovers models without persisting the temporary key and uses the fixed OpenAI endpoint', async () => {
    const { service, repository, model } = createService()
    await service.initialize()
    model.discoveredModels = [{
      id: 'gpt-5-mini',
      displayName: 'GPT-5 mini',
      reasoningEfforts: ['minimal', 'low', 'medium', 'high']
    }]

    await expect(service.discoverModels({
      providerId: 'openai',
      baseUrl: 'https://attacker.example/v1',
      apiKey: '  temporary-secret  '
    })).resolves.toEqual({ models: model.discoveredModels })
    expect(model.listCalls).toEqual([{
      providerId: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'temporary-secret'
    }])
    expect(await repository.load()).toEqual({ connections: [] })
    expect(JSON.stringify(service.snapshot())).not.toContain('temporary-secret')

    await expect(service.discoverModels({
      providerId: 'openai',
      baseUrl: 'https://api.openai.com/v1'
    })).rejects.toThrow('需要 API Key')
  })

  it('isolates unreadable AI configuration without blocking backend discovery or overwriting it', async () => {
    const repository: AiBackendRepository = {
      load: async () => { throw new Error('invalid JSON') },
      save: async () => { throw new Error('must not save') }
    }
    const { service } = createService(repository)

    await expect(service.initialize()).resolves.toBeUndefined()
    expect(service.snapshot().configurationError).toContain('invalid JSON')
    await expect(service.refresh()).resolves.toMatchObject({
      connections: [{
        id: 'runtime:codex',
        status: 'ready',
        models: expect.arrayContaining([expect.objectContaining({ id: 'gpt-codex-mini' })])
      }]
    })
    await expect(service.saveModelConnection({
      providerId: 'openai_compatible',
      protocol: 'openai_responses',
      baseUrl: 'http://localhost:11434/v1',
      model: 'test-model'
    })).rejects.toThrow('不可修改')
  })

  it('keeps API keys out of snapshots and persisted connection metadata', async () => {
    const { service, repository, credentials } = createService()
    await service.initialize()
    const connectionId = await saveApiConnection(service, 'test-model', 'super-secret-key')

    const serialized = JSON.stringify(service.snapshot())
    expect(serialized).not.toContain('super-secret-key')
    const stored = await repository.load()
    expect(JSON.stringify(stored)).not.toContain('super-secret-key')
    expect(credentials.values.get(stored.connections[0].credentialRef!)).toBe('super-secret-key')
    expect(service.snapshot().connections.find((connection) => connection.id === connectionId)?.modelConfig?.hasApiKey).toBe(true)
  })

  it('serializes concurrent API connection mutations', async () => {
    const { service, repository } = createService()
    await service.initialize()
    const firstId = await saveApiConnection(service, 'first')
    const secondId = await saveApiConnection(service, 'second')

    await Promise.all([service.removeConnection(firstId), service.removeConnection(secondId)])
    expect((await repository.load()).connections).toEqual([])
    expect(service.snapshot().connections).toHaveLength(1)
  })

  it('passes the explicitly selected Coding Plan model and reasoning effort to generation', async () => {
    const { service, codingPlan, model } = createService()
    await service.initialize()

    await expect(service.testConnection({
      connectionId: 'runtime:codex',
      modelId: 'gpt-codex-large',
      reasoningEffort: 'high'
    })).resolves.toMatchObject({ connectionId: 'runtime:codex', output: 'CODING_PLAN' })

    expect(codingPlan.calls).toHaveLength(1)
    expect(codingPlan.calls[0]).toMatchObject({
      modelId: 'gpt-codex-large',
      request: { reasoningEffort: 'high' }
    })
    expect(model.calls).toHaveLength(0)
  })

  it('publishes a transient device-code challenge and clears it after login', async () => {
    const { service, codingPlan } = createService()
    await service.initialize()
    const snapshots: AiConnection[] = []
    const unsubscribe = service.subscribe((snapshot) => {
      const connection = snapshot.connections.find((candidate) => candidate.id === 'runtime:codex')
      if (connection) snapshots.push(connection)
    })
    codingPlan.connectHandler = async (_method, onAuthenticationUpdate) => {
      onAuthenticationUpdate?.({
        loginMethod: 'device_code',
        verificationUri: 'https://auth.openai.com/codex/device',
        userCode: 'ABCD-1234',
        expiresAt: '2026-07-27T10:00:00.000Z'
      })
    }

    const result = await service.connect({
      connectionId: 'runtime:codex',
      loginMethod: 'device_code'
    })
    unsubscribe()

    expect(codingPlan.loginMethods).toEqual(['device_code'])
    expect(snapshots).toContainEqual(expect.objectContaining({
      status: 'authenticating',
      authentication: expect.objectContaining({ userCode: 'ABCD-1234' })
    }))
    expect(result.connections.find((connection) => connection.id === 'runtime:codex'))
      .toMatchObject({ status: 'ready' })
    expect(result.connections.find((connection) => connection.id === 'runtime:codex')?.authentication)
      .toBeUndefined()
  })

  it('validates login configuration and forwards cancellation to the active backend', async () => {
    const { service, codingPlan } = createService()
    await service.initialize()

    await expect(service.connect({
      connectionId: 'runtime:codex',
      loginMethod: 'unsupported' as CodingPlanLoginMethod
    })).rejects.toThrow('登录方式无效')

    service.cancelConnect('runtime:codex')
    expect(codingPlan.cancelCalls).toBe(1)
  })

  it('clears transient authentication state after the user cancels login', async () => {
    const { service, codingPlan } = createService()
    await service.initialize()
    let rejectLogin!: (error: Error) => void
    codingPlan.connectHandler = async (_method, onAuthenticationUpdate) => {
      onAuthenticationUpdate?.({
        loginMethod: 'device_code',
        verificationUri: 'https://auth.openai.com/codex/device',
        userCode: 'ABCD-1234'
      })
      return new Promise((_resolve, reject) => { rejectLogin = reject })
    }
    codingPlan.cancelHandler = () => rejectLogin(new Error('用户取消了 Coding Plan 认证'))

    const connecting = service.connect({
      connectionId: 'runtime:codex',
      loginMethod: 'device_code'
    })
    await vi.waitFor(() => {
      expect(service.snapshot().connections[0].authentication?.userCode).toBe('ABCD-1234')
    })
    service.cancelConnect('runtime:codex')

    await expect(connecting).rejects.toThrow('用户取消')
    expect(codingPlan.cancelCalls).toBe(1)
    expect(service.snapshot().connections[0]).toMatchObject({ status: 'ready' })
    expect(service.snapshot().connections[0].authentication).toBeUndefined()
  })

  it('passes a selected non-default API model to direct generation and Agent runtime', async () => {
    const { service, model, apiRuntimeCalls } = createService()
    await service.initialize()
    const connectionId = await saveApiConnection(service, 'default-model', 'api-secret')
    model.discoveredModels = [{
      id: 'smaller-model',
      displayName: 'Smaller model',
      reasoningEfforts: ['low']
    }]
    await service.refresh()

    await expect(service.generateWithModel(
      connectionId,
      'smaller-model',
      { prompt: 'probe' }
    )).resolves.toEqual({ text: 'MODEL' })
    expect(model.calls[0]).toMatchObject({
      connection: { id: connectionId, model: 'smaller-model' },
      apiKey: 'api-secret'
    })

    await expect(service.withModelRuntime(
      connectionId,
      'smaller-model',
      async (selectedRuntime) => selectedRuntime.model.id
    )).resolves.toBe('smaller-model')
    expect(apiRuntimeCalls).toContainEqual({ modelId: 'smaller-model', apiKey: 'api-secret' })
  })

  it('rejects a model outside the selected connection before invoking any backend', async () => {
    const { service, model, codingPlan } = createService()
    await service.initialize()
    const connectionId = await saveApiConnection(service, 'default-model')

    await expect(service.generateWithModel(
      connectionId,
      'not-on-this-connection',
      { prompt: 'probe' }
    )).rejects.toThrow('不属于该 Connection')
    await expect(service.testConnection({
      connectionId: 'runtime:codex',
      modelId: 'not-a-coding-plan-model'
    })).rejects.toThrow('不属于该 Connection')

    expect(model.calls).toHaveLength(0)
    expect(codingPlan.calls).toHaveLength(0)
  })

  it('rejects an unsupported reasoning effort before generation', async () => {
    const { service, codingPlan } = createService()
    await service.initialize()

    await expect(service.testConnection({
      connectionId: 'runtime:codex',
      modelId: 'gpt-codex-mini',
      reasoningEffort: 'high'
    })).rejects.toThrow('不支持该思考强度')
    expect(codingPlan.calls).toHaveLength(0)
  })

  it('executes only the explicitly selected API connection and never falls back', async () => {
    const { service, codingPlan, model } = createService()
    await service.initialize()
    const connectionId = await saveApiConnection(service, 'test-model')
    model.failure = new Error('provider unavailable')

    await expect(service.testConnection({
      connectionId,
      modelId: 'test-model'
    })).rejects.toThrow('provider unavailable')
    expect(codingPlan.calls).toHaveLength(0)
    expect(model.calls).toHaveLength(1)
    expect(service.snapshot().connections.find((connection) => connection.id === connectionId)).toMatchObject({
      status: 'unavailable'
    })
  })

  it('does not treat local Agent operation failures as connection failures', async () => {
    const { service } = createService()
    await service.initialize()
    const connectionId = await saveApiConnection(service, 'test-model')

    await expect(service.withModelRuntime(
      connectionId,
      'test-model',
      async () => { throw new Error('Knowledge Maintenance Agent 未提交 Knowledge Contribution') }
    )).rejects.toThrow('未提交')

    expect(service.snapshot().connections.find((connection) => connection.id === connectionId)).toMatchObject({
      id: connectionId,
      status: 'unverified',
      errorMessage: undefined,
      lastCheckedAt: undefined
    })
  })

  it('preserves existing connection health when a later local Agent operation is cancelled', async () => {
    const { service } = createService()
    await service.initialize()
    const connectionId = await saveApiConnection(service, 'test-model')

    await expect(service.generateWithModel(
      connectionId,
      'test-model',
      { prompt: 'probe' }
    )).resolves.toEqual({ text: 'MODEL' })
    const healthyState = service.snapshot().connections.find((connection) => connection.id === connectionId)
    expect(healthyState?.status).toBe('ready')

    await expect(service.withModelRuntime(
      connectionId,
      'test-model',
      async () => { throw new Error('用户取消了运行') }
    )).rejects.toThrow('用户取消')
    expect(service.snapshot().connections.find((connection) => connection.id === connectionId)).toEqual(healthyState)
  })

  it('tracks only typed model transport outcomes for a Knowledge Agent operation', async () => {
    const { service } = createService()
    await service.initialize()
    const connectionId = await saveApiConnection(service, 'test-model')

    await expect(service.withModelRuntime(
      connectionId,
      'test-model',
      async () => 'candidate',
      { trackHealth: true }
    )).resolves.toBe('candidate')
    expect(service.snapshot().connections.find((connection) => connection.id === connectionId)).toMatchObject({ status: 'ready' })

    await expect(service.withModelRuntime(
      connectionId,
      'test-model',
      async () => { throw new ModelConnectionFailureError(new Error('provider 401')) },
      { trackHealth: true }
    )).rejects.toThrow('provider 401')
    const unavailableState = service.snapshot().connections.find((connection) => connection.id === connectionId)
    expect(unavailableState).toMatchObject({ status: 'unavailable', errorMessage: 'provider 401' })

    await expect(service.withModelRuntime(
      connectionId,
      'test-model',
      async () => { throw new Error('Knowledge Maintenance Agent 未提交 Knowledge Contribution') },
      { trackHealth: true }
    )).rejects.toThrow('未提交')
    expect(service.snapshot().connections.find((connection) => connection.id === connectionId)).toEqual(unavailableState)
  })

  it('does not mark a connection unavailable when generation is cancelled by the user', async () => {
    const { service } = createService()
    await service.initialize()
    const connectionId = await saveApiConnection(service, 'test-model')
    await service.generateWithModel(connectionId, 'test-model', { prompt: 'probe' })
    const healthyState = service.snapshot().connections.find((connection) => connection.id === connectionId)

    const controller = new AbortController()
    controller.abort(new Error('用户取消了运行'))
    await expect(service.generateWithModel(connectionId, 'test-model', {
      prompt: 'cancelled generation',
      signal: controller.signal
    })).rejects.toThrow('用户取消')

    expect(service.snapshot().connections.find((connection) => connection.id === connectionId)).toEqual(healthyState)
  })

  it('provides the explicitly selected Coding Plan runtime', async () => {
    const { service, codingPlan } = createService()
    await service.initialize()

    await expect(service.withModelRuntime(
      'runtime:codex',
      'gpt-codex-large',
      async (selectedRuntime) => selectedRuntime.model.id
    )).resolves.toBe('gpt-codex-large')
    expect(codingPlan.runtimeCalls).toEqual(['gpt-codex-large'])
  })

  it.each<ReasoningEffort>(['minimal', 'xhigh', 'max'])('rejects unavailable Coding Plan effort %s', async (reasoningEffort) => {
    const { service } = createService()
    await service.initialize()
    await expect(service.testConnection({
      connectionId: 'runtime:codex',
      modelId: 'gpt-codex-large',
      reasoningEffort
    })).rejects.toThrow('不支持该思考强度')
  })
})

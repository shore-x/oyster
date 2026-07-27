import { describe, expect, it, vi } from 'vitest'
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type AuthCheck,
  type AuthInteraction,
  type AuthType,
  type Context,
  type Credential,
  type CredentialStore,
  type Model,
  type ModelsSimpleStreamOptions
} from '@earendil-works/pi-ai'
import {
  PI_CODING_PLAN_PROVIDER_ID,
  PiCodingPlanAdapter,
  type PiCodingPlanModels
} from '../src/main/ai-backends/pi-coding-plan-adapter'
import type { CodingPlanAuthentication } from '../src/shared/ai-backends'

const MODEL: Model<Api> = {
  id: 'gpt-codex-small',
  name: 'GPT Codex Small',
  api: 'openai-codex-responses',
  provider: 'openai-codex',
  baseUrl: 'https://chatgpt.com/backend-api',
  reasoning: true,
  thinkingLevelMap: { xhigh: 'xhigh', max: null },
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 32_768,
  compat: { supportsOpenAIGrammarTools: true }
}

function usage(): AssistantMessage['usage'] {
  return {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  }
}

function assistant(text: string, stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    usage: usage(),
    stopReason,
    timestamp: Date.now()
  }
}

class FakeModels implements PiCodingPlanModels {
  auth?: AuthCheck
  authError?: Error
  loginHandler?: (interaction: AuthInteraction) => Promise<Credential>
  completeResult = assistant('generated')
  completeCalls: Array<{
    model: Model<Api>
    context: Context
    options?: ModelsSimpleStreamOptions
  }> = []
  streamCalls: Array<{
    model: Model<Api>
    context: Context
    options?: ModelsSimpleStreamOptions
  }> = []
  readonly stream = createAssistantMessageEventStream()

  getModels(provider?: string): readonly Model<Api>[] {
    return provider === PI_CODING_PLAN_PROVIDER_ID ? [MODEL] : []
  }

  getModel(provider: string, modelId: string): Model<Api> | undefined {
    return provider === PI_CODING_PLAN_PROVIDER_ID && modelId === MODEL.id ? MODEL : undefined
  }

  async checkAuth(_providerId: string): Promise<AuthCheck | undefined> {
    if (this.authError) throw this.authError
    return this.auth
  }

  async login(
    providerId: string,
    type: AuthType,
    interaction: AuthInteraction
  ): Promise<Credential> {
    expect(providerId).toBe(PI_CODING_PLAN_PROVIDER_ID)
    expect(type).toBe('oauth')
    if (!this.loginHandler) throw new Error('login handler missing')
    return this.loginHandler(interaction)
  }

  async completeSimple(
    model: Model<Api>,
    context: Context,
    options?: ModelsSimpleStreamOptions
  ): Promise<AssistantMessage> {
    this.completeCalls.push({ model, context, options })
    return this.completeResult
  }

  streamSimple(
    model: Model<Api>,
    context: Context,
    options?: ModelsSimpleStreamOptions
  ): AssistantMessageEventStream {
    this.streamCalls.push({ model, context, options })
    return this.stream
  }
}

const UNUSED_CREDENTIALS: CredentialStore = {
  read: async () => undefined,
  list: async () => [],
  modify: async (_providerId, update) => update(undefined),
  delete: async () => undefined
}

function createAdapter(
  models = new FakeModels(),
  openExternal = vi.fn(async () => undefined),
  authenticationTimeoutMs?: number
) {
  return {
    adapter: new PiCodingPlanAdapter({
      credentials: UNUSED_CREDENTIALS,
      models,
      openExternal,
      authenticationTimeoutMs
    }),
    models,
    openExternal
  }
}

describe('PiCodingPlanAdapter', () => {
  it('exposes the Pi Codex model catalog with supported reasoning efforts', () => {
    const { adapter } = createAdapter()
    expect(adapter.listModels()).toEqual([{
      id: MODEL.id,
      displayName: MODEL.name,
      reasoningEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh']
    }])
  })

  it('maps configured OAuth, missing auth, unsupported auth, and inspection errors', async () => {
    const { adapter, models } = createAdapter()
    await expect(adapter.inspectAuth()).resolves.toEqual({ status: 'needs_auth' })

    models.auth = { type: 'oauth', source: 'OAuth' }
    await expect(adapter.inspectAuth()).resolves.toEqual({ status: 'ready' })

    models.auth = { type: 'api_key', source: 'API key' }
    await expect(adapter.inspectAuth()).resolves.toMatchObject({ status: 'unsupported' })

    models.authError = new Error('keychain unavailable')
    await expect(adapter.inspectAuth()).resolves.toEqual({
      status: 'unavailable',
      errorMessage: 'keychain unavailable'
    })
  })

  it('runs browser OAuth through a main-process opener without returning the URL', async () => {
    const { adapter, models, openExternal } = createAdapter()
    models.loginHandler = async (interaction) => {
      const method = await interaction.prompt({
        type: 'select',
        message: 'method',
        options: [{ id: 'browser', label: 'Browser' }, { id: 'device_code', label: 'Device' }]
      })
      expect(method).toBe('browser')
      interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/oauth/authorize' })
      return {
        type: 'oauth',
        access: 'access',
        refresh: 'refresh',
        expires: Date.now() + 60_000,
        accountId: 'account'
      }
    }

    await expect(adapter.connect('browser')).resolves.toBeUndefined()
    expect(openExternal).toHaveBeenCalledWith('https://auth.openai.com/oauth/authorize')
  })

  it('selects device-code OAuth and publishes the user-visible challenge', async () => {
    const { adapter, models, openExternal } = createAdapter()
    models.loginHandler = async (interaction) => {
      const method = await interaction.prompt({
        type: 'select',
        message: 'method',
        options: [{ id: 'browser', label: 'Browser' }, { id: 'device_code', label: 'Device' }]
      })
      expect(method).toBe('device_code')
      interaction.notify({
        type: 'device_code',
        userCode: 'ABCD-1234',
        verificationUri: 'https://auth.openai.com/codex/device',
        intervalSeconds: 5,
        expiresInSeconds: 900
      })
      return {
        type: 'oauth',
        access: 'access',
        refresh: 'refresh',
        expires: Date.now() + 60_000,
        accountId: 'account'
      }
    }
    const updates: CodingPlanAuthentication[] = []

    await expect(adapter.connect('device_code', (update) => updates.push(update)))
      .resolves.toBeUndefined()

    expect(updates).toEqual([{
      loginMethod: 'device_code',
      verificationUri: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-1234',
      expiresAt: expect.any(String)
    }])
    expect(Date.parse(updates[0].expiresAt!)).toBeGreaterThan(Date.now())
    expect(openExternal).toHaveBeenCalledWith('https://auth.openai.com/codex/device')
  })

  it('rejects an unsafe device verification URL', async () => {
    const { adapter, models, openExternal } = createAdapter()
    models.loginHandler = async (interaction) => {
      await interaction.prompt({
        type: 'select',
        message: 'method',
        options: [{ id: 'device_code', label: 'Device' }]
      })
      interaction.notify({
        type: 'device_code',
        userCode: 'ABCD-1234',
        verificationUri: 'http://attacker.example/device',
        intervalSeconds: 5,
        expiresInSeconds: 900
      })
      return {
        type: 'oauth',
        access: 'access',
        refresh: 'refresh',
        expires: Date.now() + 60_000,
        accountId: 'account'
      }
    }

    await expect(adapter.connect('device_code')).rejects.toThrow('不安全')
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('keeps device-code login usable when the local browser cannot be opened', async () => {
    const models = new FakeModels()
    const openExternal = vi.fn(async () => { throw new Error('no desktop browser') })
    const { adapter } = createAdapter(models, openExternal)
    models.loginHandler = async (interaction) => {
      await interaction.prompt({
        type: 'select',
        message: 'method',
        options: [{ id: 'device_code', label: 'Device' }]
      })
      interaction.notify({
        type: 'device_code',
        userCode: 'ABCD-1234',
        verificationUri: 'https://auth.openai.com/codex/device',
        intervalSeconds: 5,
        expiresInSeconds: 900
      })
      return {
        type: 'oauth',
        access: 'access',
        refresh: 'refresh',
        expires: Date.now() + 60_000,
        accountId: 'account'
      }
    }

    await expect(adapter.connect('device_code')).resolves.toBeUndefined()
    expect(openExternal).toHaveBeenCalledOnce()
  })

  it('fails clearly when Pi does not expose the requested login method', async () => {
    const { adapter, models } = createAdapter()
    models.loginHandler = async (interaction) => {
      await interaction.prompt({
        type: 'select',
        message: 'method',
        options: [{ id: 'browser', label: 'Browser' }]
      })
      throw new Error('unreachable')
    }

    await expect(adapter.connect('device_code')).rejects.toThrow('不支持设备码登录')
  })

  it('cancels an active OAuth flow through its AbortController', async () => {
    const { adapter, models } = createAdapter()
    let started!: () => void
    const loginStarted = new Promise<void>((resolve) => { started = resolve })
    models.loginHandler = (interaction) => new Promise((_resolve, reject) => {
      const abort = (): void => reject(interaction.signal?.reason ?? new Error('aborted'))
      interaction.signal?.addEventListener('abort', abort, { once: true })
      started()
    })

    const connecting = adapter.connect('device_code')
    await loginStarted
    adapter.cancelConnect()
    await expect(connecting).rejects.toThrow('用户取消')
  })

  it('times out an OAuth flow that never completes', async () => {
    const models = new FakeModels()
    const { adapter } = createAdapter(models, vi.fn(async () => undefined), 10)
    models.loginHandler = (interaction) => new Promise((_resolve, reject) => {
      interaction.signal?.addEventListener('abort', () => reject(new Error('upstream cancelled')), {
        once: true
      })
    })

    await expect(adapter.connect('browser')).rejects.toThrow('认证超时')
  })

  it('treats a committed credential as success when cancellation races with final browser opening', async () => {
    const models = new FakeModels()
    let releaseBrowser!: () => void
    const browserReleased = new Promise<void>((resolve) => { releaseBrowser = resolve })
    const openExternal = vi.fn(() => browserReleased)
    const { adapter } = createAdapter(models, openExternal)
    let loginReturned!: () => void
    const loginCompleted = new Promise<void>((resolve) => { loginReturned = resolve })
    models.loginHandler = async (interaction) => {
      await interaction.prompt({
        type: 'select',
        message: 'method',
        options: [{ id: 'browser', label: 'Browser' }]
      })
      interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/oauth/authorize' })
      loginReturned()
      return {
        type: 'oauth',
        access: 'access',
        refresh: 'refresh',
        expires: Date.now() + 60_000,
        accountId: 'account'
      }
    }

    const connecting = adapter.connect('browser')
    await loginCompleted
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledOnce())
    adapter.cancelConnect()
    releaseBrowser()

    await expect(connecting).resolves.toBeUndefined()
  })

  it('generates with the selected model and bounded direct-call options', async () => {
    const { adapter, models } = createAdapter()
    await expect(adapter.generate(MODEL.id, {
      systemPrompt: 'system',
      prompt: 'observation',
      maxOutputTokens: 123,
      timeoutMs: 2_000,
      maxResponseBytes: 1_024,
      reasoningEffort: 'low'
    })).resolves.toEqual({ text: 'generated' })

    expect(models.completeCalls).toHaveLength(1)
    expect(models.completeCalls[0]).toMatchObject({
      model: { id: MODEL.id },
      context: {
        systemPrompt: 'system',
        messages: [{ role: 'user', content: 'observation' }]
      },
      options: {
        maxTokens: 123,
        maxRetries: 0,
        timeoutMs: 2_000,
        reasoning: 'low'
      }
    })

    await expect(adapter.generate(MODEL.id, {
      prompt: 'observation',
      reasoningEffort: 'max'
    })).rejects.toThrow('不支持思考强度')
    await expect(adapter.generate('missing-model', { prompt: 'observation' }))
      .rejects.toThrow('当前不可用')
  })

  it('provides a selected-model StreamFn for Pi Agent Core', () => {
    const { adapter, models } = createAdapter()
    const runtime = adapter.runtime(MODEL.id)
    const context: Context = { messages: [] }
    const output = runtime.streamFn(runtime.model, context, { reasoning: 'high' })

    expect(output).toBe(models.stream)
    expect(runtime.model.id).toBe(MODEL.id)
    expect(models.streamCalls).toEqual([{
      model: MODEL,
      context,
      options: { reasoning: 'high' }
    }])
  })
})

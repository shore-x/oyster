import { createRoot } from 'solid-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AiBackendApi,
  AiBackendSnapshot,
  TestConnectionInput
} from '../src/shared/ai-backends'
import { createAiBackendsController } from '../src/renderer/src/ai-backends-controller'

vi.mock('solid-js', async () => vi.importActual('solid-js/dist/solid.js'))

const SNAPSHOT: AiBackendSnapshot = { options: [], connections: [] }

function installApi(
  testConnection: AiBackendApi['testConnection'],
  overrides: Partial<AiBackendApi> = {}
): void {
  const api: AiBackendApi = {
    getSnapshot: async () => SNAPSHOT,
    refresh: async () => SNAPSHOT,
    connect: async () => SNAPSHOT,
    cancelConnect: async () => undefined,
    saveModelConnection: async () => SNAPSHOT,
    discoverModels: async () => ({ models: [] }),
    removeConnection: async () => SNAPSHOT,
    testConnection,
    subscribe: () => () => undefined,
    ...overrides
  }
  vi.stubGlobal('window', { oyster: { aiBackends: api } })
}

afterEach(() => vi.unstubAllGlobals())

describe('AI backends controller', () => {
  it('loads the current snapshot without refreshing and preserves a newer subscription update', async () => {
    const initialSnapshot: AiBackendSnapshot = {
      options: [],
      connections: [{
        id: 'runtime:codex',
        adapterId: 'codex',
        backendKind: 'coding_plan',
        providerId: 'openai_codex',
        displayName: 'OpenAI Codex Coding Plan',
        credentialMode: 'oyster_keychain',
        status: 'unverified',
        models: []
      }]
    }
    const subscribedSnapshot: AiBackendSnapshot = {
      options: [],
      connections: [{
        ...initialSnapshot.connections[0],
        status: 'ready'
      }]
    }
    let resolveInitialSnapshot!: (snapshot: AiBackendSnapshot) => void
    let publishSnapshot!: (snapshot: AiBackendSnapshot) => void
    const getSnapshot = vi.fn<AiBackendApi['getSnapshot']>(() => new Promise((resolve) => {
      resolveInitialSnapshot = resolve
    }))
    const refresh = vi.fn<AiBackendApi['refresh']>(async () => initialSnapshot)
    const unsubscribe = vi.fn()
    installApi(async () => ({
      connectionId: 'runtime:codex',
      output: 'ok',
      durationMs: 10
    }), {
      getSnapshot,
      refresh,
      subscribe: (listener) => {
        publishSnapshot = listener
        return unsubscribe
      }
    })

    await createRoot(async (dispose) => {
      try {
        const controller = createAiBackendsController()
        await vi.waitFor(() => expect(getSnapshot).toHaveBeenCalledOnce())

        publishSnapshot(subscribedSnapshot)
        resolveInitialSnapshot(initialSnapshot)

        await vi.waitFor(() => expect(controller.snapshot()).toEqual(subscribedSnapshot))
        expect(refresh).not.toHaveBeenCalled()
      } finally {
        dispose()
      }
    })
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('uses the selected Coding Plan login method and forwards cancellation', async () => {
    const connect = vi.fn<AiBackendApi['connect']>(async () => SNAPSHOT)
    const cancelConnect = vi.fn<AiBackendApi['cancelConnect']>(async () => undefined)
    installApi(async () => ({
      connectionId: 'runtime:codex',
      output: 'ok',
      durationMs: 10
    }), { connect, cancelConnect })

    await createRoot(async (dispose) => {
      try {
        const controller = createAiBackendsController()
        await controller.connect('runtime:codex', 'device_code')
        await controller.cancelConnect('runtime:codex')

        expect(connect).toHaveBeenCalledWith({
          connectionId: 'runtime:codex',
          loginMethod: 'device_code'
        })
        expect(cancelConnect).toHaveBeenCalledWith('runtime:codex')
      } finally {
        dispose()
      }
    })
  })

  it('does not surface an explicit login cancellation as an error', async () => {
    let rejectConnect!: (error: Error) => void
    const connect = vi.fn<AiBackendApi['connect']>(() => new Promise((_resolve, reject) => {
      rejectConnect = reject
    }))
    const cancelConnect = vi.fn<AiBackendApi['cancelConnect']>(async () => {
      rejectConnect(new Error('用户取消了 Coding Plan 认证'))
    })
    installApi(async () => ({
      connectionId: 'runtime:codex',
      output: 'ok',
      durationMs: 10
    }), { connect, cancelConnect })

    await createRoot(async (dispose) => {
      try {
        const controller = createAiBackendsController()
        const connecting = controller.connect('runtime:codex', 'browser')
        await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce())
        await controller.cancelConnect('runtime:codex')

        await expect(connecting).resolves.toBe(false)
        expect(controller.error()).toBeUndefined()
        expect(controller.busy()).toBeUndefined()
      } finally {
        dispose()
      }
    })
  })

  it('tests the exact model and reasoning configuration selected by the user', async () => {
    const testConnection = vi.fn(async (input: TestConnectionInput) => ({
      connectionId: input.connectionId,
      output: 'ok',
      durationMs: 10
    }))
    installApi(testConnection)

    await createRoot(async (dispose) => {
      try {
        const controller = createAiBackendsController()
        const input: TestConnectionInput = {
          connectionId: 'coding-plan:openai-codex',
          modelId: 'gpt-5-mini',
          reasoningEffort: 'low'
        }

        await controller.testConnection(input)

        expect(testConnection).toHaveBeenCalledWith(input)
        expect(controller.testResult()?.output).toBe('ok')
        expect(controller.testedConfiguration()).toEqual(input)
      } finally {
        dispose()
      }
    })
  })
})

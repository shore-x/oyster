import { createRoot } from 'solid-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AiBackendApi,
  AiBackendSnapshot,
  TestConnectionInput
} from '../src/shared/ai-backends'
import { createAiBackendsController } from '../src/renderer/src/ai-backends-controller'

const SNAPSHOT: AiBackendSnapshot = { options: [], connections: [] }

function installApi(testConnection: AiBackendApi['testConnection']): void {
  const api: AiBackendApi = {
    getSnapshot: async () => SNAPSHOT,
    refresh: async () => SNAPSHOT,
    connect: async () => SNAPSHOT,
    saveModelConnection: async () => SNAPSHOT,
    discoverModels: async () => ({ models: [] }),
    removeConnection: async () => SNAPSHOT,
    testConnection,
    subscribe: () => () => undefined
  }
  vi.stubGlobal('window', { oyster: { aiBackends: api } })
}

afterEach(() => vi.unstubAllGlobals())

describe('AI backends controller', () => {
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

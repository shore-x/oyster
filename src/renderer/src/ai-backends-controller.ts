import { createSignal, onCleanup, onMount } from 'solid-js'
import type {
  AiBackendSnapshot,
  CodingPlanLoginMethod,
  DiscoverModelsInput,
  ModelDiscoveryResult,
  ConnectionTestResult,
  SaveModelConnectionInput,
  TestConnectionInput
} from '../../shared/ai-backends'

const EMPTY_SNAPSHOT: AiBackendSnapshot = { options: [], connections: [] }

export function createAiBackendsController() {
  const [snapshot, setSnapshot] = createSignal(EMPTY_SNAPSHOT)
  const [busy, setBusy] = createSignal<string>()
  const [error, setError] = createSignal<string>()
  const [testResult, setTestResult] = createSignal<ConnectionTestResult>()
  const [testedConfiguration, setTestedConfiguration] = createSignal<TestConnectionInput>()

  function errorText(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause)
  }

  function isCancellation(cause: unknown): boolean {
    return /(?:取消|cancel)/i.test(errorText(cause))
  }

  async function update(
    key: string,
    action: () => Promise<AiBackendSnapshot>
  ): Promise<boolean> {
    try {
      setBusy(key)
      setError(undefined)
      setSnapshot(await action())
      return true
    } catch (cause) {
      setError(errorText(cause))
      return false
    } finally {
      setBusy(undefined)
    }
  }

  onMount(() => {
    const unsubscribe = window.oyster.aiBackends.subscribe(setSnapshot)
    void update('refresh', () => window.oyster.aiBackends.refresh())
    onCleanup(unsubscribe)
  })

  return {
    snapshot,
    busy,
    error,
    testResult,
    testedConfiguration,
    refresh: () => update('refresh', () => window.oyster.aiBackends.refresh()),
    async connect(connectionId: string, loginMethod: CodingPlanLoginMethod): Promise<boolean> {
      try {
        setBusy(`connect:${connectionId}`)
        setError(undefined)
        setSnapshot(await window.oyster.aiBackends.connect({ connectionId, loginMethod }))
        return true
      } catch (cause) {
        if (!isCancellation(cause)) setError(errorText(cause))
        return false
      } finally {
        setBusy(undefined)
      }
    },
    async cancelConnect(connectionId: string): Promise<void> {
      try {
        setError(undefined)
        await window.oyster.aiBackends.cancelConnect(connectionId)
      } catch (cause) {
        setError(errorText(cause))
      }
    },
    async discoverModels(input: DiscoverModelsInput): Promise<ModelDiscoveryResult | undefined> {
      try {
        setBusy('discover-models')
        setError(undefined)
        return await window.oyster.aiBackends.discoverModels(input)
      } catch (cause) {
        setError(errorText(cause))
        return undefined
      } finally {
        setBusy(undefined)
      }
    },
    saveModelConnection: (input: SaveModelConnectionInput) => update(
      'save-model',
      () => window.oyster.aiBackends.saveModelConnection(input)
    ),
    removeConnection: (connectionId: string) => update(
      `remove:${connectionId}`,
      () => window.oyster.aiBackends.removeConnection(connectionId)
    ),
    async testConnection(input: TestConnectionInput): Promise<void> {
      try {
        setBusy(`test:${input.connectionId}`)
        setError(undefined)
        setTestResult(undefined)
        setTestedConfiguration(undefined)
        const result = await window.oyster.aiBackends.testConnection(input)
        if (!result.cancelled) {
          setTestedConfiguration(input)
          setTestResult(result)
        }
      } catch (cause) {
        setError(errorText(cause))
      } finally {
        setBusy(undefined)
      }
    }
  }
}

import { createSignal, onCleanup, onMount } from 'solid-js'
import type {
  AiBackendSnapshot,
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
      setError(cause instanceof Error ? cause.message : String(cause))
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
    connect: (connectionId: string) => update(
      `connect:${connectionId}`,
      () => window.oyster.aiBackends.connect(connectionId)
    ),
    async discoverModels(input: DiscoverModelsInput): Promise<ModelDiscoveryResult | undefined> {
      try {
        setBusy('discover-models')
        setError(undefined)
        return await window.oyster.aiBackends.discoverModels(input)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
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
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(undefined)
      }
    }
  }
}

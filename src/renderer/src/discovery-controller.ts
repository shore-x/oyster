import { createSignal, onCleanup, onMount } from 'solid-js'
import type { DiscoveryStateView } from '../../shared/discovery'

const EMPTY_STATE: DiscoveryStateView = { sources: [], scans: [] }

export function createDiscoveryController() {
  const [state, setState] = createSignal(EMPTY_STATE)
  const [detecting, setDetecting] = createSignal(false)
  const [error, setError] = createSignal<string>()

  async function execute(action: () => Promise<DiscoveryStateView>): Promise<void> {
    try {
      setError(undefined)
      setState(await action())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  onMount(() => {
    const unsubscribe = window.oyster.discovery.subscribe(setState)
    void execute(() => window.oyster.discovery.getState())
    onCleanup(unsubscribe)
  })

  return {
    state,
    detecting,
    error,
    async detectAgents() {
      setDetecting(true)
      await execute(() => window.oyster.discovery.detectAgents())
      setDetecting(false)
    },
    scanSource: (sourceId: string) => execute(() => window.oyster.discovery.scanSource(sourceId)),
    cancelScan: (scanId: string) => execute(() => window.oyster.discovery.cancelScan(scanId)),
    chooseSourceRoot: (sourceId: string) => execute(() => window.oyster.discovery.chooseSourceRoot(sourceId))
  }
}

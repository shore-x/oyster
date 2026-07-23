import { createSignal, onCleanup, onMount } from 'solid-js'
import type { DiscoverySnapshot } from '../../shared/discovery'

const EMPTY_SNAPSHOT: DiscoverySnapshot = { sources: [], runs: [] }

export function createDiscoveryController() {
  const [snapshot, setSnapshot] = createSignal(EMPTY_SNAPSHOT)
  const [detecting, setDetecting] = createSignal(false)
  const [error, setError] = createSignal<string>()

  async function run(action: () => Promise<DiscoverySnapshot>): Promise<void> {
    try {
      setError(undefined)
      setSnapshot(await action())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function runCommand(action: () => Promise<void>): Promise<void> {
    try {
      setError(undefined)
      await action()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  onMount(() => {
    const unsubscribe = window.oyster.discovery.subscribe(setSnapshot)
    void run(() => window.oyster.discovery.getSnapshot())
    onCleanup(unsubscribe)
  })

  return {
    snapshot,
    detecting,
    error,
    async detectAgents() {
      setDetecting(true)
      await run(() => window.oyster.discovery.detectAgents())
      setDetecting(false)
    },
    scanSource: (sourceId: string) => run(() => window.oyster.discovery.scanSource(sourceId)),
    importSource: (sourceId: string) => run(() => window.oyster.discovery.importSource(sourceId)),
    cancelRun: (runId: string) => run(() => window.oyster.discovery.cancelRun(runId)),
    chooseSourceRoot: (sourceId: string) => run(() => window.oyster.discovery.chooseSourceRoot(sourceId)),
    openRawEvidenceDirectory: () => runCommand(() => window.oyster.discovery.openRawEvidenceDirectory())
  }
}

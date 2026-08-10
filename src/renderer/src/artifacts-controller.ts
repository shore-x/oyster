import { createSignal, onMount } from 'solid-js'
import type { ArtifactSnapshot, CreateArtifactInput } from '../../shared/artifacts'

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function createArtifactsController() {
  const [snapshot, setSnapshot] = createSignal<ArtifactSnapshot>()
  const [busy, setBusy] = createSignal<string>()
  const [error, setError] = createSignal<string>()

  async function update(
    key: string,
    action: () => Promise<ArtifactSnapshot>
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

  async function open(key: string, action: () => Promise<void>): Promise<void> {
    try {
      setBusy(key)
      setError(undefined)
      await action()
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(undefined)
    }
  }

  onMount(() => {
    void update('load', () => window.oyster.artifacts.getSnapshot())
  })

  return {
    snapshot,
    busy,
    error,
    refresh: () => update('refresh', () => window.oyster.artifacts.refresh()),
    createArtifact: (input: CreateArtifactInput) => update(
      'create',
      () => window.oyster.artifacts.createArtifact(input)
    ),
    openRepository: () => open('open-repository', () => window.oyster.artifacts.openRepository()),
    openFolder: (folderPath: string, key: string) => open(
      `open:${key}`,
      () => window.oyster.folderBrowser.openFolder(folderPath)
    )
  }
}

import { createMemo, createSignal, onMount } from 'solid-js'
import type {
  DiscoveredSkill,
  SkillDiscoveryStateView,
  SkillDocument
} from '../../shared/skills'

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function createSkillDiscoveryController() {
  const [snapshot, setSnapshot] = createSignal<SkillDiscoveryStateView>()
  const [selectedId, setSelectedId] = createSignal<string>()
  const [document, setDocument] = createSignal<SkillDocument>()
  const [busy, setBusy] = createSignal<string>()
  const [error, setError] = createSignal<string>()
  let readGeneration = 0

  const selectedSkill = createMemo<DiscoveredSkill | undefined>(() => (
    snapshot()?.skills.find((skill) => skill.id === selectedId())
  ))

  async function select(skillId: string | undefined): Promise<void> {
    const generation = ++readGeneration
    setSelectedId(skillId)
    setDocument(undefined)
    if (!skillId) return

    const key = `read:${skillId}`
    try {
      setBusy(key)
      setError(undefined)
      const nextDocument = await window.oyster.skills.readDiscoveredDocument(skillId)
      if (generation === readGeneration && selectedId() === skillId) {
        setDocument(nextDocument)
      }
    } catch (cause) {
      if (generation === readGeneration) setError(errorText(cause))
    } finally {
      if (busy() === key) setBusy(undefined)
    }
  }

  async function replaceSnapshot(
    key: 'load' | 'discover',
    action: () => Promise<SkillDiscoveryStateView>
  ): Promise<boolean> {
    let nextSnapshot: SkillDiscoveryStateView
    try {
      setBusy(key)
      setError(undefined)
      nextSnapshot = await action()
      setSnapshot(nextSnapshot)
    } catch (cause) {
      setError(errorText(cause))
      return false
    } finally {
      if (busy() === key) setBusy(undefined)
    }

    const currentId = selectedId()
    const nextId = currentId && nextSnapshot.skills.some((skill) => skill.id === currentId)
      ? currentId
      : nextSnapshot.skills[0]?.id
    await select(nextId)
    return true
  }

  async function openFolder(skillId: string): Promise<void> {
    const key = `open:${skillId}`
    try {
      setBusy(key)
      setError(undefined)
      await window.oyster.skills.openDiscoveredFolder(skillId)
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      if (busy() === key) setBusy(undefined)
    }
  }

  onMount(() => {
    void replaceSnapshot('load', () => window.oyster.skills.getDiscoveryStateView())
  })

  return {
    snapshot,
    selectedId,
    selectedSkill,
    document,
    busy,
    error,
    discover: () => replaceSnapshot('discover', () => window.oyster.skills.discover()),
    select,
    openFolder
  }
}

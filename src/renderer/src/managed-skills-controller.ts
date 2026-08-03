import { createMemo, createSignal, onMount } from 'solid-js'
import type {
  ManagedSkillBindingInput,
  ManagedSkillDocument,
  ManagedSkillSnapshot,
  ManagedSkillSummary
} from '../../shared/skills'

type ManagedSkillAction = 'bind' | 'unbind'

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function managedSkillOperationKey(
  action: ManagedSkillAction,
  input: ManagedSkillBindingInput
): string {
  return `${action}:${input.artifactDirectoryName}:${input.targetId}`
}

function targetErrorKey(input: ManagedSkillBindingInput): string {
  return `${input.artifactDirectoryName}\0${input.targetId}`
}

export function createManagedSkillsController() {
  const [snapshot, setSnapshot] = createSignal<ManagedSkillSnapshot>()
  const [selectedDirectoryName, setSelectedDirectoryName] = createSignal<string>()
  const [document, setDocument] = createSignal<ManagedSkillDocument>()
  const [busyKeys, setBusyKeys] = createSignal<ReadonlySet<string>>(new Set())
  const [error, setError] = createSignal<string>()
  const [targetErrors, setTargetErrors] = createSignal<ReadonlyMap<string, string>>(new Map())
  let readGeneration = 0

  const selectedSkill = createMemo<ManagedSkillSummary | undefined>(() => (
    snapshot()?.skills.find((skill) => skill.artifactDirectoryName === selectedDirectoryName())
  ))

  function startBusy(key: string): void {
    setBusyKeys((current) => new Set(current).add(key))
  }

  function finishBusy(key: string): void {
    setBusyKeys((current) => {
      const next = new Set(current)
      next.delete(key)
      return next
    })
  }

  function clearTargetError(input: ManagedSkillBindingInput): void {
    setTargetErrors((current) => {
      const next = new Map(current)
      next.delete(targetErrorKey(input))
      return next
    })
  }

  async function select(artifactDirectoryName: string | undefined): Promise<void> {
    const generation = ++readGeneration
    setSelectedDirectoryName(artifactDirectoryName)
    setDocument(undefined)
    if (!artifactDirectoryName) return

    const skill = snapshot()?.skills.find((candidate) => (
      candidate.artifactDirectoryName === artifactDirectoryName
    ))
    if (!skill?.documentPath) return

    const key = `read:${artifactDirectoryName}`
    try {
      startBusy(key)
      setError(undefined)
      const nextDocument = await window.oyster.skills.readManagedDocument(artifactDirectoryName)
      if (generation === readGeneration && selectedDirectoryName() === artifactDirectoryName) {
        setDocument(nextDocument)
      }
    } catch (cause) {
      if (generation === readGeneration) setError(errorText(cause))
    } finally {
      finishBusy(key)
    }
  }

  async function replaceSnapshot(key: 'load' | 'refresh'): Promise<boolean> {
    let nextSnapshot: ManagedSkillSnapshot
    try {
      startBusy(key)
      setError(undefined)
      nextSnapshot = await window.oyster.skills.getManagedSnapshot()
      setSnapshot(nextSnapshot)
      setTargetErrors(new Map())
    } catch (cause) {
      setError(errorText(cause))
      return false
    } finally {
      finishBusy(key)
    }

    const current = selectedDirectoryName()
    const nextSelection = current && nextSnapshot.skills.some((skill) => (
      skill.artifactDirectoryName === current
    ))
      ? current
      : nextSnapshot.skills[0]?.artifactDirectoryName
    await select(nextSelection)
    return true
  }

  async function mutateBinding(
    action: ManagedSkillAction,
    input: ManagedSkillBindingInput
  ): Promise<boolean> {
    const key = managedSkillOperationKey(action, input)
    try {
      startBusy(key)
      setError(undefined)
      clearTargetError(input)
      const nextSnapshot = action === 'bind'
        ? await window.oyster.skills.bindManagedSkill(input)
        : await window.oyster.skills.unbindManagedSkill(input)
      setSnapshot(nextSnapshot)
      return true
    } catch (cause) {
      const message = errorText(cause)
      setTargetErrors((current) => new Map(current).set(targetErrorKey(input), message))
      return false
    } finally {
      finishBusy(key)
    }
  }

  async function openFolder(artifactDirectoryName: string): Promise<void> {
    const key = `open:${artifactDirectoryName}`
    try {
      startBusy(key)
      setError(undefined)
      await window.oyster.skills.openManagedFolder(artifactDirectoryName)
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      finishBusy(key)
    }
  }

  onMount(() => {
    void replaceSnapshot('load')
  })

  return {
    snapshot,
    selectedDirectoryName,
    selectedSkill,
    document,
    error,
    isBusy: (key: string) => busyKeys().has(key),
    actionError: (input: ManagedSkillBindingInput) => targetErrors().get(targetErrorKey(input)),
    refresh: () => replaceSnapshot('refresh'),
    select,
    openFolder,
    bind: (input: ManagedSkillBindingInput) => mutateBinding('bind', input),
    unbind: (input: ManagedSkillBindingInput) => mutateBinding('unbind', input)
  }
}

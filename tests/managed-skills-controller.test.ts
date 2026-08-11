import { createRoot } from 'solid-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ManagedSkillBindingInput,
  ManagedSkillDocument,
  ManagedSkillSnapshot,
  ManagedSkillSummary,
  SkillApi,
  SkillBindingTargetSummary
} from '../src/shared/skills'
import {
  createManagedSkillsController,
  managedSkillOperationKey
} from '../src/renderer/src/managed-skills-controller'

vi.mock('solid-js', async () => vi.importActual('solid-js/dist/solid.js'))

function target(overrides: Partial<SkillBindingTargetSummary> = {}): SkillBindingTargetSummary {
  return {
    id: 'claude:user',
    agentType: 'claude',
    agentDisplayName: 'Claude Code',
    scope: 'user',
    registrationRoot: '/home/demo/.claude/skills',
    state: 'unbound',
    shared: false,
    ...overrides
  }
}

function managedSkill(overrides: Partial<ManagedSkillSummary> = {}): ManagedSkillSummary {
  return {
    artifactDirectoryName: 'review-skill',
    artifactPath: '/app-data/artifacts/review-skill',
    outputPath: '/app-data/artifacts/review-skill/output',
    documentPath: '/app-data/artifacts/review-skill/output/SKILL.md',
    name: 'review',
    description: 'Review changes before delivery.',
    status: 'ready',
    targets: [target()],
    ...overrides
  }
}

function snapshot(skills: ManagedSkillSummary[] = [managedSkill()]): ManagedSkillSnapshot {
  return { skills, errors: [], scannedAt: '2026-08-01T08:00:00.000Z' }
}

function documentFor(artifactDirectoryName: string): ManagedSkillDocument {
  const content = '# Review\n\nKeep the change focused.'
  return {
    artifactDirectoryName,
    documentPath: `/app-data/artifacts/${artifactDirectoryName}/output/SKILL.md`,
    fileName: 'SKILL.md',
    content,
    sizeBytes: Buffer.byteLength(content),
    modifiedAt: '2026-08-01T08:00:00.000Z'
  }
}

function installApi(overrides: Partial<SkillApi> = {}): SkillApi {
  const api: SkillApi = {
    getDiscoveryStateView: async () => ({ skills: [], errors: [] }),
    discover: async () => ({ skills: [], errors: [] }),
    readDiscoveredDocument: async () => { throw new Error('not used') },
    openDiscoveredFolder: async () => undefined,
    getManagedSnapshot: async () => snapshot(),
    readManagedDocument: async (artifactDirectoryName) => documentFor(artifactDirectoryName),
    openManagedFolder: async () => undefined,
    bindManagedSkill: async () => snapshot(),
    unbindManagedSkill: async () => snapshot(),
    ...overrides
  }
  vi.stubGlobal('window', { oyster: { skills: api } })
  return api
}

afterEach(() => vi.unstubAllGlobals())

describe('managed skills controller', () => {
  it('loads Skill Artifacts and previews SKILL.md even when its metadata is invalid', async () => {
    const invalid = managedSkill({
      artifactDirectoryName: 'broken-skill',
      name: undefined,
      status: 'invalid',
      issue: 'SKILL.md 缺少有效 name',
      targets: []
    })
    const initial = snapshot([managedSkill(), invalid])
    const readManagedDocument = vi.fn<SkillApi['readManagedDocument']>(async (directoryName) => (
      documentFor(directoryName)
    ))
    installApi({ getManagedSnapshot: async () => initial, readManagedDocument })

    await createRoot(async (dispose) => {
      try {
        const controller = createManagedSkillsController()
        await vi.waitFor(() => expect(controller.document()?.artifactDirectoryName).toBe('review-skill'))

        expect(controller.snapshot()).toEqual(initial)
        expect(controller.selectedSkill()?.name).toBe('review')
        expect(readManagedDocument).toHaveBeenCalledOnce()

        await controller.select('broken-skill')
        expect(controller.selectedSkill()?.status).toBe('invalid')
        expect(controller.document()?.artifactDirectoryName).toBe('broken-skill')
        expect(readManagedDocument).toHaveBeenCalledTimes(2)
      } finally {
        dispose()
      }
    })
  })

  it('keeps target busy locally and replaces the snapshot only after binding succeeds', async () => {
    const input: ManagedSkillBindingInput = {
      artifactDirectoryName: 'review-skill',
      targetId: 'claude:user'
    }
    const before = snapshot()
    const after = snapshot([managedSkill({
      targets: [target({
        state: 'bound',
        bindingPath: '/home/demo/.claude/skills/review'
      })]
    })])
    let resolveBinding!: (value: ManagedSkillSnapshot) => void
    const bindManagedSkill = vi.fn<SkillApi['bindManagedSkill']>(() => new Promise((resolve) => {
      resolveBinding = resolve
    }))
    installApi({ getManagedSnapshot: async () => before, bindManagedSkill })

    await createRoot(async (dispose) => {
      try {
        const controller = createManagedSkillsController()
        await vi.waitFor(() => expect(controller.snapshot()).toEqual(before))

        const operation = controller.bind(input)
        const key = managedSkillOperationKey('bind', input)
        expect(controller.isBusy(key)).toBe(true)
        expect(controller.snapshot()?.skills[0].targets[0].state).toBe('unbound')

        resolveBinding(after)
        await expect(operation).resolves.toBe(true)
        expect(controller.isBusy(key)).toBe(false)
        expect(controller.snapshot()).toEqual(after)
        expect(bindManagedSkill).toHaveBeenCalledWith(input)
      } finally {
        dispose()
      }
    })
  })

  it('does not optimistically change state when an action fails and reports the target error', async () => {
    const input: ManagedSkillBindingInput = {
      artifactDirectoryName: 'review-skill',
      targetId: 'claude:user'
    }
    const initial = snapshot()
    installApi({
      getManagedSnapshot: async () => initial,
      bindManagedSkill: async () => { throw new Error('目标路径已存在') }
    })

    await createRoot(async (dispose) => {
      try {
        const controller = createManagedSkillsController()
        await vi.waitFor(() => expect(controller.snapshot()).toEqual(initial))

        await expect(controller.bind(input)).resolves.toBe(false)
        expect(controller.snapshot()).toEqual(initial)
        expect(controller.snapshot()?.skills[0].targets[0].state).toBe('unbound')
        expect(controller.actionError(input)).toBe('目标路径已存在')

        await expect(controller.refresh()).resolves.toBe(true)
        expect(controller.actionError(input)).toBeUndefined()
      } finally {
        dispose()
      }
    })
  })
})

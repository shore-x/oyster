import { createRoot } from 'solid-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  DiscoveredSkill,
  SkillApi,
  SkillDiscoveryStateView,
  SkillDocument
} from '../src/shared/skills'
import { createSkillDiscoveryController } from '../src/renderer/src/skill-discovery-controller'

vi.mock('solid-js', async () => vi.importActual('solid-js/dist/solid.js'))

const EMPTY_SNAPSHOT: SkillDiscoveryStateView = { skills: [], errors: [] }

function skill(overrides: Partial<DiscoveredSkill> = {}): DiscoveredSkill {
  return {
    id: 'codex:user:review',
    agentType: 'codex',
    agentDisplayName: 'Codex',
    name: 'review',
    description: 'Review a change before delivery.',
    scope: 'user',
    directoryPath: '/home/demo/.agents/skills/review',
    documentPath: '/home/demo/.agents/skills/review/SKILL.md',
    documentFileName: 'SKILL.md',
    format: 'agent_skill',
    sizeBytes: 128,
    modifiedAt: '2026-08-01T08:00:00.000Z',
    ...overrides
  }
}

function skillDocument(skillId: string, content = '# Review'): SkillDocument {
  return {
    skillId,
    documentPath: `/skills/${skillId}/SKILL.md`,
    fileName: 'SKILL.md',
    content,
    sizeBytes: Buffer.byteLength(content),
    modifiedAt: '2026-08-01T08:00:00.000Z'
  }
}

function installApi(overrides: Partial<SkillApi> = {}): SkillApi {
  const api: SkillApi = {
    getDiscoveryStateView: async () => EMPTY_SNAPSHOT,
    discover: async () => EMPTY_SNAPSHOT,
    readDiscoveredDocument: async (skillId) => skillDocument(skillId),
    openDiscoveredFolder: async () => undefined,
    getManagedSnapshot: async () => ({ skills: [], errors: [] }),
    readManagedDocument: async () => { throw new Error('not used') },
    openManagedFolder: async () => undefined,
    bindManagedSkill: async () => ({ skills: [], errors: [] }),
    unbindManagedSkill: async () => ({ skills: [], errors: [] }),
    ...overrides
  }
  vi.stubGlobal('window', { oyster: { skills: api } })
  return api
}

afterEach(() => vi.unstubAllGlobals())

describe('skill discovery controller', () => {
  it('loads the cached registrations and previews the first Skill document', async () => {
    const first = skill()
    const second = skill({
      id: 'claude:project:test',
      agentType: 'claude',
      agentDisplayName: 'Claude Code',
      name: 'test',
      scope: 'project',
      projectPath: '/work/oyster'
    })
    const snapshot = { skills: [first, second], errors: [] }
    const getDiscoveryStateView = vi.fn<SkillApi['getDiscoveryStateView']>(async () => snapshot)
    const readDiscoveredDocument = vi.fn<SkillApi['readDiscoveredDocument']>(async (skillId) => (
      skillDocument(skillId, `# ${skillId}`)
    ))
    installApi({ getDiscoveryStateView, readDiscoveredDocument })

    await createRoot(async (dispose) => {
      try {
        const controller = createSkillDiscoveryController()
        await vi.waitFor(() => expect(controller.document()?.skillId).toBe(first.id))

        expect(getDiscoveryStateView).toHaveBeenCalledOnce()
        expect(controller.snapshot()).toEqual(snapshot)
        expect(controller.selectedSkill()).toEqual(first)

        await controller.select(second.id)
        expect(readDiscoveredDocument).toHaveBeenLastCalledWith(second.id)
        expect(controller.selectedSkill()).toEqual(second)
        expect(controller.document()?.content).toBe(`# ${second.id}`)
      } finally {
        dispose()
      }
    })
  })

  it('replaces an empty snapshot after discovery and opens only the selected registration', async () => {
    const discoveredSkill = skill({
      id: 'codex:project:review',
      scope: 'project',
      projectPath: '/work/oyster'
    })
    const discovered = { skills: [discoveredSkill], errors: [] }
    const discover = vi.fn<SkillApi['discover']>(async () => discovered)
    const openDiscoveredFolder = vi.fn<SkillApi['openDiscoveredFolder']>(async () => undefined)
    installApi({ discover, openDiscoveredFolder })

    await createRoot(async (dispose) => {
      try {
        const controller = createSkillDiscoveryController()
        await vi.waitFor(() => expect(controller.snapshot()).toEqual(EMPTY_SNAPSHOT))

        await expect(controller.discover()).resolves.toBe(true)
        expect(discover).toHaveBeenCalledOnce()
        expect(controller.snapshot()).toEqual(discovered)
        expect(controller.selectedSkill()).toEqual(discoveredSkill)
        expect(controller.document()?.skillId).toBe(discoveredSkill.id)

        await controller.openFolder(discoveredSkill.id)
        expect(openDiscoveredFolder).toHaveBeenCalledWith(discoveredSkill.id)
        expect(controller.error()).toBeUndefined()
      } finally {
        dispose()
      }
    })
  })

  it('keeps the discovered list visible when one document cannot be read', async () => {
    const visibleSkill = skill()
    installApi({
      getDiscoveryStateView: async () => ({ skills: [visibleSkill], errors: [] }),
      readDiscoveredDocument: async () => { throw new Error('Skill 文档已被移动') }
    })

    await createRoot(async (dispose) => {
      try {
        const controller = createSkillDiscoveryController()
        await vi.waitFor(() => expect(controller.error()).toBe('Skill 文档已被移动'))

        expect(controller.snapshot()?.skills).toEqual([visibleSkill])
        expect(controller.selectedSkill()).toEqual(visibleSkill)
        expect(controller.document()).toBeUndefined()
      } finally {
        dispose()
      }
    })
  })
})

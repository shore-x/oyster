import { createRoot } from 'solid-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KnowledgeApi } from '../src/shared/knowledge'
import { createKnowledgeController } from '../src/renderer/src/knowledge-controller'

vi.mock('solid-js', async () => vi.importActual('solid-js/dist/solid.js'))

function installApi(overrides: Partial<KnowledgeApi> = {}): KnowledgeApi {
  const api: KnowledgeApi = {
    browse: async () => ({
      statements: [
        { title: 'Database', preview: 'A general storage concept.' },
        { title: 'Oyster Database', preview: 'The local knowledge store.' }
      ],
      total: 2
    }),
    read: async (title) => ({ title, content: `${title} body.` }),
    getNeighborhood: async (title) => ({
      centerTitle: title,
      nodes: [{ title, excerpt: `${title} body.`, roles: [] }],
      edges: [],
      groups: [
        { kind: 'incoming', memberTitles: [] },
        { kind: 'outgoing', memberTitles: [] }
      ],
      unresolvedReferences: []
    }),
    clear: async () => ({ deletedStatementCount: 2, deletedContributionCount: 1 }),
    ...overrides
  }
  vi.stubGlobal('window', { oyster: { knowledge: api } })
  return api
}

afterEach(() => vi.unstubAllGlobals())

describe('knowledge controller', () => {
  it('browses compact results and loads the first Statement on demand', async () => {
    const api = installApi()
    const browse = vi.spyOn(api, 'browse')
    const read = vi.spyOn(api, 'read')
    const getNeighborhood = vi.spyOn(api, 'getNeighborhood')

    await createRoot(async (dispose) => {
      try {
        const controller = createKnowledgeController()
        await controller.browse('database')

        expect(browse).toHaveBeenCalledWith({ query: 'database', limit: 100, offset: 0 })
        expect(read).toHaveBeenCalledWith('Database')
        expect(getNeighborhood).toHaveBeenCalledWith('Database')
        expect(controller.selectedTitle()).toBe('Database')
        expect(controller.statement()).toEqual({ title: 'Database', content: 'Database body.' })
        expect(controller.neighborhood()?.centerTitle).toBe('Database')
      } finally {
        dispose()
      }
    })
  })

  it('clears the visible knowledge only after the Store confirms success', async () => {
    const api = installApi()
    const clear = vi.spyOn(api, 'clear')

    await createRoot(async (dispose) => {
      try {
        const controller = createKnowledgeController()
        await controller.browse()
        await expect(controller.clear()).resolves.toBe(true)

        expect(clear).toHaveBeenCalledOnce()
        expect(controller.result()).toEqual({ statements: [], total: 0 })
        expect(controller.statement()).toBeUndefined()
        expect(controller.clearResult()).toEqual({ deletedStatementCount: 2 })
      } finally {
        dispose()
      }
    })
  })
})

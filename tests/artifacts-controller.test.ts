import { createRoot } from 'solid-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactApi, ArtifactSnapshot, CreateArtifactInput } from '../src/shared/artifacts'
import type { FolderBrowserApi } from '../src/shared/folder-browser'
import { createArtifactsController } from '../src/renderer/src/artifacts-controller'

vi.mock('solid-js', async () => vi.importActual('solid-js/dist/solid.js'))

const EMPTY_SNAPSHOT: ArtifactSnapshot = {
  repositoryPath: '/app-data/artifacts',
  artifacts: [],
  invalidDirectories: []
}

function installApi(
  overrides: Partial<ArtifactApi> = {},
  openFolder: FolderBrowserApi['openFolder'] = async () => undefined
): ArtifactApi {
  const api: ArtifactApi = {
    getSnapshot: async () => EMPTY_SNAPSHOT,
    refresh: async () => EMPTY_SNAPSHOT,
    createArtifact: async () => EMPTY_SNAPSHOT,
    openRepository: async () => undefined,
    ...overrides
  }
  vi.stubGlobal('window', { oyster: { artifacts: api, folderBrowser: { openFolder } } })
  return api
}

afterEach(() => vi.unstubAllGlobals())

describe('artifacts controller', () => {
  it('loads the fixed repository and replaces the snapshot after creating an Artifact', async () => {
    const createdSnapshot: ArtifactSnapshot = {
      ...EMPTY_SNAPSHOT,
      artifacts: [{
        directoryName: 'agent-memory-tracking',
        directoryPath: '/app-data/artifacts/agent-memory-tracking',
        attention: '# Attention\n\nTrack agent memory research.',
        modifiedAt: '2026-07-30T09:00:00.000Z'
      }]
    }
    const getSnapshot = vi.fn<ArtifactApi['getSnapshot']>(async () => EMPTY_SNAPSHOT)
    const createArtifact = vi.fn<ArtifactApi['createArtifact']>(async () => createdSnapshot)
    installApi({ getSnapshot, createArtifact })

    await createRoot(async (dispose) => {
      try {
        const controller = createArtifactsController()
        await vi.waitFor(() => expect(controller.snapshot()).toEqual(EMPTY_SNAPSHOT))

        const input: CreateArtifactInput = {
          directoryName: 'agent-memory-tracking',
          attention: '# Attention\n\nTrack agent memory research.'
        }
        await expect(controller.createArtifact(input)).resolves.toBe(true)

        expect(getSnapshot).toHaveBeenCalledOnce()
        expect(createArtifact).toHaveBeenCalledWith(input)
        expect(controller.snapshot()).toEqual(createdSnapshot)
        expect(controller.error()).toBeUndefined()
      } finally {
        dispose()
      }
    })
  })

  it('surfaces an initialization error and allows a later refresh to recover', async () => {
    const getSnapshot = vi.fn<ArtifactApi['getSnapshot']>(async () => {
      throw new Error('Git executable is temporarily unavailable')
    })
    const refresh = vi.fn<ArtifactApi['refresh']>(async () => EMPTY_SNAPSHOT)
    installApi({ getSnapshot, refresh })

    await createRoot(async (dispose) => {
      try {
        const controller = createArtifactsController()
        await vi.waitFor(() => {
          expect(controller.error()).toBe('Git executable is temporarily unavailable')
        })
        expect(controller.snapshot()).toBeUndefined()

        await expect(controller.refresh()).resolves.toBe(true)
        expect(refresh).toHaveBeenCalledOnce()
        expect(controller.snapshot()).toEqual(EMPTY_SNAPSHOT)
        expect(controller.error()).toBeUndefined()
      } finally {
        dispose()
      }
    })
  })

  it('opens an Artifact directory through the generic folder API', async () => {
    const openFolder = vi.fn<FolderBrowserApi['openFolder']>(async () => undefined)
    installApi({}, openFolder)

    await createRoot(async (dispose) => {
      try {
        const controller = createArtifactsController()
        await vi.waitFor(() => expect(controller.snapshot()).toEqual(EMPTY_SNAPSHOT))

        await controller.openFolder('/app-data/artifacts/research', 'research')

        expect(openFolder).toHaveBeenCalledWith('/app-data/artifacts/research')
        expect(controller.error()).toBeUndefined()
      } finally {
        dispose()
      }
    })
  })
})

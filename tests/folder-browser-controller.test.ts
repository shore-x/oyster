import { createRoot } from 'solid-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  FolderBrowserApi,
  FolderFile,
  FolderSnapshot
} from '../src/shared/folder-browser'
import {
  createFolderBrowserController,
  decodeFolderFile,
  resolveFolderFileTargets
} from '../src/renderer/src/folder-browser-controller'

vi.mock('solid-js', async () => vi.importActual('solid-js/dist/solid.js'))

const encoder = new TextEncoder()

function snapshot(): FolderSnapshot {
  return {
    path: '/workspace',
    entries: [{
      name: 'docs',
      path: '/workspace/docs',
      kind: 'directory',
      entries: [
        { name: 'README.md', path: '/workspace/docs/README.md', kind: 'file' },
        { name: 'notes.txt', path: '/workspace/docs/notes.txt', kind: 'file' },
        { name: 'linked.md', path: '/workspace/docs/linked.md', kind: 'symlink' }
      ]
    }]
  }
}

function folderFile(path: string, content: Uint8Array): FolderFile {
  return { path, size: content.byteLength, content }
}

function installApi(overrides: Partial<FolderBrowserApi> = {}): FolderBrowserApi {
  const api: FolderBrowserApi = {
    getDesignDocumentsPath: async () => '/app/resources/design-documents',
    openFolder: async () => undefined,
    browseFolder: async () => snapshot(),
    readFile: async (path) => folderFile(path, encoder.encode(
      path.endsWith('.md') ? '# Design\n\nReadable Markdown.' : 'plain text\n'
    )),
    ...overrides
  }
  vi.stubGlobal('window', { oyster: { folderBrowser: api } })
  return api
}

afterEach(() => vi.unstubAllGlobals())

describe('folder browser controller', () => {
  it('resolves relative Markdown targets from the current document', () => {
    expect(resolveFolderFileTargets(
      '/workspace/docs/current.md',
      '../guides/Intro%20Guide#overview'
    )).toEqual([
      '/workspace/guides/Intro Guide',
      '/workspace/guides/Intro Guide.md'
    ])
    expect(resolveFolderFileTargets(
      'C:\\workspace\\docs\\current.md',
      '..\\guides\\intro#overview'
    )).toEqual([
      'C:\\workspace\\guides\\intro',
      'C:\\workspace\\guides\\intro.md'
    ])
    expect(resolveFolderFileTargets(
      '/workspace/docs/current.md',
      './guide.md#details'
    )).toEqual(['/workspace/docs/guide.md'])
  })

  it('loads the full tree and previews the first regular file as Markdown', async () => {
    const api = installApi()
    const browseFolder = vi.spyOn(api, 'browseFolder')
    const readFile = vi.spyOn(api, 'readFile')

    await createRoot(async (dispose) => {
      try {
        const controller = createFolderBrowserController()
        await controller.load('/workspace')

        expect(browseFolder).toHaveBeenCalledWith('/workspace')
        expect(readFile).toHaveBeenCalledWith('/workspace/docs/README.md')
        expect(controller.snapshot()).toEqual(snapshot())
        expect(controller.selectedPath()).toBe('/workspace/docs/README.md')
        expect(controller.document()).toEqual({
          kind: 'markdown',
          path: '/workspace/docs/README.md',
          size: 28,
          text: '# Design\n\nReadable Markdown.'
        })
        expect(controller.canGoBack()).toBe(false)
        expect(controller.canGoForward()).toBe(false)
      } finally {
        dispose()
      }
    })
  })

  it('previews strict UTF-8 text and preserves back and forward history', async () => {
    installApi()

    await createRoot(async (dispose) => {
      try {
        const controller = createFolderBrowserController()
        await controller.load('/workspace')
        const directory = controller.snapshot()!.entries[0]
        if (directory.kind !== 'directory') throw new Error('fixture directory missing')
        const textFile = directory.entries[1]

        await expect(controller.selectEntry(textFile)).resolves.toBe(true)
        expect(controller.document()).toMatchObject({
          kind: 'text',
          path: '/workspace/docs/notes.txt',
          text: 'plain text\n'
        })
        expect(controller.canGoBack()).toBe(true)
        expect(controller.canGoForward()).toBe(false)

        await expect(controller.goBack()).resolves.toBe(true)
        expect(controller.selectedPath()).toBe('/workspace/docs/README.md')
        expect(controller.canGoBack()).toBe(false)
        expect(controller.canGoForward()).toBe(true)

        await expect(controller.goForward()).resolves.toBe(true)
        expect(controller.selectedPath()).toBe('/workspace/docs/notes.txt')
      } finally {
        dispose()
      }
    })
  })

  it('does not read directories, symbolic links, or other entries', async () => {
    const api = installApi()
    const readFile = vi.spyOn(api, 'readFile')

    await createRoot(async (dispose) => {
      try {
        const controller = createFolderBrowserController()
        await controller.load('/workspace')
        readFile.mockClear()
        const directory = controller.snapshot()!.entries[0]
        if (directory.kind !== 'directory') throw new Error('fixture directory missing')

        await expect(controller.selectEntry(directory)).resolves.toBe(false)
        await expect(controller.selectEntry(directory.entries[2])).resolves.toBe(false)
        await expect(controller.selectEntry({ name: 'socket', path: '/workspace/socket', kind: 'other' })).resolves.toBe(false)

        expect(readFile).not.toHaveBeenCalled()
        expect(controller.selectedPath()).toBe('/workspace/docs/README.md')
      } finally {
        dispose()
      }
    })
  })

  it('marks invalid UTF-8 as unsupported without lossy replacement', async () => {
    const file = folderFile('/workspace/data.bin', new Uint8Array([0xc3, 0x28]))

    expect(decodeFolderFile(file)).toEqual({
      kind: 'unsupported',
      path: '/workspace/data.bin',
      size: 2,
      reason: 'invalid-utf8'
    })
  })

  it('opens an extensionless Markdown target through the .md fallback and records history', async () => {
    const api = installApi({
      readFile: async (path) => {
        if (path === '/workspace/Guide') throw new Error('not found')
        return folderFile(path, encoder.encode(path.endsWith('Guide.md') ? '# Guide' : '# Design'))
      }
    })
    const readFile = vi.spyOn(api, 'readFile')

    await createRoot(async (dispose) => {
      try {
        const controller = createFolderBrowserController()
        await controller.load('/workspace')
        readFile.mockClear()

        await expect(controller.openTarget('../Guide#overview')).resolves.toBe(true)

        expect(readFile).toHaveBeenNthCalledWith(1, '/workspace/Guide')
        expect(readFile).toHaveBeenNthCalledWith(2, '/workspace/Guide.md')
        expect(controller.selectedPath()).toBe('/workspace/Guide.md')
        expect(controller.document()).toMatchObject({ kind: 'markdown', text: '# Guide' })
        expect(controller.canGoBack()).toBe(true)
      } finally {
        dispose()
      }
    })
  })

  it('previews linked text without changing the selected document or navigation history', async () => {
    installApi()

    await createRoot(async (dispose) => {
      try {
        const controller = createFolderBrowserController()
        await controller.load('/workspace')
        const selectedPath = controller.selectedPath()
        const selectedDocument = controller.document()

        await controller.previewTarget('notes.txt#details')

        expect(controller.linkPreview()).toEqual({
          kind: 'ready',
          target: 'notes.txt#details',
          document: {
            kind: 'text',
            path: '/workspace/docs/notes.txt',
            size: 11,
            text: 'plain text\n'
          }
        })
        expect(controller.selectedPath()).toBe(selectedPath)
        expect(controller.document()).toBe(selectedDocument)
        expect(controller.canGoBack()).toBe(false)

        await controller.previewTarget(undefined)
        expect(controller.linkPreview()).toBeUndefined()
      } finally {
        dispose()
      }
    })
  })

  it('reports failed and binary link previews without replacing the current document', async () => {
    installApi({
      readFile: async (path) => {
        if (path.endsWith('README.md')) return folderFile(path, encoder.encode('# Design'))
        if (path.endsWith('data.bin')) return folderFile(path, new Uint8Array([0xc3, 0x28]))
        throw new Error(`missing: ${path}`)
      }
    })

    await createRoot(async (dispose) => {
      try {
        const controller = createFolderBrowserController()
        await controller.load('/workspace')
        const selectedPath = controller.selectedPath()

        await controller.previewTarget('data.bin')
        expect(controller.linkPreview()).toMatchObject({
          kind: 'ready',
          document: { kind: 'unsupported', reason: 'invalid-utf8' }
        })
        expect(controller.selectedPath()).toBe(selectedPath)

        await controller.previewTarget('missing')
        expect(controller.linkPreview()).toMatchObject({
          kind: 'error',
          target: 'missing',
          path: '/workspace/docs/missing'
        })
        expect(controller.selectedPath()).toBe(selectedPath)
        expect(controller.error()).toBeUndefined()
      } finally {
        dispose()
      }
    })
  })
})

import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FolderBrowserService } from '../src/main/folder-browser/folder-browser-service'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'oyster-folder-browser-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )))
})

describe('FolderBrowserService', () => {
  it('recursively lists every entry type in deterministic name order', async () => {
    const root = await temporaryDirectory()
    await Promise.all([
      mkdir(join(root, 'a-directory')),
      writeFile(join(root, '.environment'), 'hidden'),
      writeFile(join(root, 'notes.md'), '# Notes'),
      writeFile(join(root, 'z-source.ts'), 'export {}')
    ])
    await writeFile(join(root, 'a-directory', 'binary.dat'), new Uint8Array([0, 255]))
    await symlink(join(root, 'a-directory'), join(root, 'linked-directory'), 'dir')

    const snapshot = await new FolderBrowserService().browseFolder(root)

    expect(snapshot).toEqual({
      path: resolve(root),
      entries: [
        { name: '.environment', path: join(root, '.environment'), kind: 'file' },
        {
          name: 'a-directory',
          path: join(root, 'a-directory'),
          kind: 'directory',
          entries: [{
            name: 'binary.dat',
            path: join(root, 'a-directory', 'binary.dat'),
            kind: 'file'
          }]
        },
        { name: 'linked-directory', path: join(root, 'linked-directory'), kind: 'symlink' },
        { name: 'notes.md', path: join(root, 'notes.md'), kind: 'file' },
        { name: 'z-source.ts', path: join(root, 'z-source.ts'), kind: 'file' }
      ]
    })
  })

  it('returns uninterpreted bytes and their exact size', async () => {
    const root = await temporaryDirectory()
    const path = join(root, 'payload.bin')
    const expected = new Uint8Array([0, 255, 10, 195, 40])
    await writeFile(path, expected)

    const file = await new FolderBrowserService().readFile(path)

    expect(file.path).toBe(resolve(path))
    expect(file.size).toBe(expected.byteLength)
    expect(file.content).toBeInstanceOf(Uint8Array)
    expect(file.content).toEqual(expected)
  })

  it('keeps filesystem entries outside the regular kinds visible as other', async () => {
    if (process.platform === 'win32') return
    const root = await temporaryDirectory()
    const socketPath = join(root, 'service.socket')
    const server = createServer()
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(socketPath, () => {
        server.off('error', rejectListen)
        resolveListen()
      })
    })

    try {
      const snapshot = await new FolderBrowserService().browseFolder(root)
      expect(snapshot.entries).toContainEqual({
        name: 'service.socket',
        path: socketPath,
        kind: 'other'
      })
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose())
      })
    }
  })

  it('requires absolute input paths', async () => {
    const browser = new FolderBrowserService()

    await expect(browser.browseFolder('relative/folder')).rejects.toThrow(
      'folderPath 必须是绝对路径'
    )
    await expect(browser.readFile('relative/file.md')).rejects.toThrow(
      'filePath 必须是绝对路径'
    )
  })

  it('distinguishes missing paths, non-directories, and non-files', async () => {
    const root = await temporaryDirectory()
    const filePath = join(root, 'document.md')
    await writeFile(filePath, '# Document')
    const browser = new FolderBrowserService()

    await expect(browser.browseFolder(join(root, 'missing'))).rejects.toThrow('Folder 不存在')
    await expect(browser.browseFolder(filePath)).rejects.toThrow('Folder 路径不是目录')
    await expect(browser.readFile(join(root, 'missing.md'))).rejects.toThrow('文件不存在')
    await expect(browser.readFile(root)).rejects.toThrow('路径不是普通文件')
  })
})

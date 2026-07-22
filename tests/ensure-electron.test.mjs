import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectElectronInstallation } from '../scripts/ensure-electron.mjs'

const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('Electron installation check', () => {
  it('reports an npm install where the Electron postinstall did not run', async () => {
    const packageRoot = await mkdtemp(join(tmpdir(), 'oyster-electron-missing-'))
    temporaryDirectories.push(packageRoot)
    expect(await inspectElectronInstallation(packageRoot)).toEqual({ ok: false, reason: 'missing path.txt' })
  })

  it('accepts a downloaded Electron binary', async () => {
    const packageRoot = await mkdtemp(join(tmpdir(), 'oyster-electron-ready-'))
    temporaryDirectories.push(packageRoot)
    const executableEntry = process.platform === 'win32' ? 'electron.exe' : 'electron'
    await mkdir(join(packageRoot, 'dist'), { recursive: true })
    await writeFile(join(packageRoot, 'path.txt'), executableEntry)
    await writeFile(join(packageRoot, 'dist', executableEntry), '')
    expect(await inspectElectronInstallation(packageRoot)).toMatchObject({ ok: true })
  })
})

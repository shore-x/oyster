import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nearestExistingDirectory } from '../src/main/discovery/path-utils'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('nearestExistingDirectory', () => {
  it('keeps the selected agent history directory when it exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oyster-directory-'))
    temporaryDirectories.push(root)
    const historyRoot = join(root, '.claude', 'projects')
    await mkdir(historyRoot, { recursive: true })

    expect(await nearestExistingDirectory(historyRoot, root)).toBe(historyRoot)
  })

  it('uses the closest existing parent for a missing default history directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oyster-directory-'))
    temporaryDirectories.push(root)
    const agentRoot = join(root, '.pi', 'agent')
    await mkdir(agentRoot, { recursive: true })

    expect(await nearestExistingDirectory(join(agentRoot, 'sessions', 'missing'), root)).toBe(agentRoot)
  })
})

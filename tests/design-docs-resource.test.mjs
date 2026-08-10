import { afterEach, describe, expect, it } from 'vitest'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  DESIGN_DOCS_RESOURCE_DIRECTORY,
  prepareDesignDocs
} from '../scripts/prepare-design-docs.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporaryDirectories = []

async function fileSnapshot(path) {
  const details = await stat(path)
  return {
    content: await readFile(path, 'utf8'),
    modifiedAt: details.mtimeMs,
    size: details.size
  }
}

async function treeSnapshot(root) {
  const snapshot = {}

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) snapshot[relative(root, path)] = await fileSnapshot(path)
    }
  }

  await visit(root)
  return snapshot
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => (
    rm(path, { recursive: true, force: true })
  )))
})

describe('design docs build resource', () => {
  it('copies the project design documents without changing their sources', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'oyster-design-docs-'))
    temporaryDirectories.push(temporaryDirectory)
    const outputDirectory = join(temporaryDirectory, DESIGN_DOCS_RESOURCE_DIRECTORY)
    await mkdir(outputDirectory, { recursive: true })
    await writeFile(join(outputDirectory, 'stale.md'), 'stale output\n', 'utf8')

    const sourceBefore = {
      agents: await fileSnapshot(join(projectRoot, 'AGENTS.md')),
      readme: await fileSnapshot(join(projectRoot, 'README.md')),
      docs: await treeSnapshot(join(projectRoot, 'docs'))
    }

    await expect(prepareDesignDocs({
      sourceRoot: projectRoot,
      outputDirectory
    })).resolves.toBe(outputDirectory)

    expect((await readdir(outputDirectory)).sort()).toEqual(['AGENTS.md', 'README.md', 'docs'])
    expect(await readFile(join(outputDirectory, 'AGENTS.md'), 'utf8')).toBe(sourceBefore.agents.content)
    expect(await readFile(join(outputDirectory, 'README.md'), 'utf8')).toBe(sourceBefore.readme.content)

    const copiedDocs = await treeSnapshot(join(outputDirectory, 'docs'))
    expect(Object.fromEntries(
      Object.entries(copiedDocs).map(([path, value]) => [path, value.content])
    )).toEqual(Object.fromEntries(
      Object.entries(sourceBefore.docs).map(([path, value]) => [path, value.content])
    ))

    expect({
      agents: await fileSnapshot(join(projectRoot, 'AGENTS.md')),
      readme: await fileSnapshot(join(projectRoot, 'README.md')),
      docs: await treeSnapshot(join(projectRoot, 'docs'))
    }).toEqual(sourceBefore)
  })
})

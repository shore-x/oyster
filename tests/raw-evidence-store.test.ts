import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  ensureRawEvidenceDirectories,
  FileRawEvidenceStore,
  rawEvidenceSourceDirectoryName
} from '../src/main/discovery/raw-evidence-store'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('FileRawEvidenceStore', () => {
  it('preserves source bytes and format while recording a provenance manifest', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'oyster-raw-evidence-'))
    temporaryDirectories.push(temporaryDirectory)
    const sourcePath = join(temporaryDirectory, 'AGENTS.md')
    const content = Buffer.from('# Instructions\r\n\r\nKeep the source bytes.\n', 'utf8')
    await writeFile(sourcePath, content)

    const storeRoot = join(temporaryDirectory, 'store')
    const receipt = await new FileRawEvidenceStore(storeRoot).importFile({
      sourceId: 'source:codex',
      artifactId: 'artifact-one',
      artifactKind: 'human_instruction',
      absolutePath: sourcePath,
      fingerprint: 'fingerprint-one',
      signal: new AbortController().signal,
      onProgress: () => undefined
    })

    const evidencePath = join(storeRoot, receipt.id)
    expect(receipt.id.startsWith('codex/')).toBe(true)
    expect(await readFile(join(evidencePath, 'payload.md'))).toEqual(content)
    expect(receipt).toMatchObject({
      contentHash: createHash('sha256').update(content).digest('hex'),
      sizeBytes: content.length
    })
    expect(JSON.parse(await readFile(join(evidencePath, 'manifest.json'), 'utf8'))).toMatchObject({
      schemaVersion: 1,
      evidenceId: receipt.id,
      sourceId: 'source:codex',
      artifactId: 'artifact-one',
      artifactKind: 'human_instruction',
      originalPath: sourcePath,
      originalFileName: 'AGENTS.md',
      storedFileName: 'payload.md',
      contentHash: receipt.contentHash,
      sizeBytes: content.length,
      fingerprint: 'fingerprint-one'
    })
  })

  it('uses portable agent folders and migrates the previous macOS layout', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'oyster-raw-layout-'))
    temporaryDirectories.push(temporaryDirectory)
    const storeRoot = join(temporaryDirectory, 'store')
    expect(rawEvidenceSourceDirectoryName('source:claude')).toBe('claude')
    expect(rawEvidenceSourceDirectoryName('source:pi')).toBe('pi')

    if (process.platform !== 'win32') {
      await mkdir(join(storeRoot, 'source:claude'), { recursive: true })
      await writeFile(join(storeRoot, 'source:claude', 'legacy.txt'), 'legacy evidence')
    }
    await ensureRawEvidenceDirectories(storeRoot, ['source:claude', 'source:pi'])

    if (process.platform !== 'win32') {
      expect(await readFile(join(storeRoot, 'claude', 'legacy.txt'), 'utf8')).toBe('legacy evidence')
      await expect(readFile(join(storeRoot, 'source:claude', 'legacy.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    expect((await stat(join(storeRoot, 'pi'))).isDirectory()).toBe(true)
  })
})

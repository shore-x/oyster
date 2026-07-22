import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { FileRawEvidenceStore } from '../src/main/discovery/raw-evidence-store'

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
})

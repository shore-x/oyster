import { createHash } from 'node:crypto'
import { mkdtemp, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FileSourceEvidenceReader,
  MAX_SOURCE_EVIDENCE_READ_BYTES,
  MemorySourceEvidenceReader
} from '../src/main/discovery/source-evidence-reader'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

describe('FileSourceEvidenceReader', () => {
  it('reads and hashes one exact source-file revision without creating a managed copy', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'oyster-source-evidence-'))
    temporaryDirectories.push(temporaryDirectory)
    const sourcePath = join(temporaryDirectory, 'session.jsonl')
    const content = Buffer.from('{"sessionId":"one"}\r\n{"role":"user","content":"hello"}\n', 'utf8')
    await writeFile(sourcePath, content)
    const metadata = await stat(sourcePath)

    const evidence = await new FileSourceEvidenceReader().read({
      artifactId: 'artifact-one',
      absolutePath: sourcePath,
      expectedSizeBytes: metadata.size,
      expectedModifiedAt: metadata.mtime.toISOString(),
      maxBytes: metadata.size
    })

    expect(evidence).toEqual({
      content,
      contentHash: sha256(content),
      sizeBytes: content.length
    })
    expect(await stat(sourcePath)).toMatchObject({ size: content.length })
  })

  it('rejects changed, deleted, symbolic-link, oversized, and invalid-limit sources', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'oyster-source-revision-'))
    temporaryDirectories.push(temporaryDirectory)
    const sourcePath = join(temporaryDirectory, 'session.jsonl')
    const linkPath = join(temporaryDirectory, 'session-link.jsonl')
    const content = Buffer.from('{"sessionId":"one"}\n', 'utf8')
    await writeFile(sourcePath, content)
    const metadata = await stat(sourcePath)
    const reader = new FileSourceEvidenceReader()
    const input = {
      artifactId: 'artifact-one',
      absolutePath: sourcePath,
      expectedSizeBytes: metadata.size,
      expectedModifiedAt: metadata.mtime.toISOString(),
      maxBytes: metadata.size
    }

    await expect(reader.read({ ...input, maxBytes: metadata.size - 1 }))
      .rejects.toThrow('read limit')
    await expect(reader.read({ ...input, maxBytes: MAX_SOURCE_EVIDENCE_READ_BYTES + 1 }))
      .rejects.toThrow('read limit must be between')

    await writeFile(sourcePath, Buffer.from('{"sessionId":"two"}\n', 'utf8'))
    await utimes(sourcePath, metadata.atime, new Date(metadata.mtimeMs + 2_000))
    await expect(reader.read(input)).rejects.toThrow('revision has changed')

    const changedMetadata = await stat(sourcePath)
    await symlink(sourcePath, linkPath)
    await expect(reader.read({
      ...input,
      absolutePath: linkPath,
      expectedSizeBytes: changedMetadata.size,
      expectedModifiedAt: changedMetadata.mtime.toISOString()
    })).rejects.toThrow('not a readable regular file')

    await unlink(sourcePath)
    await expect(reader.read(input)).rejects.toThrow('no longer available')
  })
})

describe('MemorySourceEvidenceReader', () => {
  it('provides the same bounded read contract for deterministic fixtures', async () => {
    const content = Buffer.from('{"sessionId":"fixture"}\n', 'utf8')
    const reader = new MemorySourceEvidenceReader([{ artifactId: 'artifact-fixture', content }])
    const input = {
      artifactId: 'artifact-fixture',
      absolutePath: '/not-used-by-memory-reader.jsonl',
      expectedSizeBytes: content.length,
      expectedModifiedAt: '2026-07-26T00:00:00.000Z',
      maxBytes: content.length
    }

    await expect(reader.read(input)).resolves.toEqual({
      content,
      contentHash: sha256(content),
      sizeBytes: content.length
    })
    await expect(reader.read({ ...input, expectedSizeBytes: content.length + 1 }))
      .rejects.toThrow('revision has changed')
    await expect(reader.read({ ...input, maxBytes: content.length - 1 }))
      .rejects.toThrow('read limit')
    await expect(reader.read({ ...input, artifactId: 'missing' }))
      .rejects.toThrow('no longer available')
  })
})

import { createHash } from 'node:crypto'
import { mkdtemp, open, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FileSourceEvidenceReader,
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
  it('reads and hashes the current source-file bytes without creating a managed copy', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'oyster-source-evidence-'))
    temporaryDirectories.push(temporaryDirectory)
    const sourcePath = join(temporaryDirectory, 'session.jsonl')
    const content = Buffer.from('{"sessionId":"one"}\r\n{"role":"user","content":"hello"}\n', 'utf8')
    await writeFile(sourcePath, content)
    const metadata = await stat(sourcePath)

    const evidence = await new FileSourceEvidenceReader().read({
      sourceConversationId: 'record-one',
      absolutePath: sourcePath,
      expectedSizeBytes: metadata.size,
      expectedModifiedAt: metadata.mtime.toISOString()
    })

    expect(evidence).toEqual({
      content,
      contentHash: sha256(content),
      sizeBytes: content.length
    })
    expect(await stat(sourcePath)).toMatchObject({ size: content.length })
  })

  it('does not impose the former 16 MiB product limit', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'oyster-source-large-evidence-'))
    temporaryDirectories.push(temporaryDirectory)
    const sourcePath = join(temporaryDirectory, 'large-session.jsonl')
    const content = Buffer.alloc(16 * 1024 * 1024 + 1, 0x61)
    await writeFile(sourcePath, content)
    const metadata = await stat(sourcePath)

    const evidence = await new FileSourceEvidenceReader().read({
      sourceConversationId: 'record-large',
      absolutePath: sourcePath,
      expectedSizeBytes: metadata.size,
      expectedModifiedAt: metadata.mtime.toISOString()
    })
    expect(evidence.sizeBytes).toBe(content.length)
    expect(evidence.contentHash).toBe(sha256(content))
    expect(evidence.content.equals(content)).toBe(true)
  })

  it('rejects a same-inode rewrite after reading starts and before it finishes', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'oyster-source-torn-read-'))
    temporaryDirectories.push(temporaryDirectory)
    const sourcePath = join(temporaryDirectory, 'session.jsonl')
    const original = Buffer.from('{"sessionId":"one"}\n', 'utf8')
    const replacement = Buffer.from('{"sessionId":"two"}\n', 'utf8')
    await writeFile(sourcePath, original)
    const metadata = await stat(sourcePath)

    const probe = await open(sourcePath, 'r')
    const prototype = Object.getPrototypeOf(probe) as {
      read: (...args: unknown[]) => Promise<{ bytesRead: number; buffer: Buffer }>
    }
    const originalRead = prototype.read
    await probe.close()
    let intercepted = false
    prototype.read = async function (...args: unknown[]) {
      const result = await originalRead.apply(this, args)
      if (!intercepted) {
        intercepted = true
        await writeFile(sourcePath, replacement)
        await utimes(sourcePath, metadata.atime, new Date(metadata.mtimeMs + 2_000))
      }
      return result
    }

    try {
      await expect(new FileSourceEvidenceReader().read({
        sourceConversationId: 'record-one',
        absolutePath: sourcePath,
        expectedSizeBytes: metadata.size,
        expectedModifiedAt: metadata.mtime.toISOString()
      })).rejects.toThrow('changed while it was being read')
      expect(intercepted).toBe(true)
    } finally {
      prototype.read = originalRead
    }
  })

  it('rejects sources that change during a read, are deleted, symbolic links, caller-bounded, or invalid-limit', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'oyster-source-revision-'))
    temporaryDirectories.push(temporaryDirectory)
    const sourcePath = join(temporaryDirectory, 'session.jsonl')
    const linkPath = join(temporaryDirectory, 'session-link.jsonl')
    const content = Buffer.from('{"sessionId":"one"}\n', 'utf8')
    await writeFile(sourcePath, content)
    const metadata = await stat(sourcePath)
    const reader = new FileSourceEvidenceReader()
    const input = {
      sourceConversationId: 'record-one',
      absolutePath: sourcePath,
      expectedSizeBytes: metadata.size,
      expectedModifiedAt: metadata.mtime.toISOString(),
      maxBytes: metadata.size
    }

    await expect(reader.read({ ...input, maxBytes: metadata.size - 1 }))
      .rejects.toThrow('read limit')
    await expect(reader.read({ ...input, maxBytes: Number.MAX_SAFE_INTEGER + 1 }))
      .rejects.toThrow('positive safe integer')

    await writeFile(sourcePath, Buffer.from('{"sessionId":"two"}\n', 'utf8'))
    await utimes(sourcePath, metadata.atime, new Date(metadata.mtimeMs + 2_000))
    await expect(reader.read(input)).rejects.toThrow('changed while it was being read')

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
  it('provides the same optional caller-owned read bound for deterministic fixtures', async () => {
    const content = Buffer.from('{"sessionId":"fixture"}\n', 'utf8')
    const reader = new MemorySourceEvidenceReader([{ sourceConversationId: 'record-fixture', content }])
    const input = {
      sourceConversationId: 'record-fixture',
      absolutePath: '/not-used-by-memory-reader.jsonl',
      expectedSizeBytes: content.length,
      expectedModifiedAt: '2026-07-26T00:00:00.000Z'
    }

    await expect(reader.read(input)).resolves.toEqual({
      content,
      contentHash: sha256(content),
      sizeBytes: content.length
    })
    await expect(reader.read({ ...input, expectedSizeBytes: content.length + 1 }))
      .rejects.toThrow('changed while it was being read')
    await expect(reader.read({ ...input, maxBytes: content.length - 1 }))
      .rejects.toThrow('read limit')
    await expect(reader.read({ ...input, sourceConversationId: 'missing' }))
      .rejects.toThrow('no longer available')
  })
})

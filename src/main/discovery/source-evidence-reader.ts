import { createHash } from 'node:crypto'
import { lstat, open } from 'node:fs/promises'

export const MAX_SOURCE_EVIDENCE_READ_BYTES = 16 * 1024 * 1024

export interface SourceEvidenceReadInput {
  artifactId: string
  absolutePath: string
  expectedSizeBytes: number
  expectedModifiedAt: string
  maxBytes: number
}

export interface SourceEvidenceReadResult {
  content: Buffer
  contentHash: string
  sizeBytes: number
}

export interface SourceEvidenceReader {
  read(input: SourceEvidenceReadInput): Promise<SourceEvidenceReadResult>
}

function assertReadLimit(maxBytes: number): void {
  if (
    !Number.isSafeInteger(maxBytes)
    || maxBytes <= 0
    || maxBytes > MAX_SOURCE_EVIDENCE_READ_BYTES
  ) {
    throw new Error(
      `Source Evidence read limit must be between 1 and ${MAX_SOURCE_EVIDENCE_READ_BYTES} bytes`
    )
  }
}

function matchesExpectedRevision(
  metadata: { size: number; mtime: Date },
  input: SourceEvidenceReadInput
): boolean {
  return metadata.size === input.expectedSizeBytes
    && metadata.mtime.toISOString() === input.expectedModifiedAt
}

function sourceAccessError(error: unknown): Error | undefined {
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new Error('The source Session is no longer available')
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new Error('The source Session is no longer readable')
  }
  return undefined
}

/** Reads one selected source file without copying it into application-managed storage. */
export class FileSourceEvidenceReader implements SourceEvidenceReader {
  async read(input: SourceEvidenceReadInput): Promise<SourceEvidenceReadResult> {
    assertReadLimit(input.maxBytes)
    let pathMetadata
    try {
      pathMetadata = await lstat(input.absolutePath)
    } catch (error) {
      throw sourceAccessError(error) ?? error
    }
    if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) {
      throw new Error('The source Session is not a readable regular file')
    }
    if (!matchesExpectedRevision(pathMetadata, input)) {
      throw new Error('The source Session revision has changed')
    }
    if (pathMetadata.size > input.maxBytes) {
      throw new Error(`Source Evidence exceeds the ${input.maxBytes} byte read limit`)
    }

    const handle = await open(input.absolutePath, 'r').catch((error: unknown) => {
      throw sourceAccessError(error) ?? error
    })
    try {
      const before = await handle.stat()
      if (
        !before.isFile()
        || before.dev !== pathMetadata.dev
        || before.ino !== pathMetadata.ino
        || !matchesExpectedRevision(before, input)
      ) {
        throw new Error('The source Session revision changed before it could be read')
      }

      const content = Buffer.alloc(before.size)
      let offset = 0
      while (offset < content.length) {
        const { bytesRead } = await handle.read(content, offset, content.length - offset, offset)
        if (bytesRead === 0) throw new Error('The source Session changed while it was being read')
        offset += bytesRead
      }

      const after = await handle.stat()
      if (
        after.dev !== before.dev
        || after.ino !== before.ino
        || after.size !== before.size
        || after.mtimeMs !== before.mtimeMs
      ) {
        throw new Error('The source Session changed while it was being read')
      }
      return {
        content,
        contentHash: createHash('sha256').update(content).digest('hex'),
        sizeBytes: content.length
      }
    } finally {
      await handle.close()
    }
  }
}

/** In-memory source used only by deterministic app fixtures and unit tests. */
export class MemorySourceEvidenceReader implements SourceEvidenceReader {
  private readonly records = new Map<string, Buffer>()

  constructor(seeds: Array<{ artifactId: string; content: string | Buffer }> = []) {
    for (const seed of seeds) {
      this.records.set(
        seed.artifactId,
        typeof seed.content === 'string' ? Buffer.from(seed.content, 'utf8') : Buffer.from(seed.content)
      )
    }
  }

  async read(input: SourceEvidenceReadInput): Promise<SourceEvidenceReadResult> {
    assertReadLimit(input.maxBytes)
    const stored = this.records.get(input.artifactId)
    if (!stored) throw new Error('The source Session is no longer available')
    if (stored.length !== input.expectedSizeBytes) {
      throw new Error('The source Session revision has changed')
    }
    if (stored.length > input.maxBytes) {
      throw new Error(`Source Evidence exceeds the ${input.maxBytes} byte read limit`)
    }
    const content = Buffer.from(stored)
    return {
      content,
      contentHash: createHash('sha256').update(content).digest('hex'),
      sizeBytes: content.length
    }
  }
}

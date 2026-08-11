import { createHash } from 'node:crypto'
import { lstat, open } from 'node:fs/promises'

export interface SourceEvidenceRevisionInput {
  sourceConversationId: string
  absolutePath: string
  expectedSizeBytes: number
  expectedModifiedAt: string
}

export interface SourceEvidenceReadInput extends SourceEvidenceRevisionInput {
  /** Optional caller-owned bound for uses that intentionally require a bounded read. */
  maxBytes?: number
}

export interface SourceEvidenceReadResult {
  content: Buffer
  contentHash: string
  sizeBytes: number
}

export interface SourceEvidenceReader {
  read(input: SourceEvidenceReadInput): Promise<SourceEvidenceReadResult>
}

export class SourceConversationUnavailableError extends Error {
  constructor(message = 'The source conversation is no longer available') {
    super(message)
    this.name = 'SourceConversationUnavailableError'
  }
}

export class SourceConversationUnreadableError extends Error {
  constructor(message = 'The source conversation is no longer readable') {
    super(message)
    this.name = 'SourceConversationUnreadableError'
  }
}

export class SourceConversationRevisionChangedError extends Error {
  constructor(message = 'The source conversation revision has changed') {
    super(message)
    this.name = 'SourceConversationRevisionChangedError'
  }
}

function assertReadLimit(maxBytes: number | undefined): void {
  if (maxBytes === undefined) return
  if (
    !Number.isSafeInteger(maxBytes)
    || maxBytes <= 0
  ) {
    throw new Error('Source Evidence read limit must be a positive safe integer')
  }
}

function matchesExpectedRevision(
  metadata: { size: number; mtime: Date },
  input: SourceEvidenceRevisionInput
): boolean {
  return metadata.size === input.expectedSizeBytes
    && metadata.mtime.toISOString() === input.expectedModifiedAt
}

function sourceAccessError(error: unknown): Error | undefined {
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new SourceConversationUnavailableError()
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new SourceConversationUnreadableError()
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
      throw new Error('The source conversation is not a readable regular file')
    }
    if (!matchesExpectedRevision(pathMetadata, input)) {
      throw new SourceConversationRevisionChangedError()
    }
    if (input.maxBytes !== undefined && pathMetadata.size > input.maxBytes) {
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
        throw new SourceConversationRevisionChangedError(
          'The source conversation revision changed before it could be read'
        )
      }

      const content = Buffer.alloc(before.size)
      let offset = 0
      while (offset < content.length) {
        const { bytesRead } = await handle.read(content, offset, content.length - offset, offset)
        if (bytesRead === 0) {
          throw new SourceConversationRevisionChangedError(
            'The source conversation changed while it was being read'
          )
        }
        offset += bytesRead
      }

      const after = await handle.stat()
      if (
        after.dev !== before.dev
        || after.ino !== before.ino
        || after.size !== before.size
        || after.mtimeMs !== before.mtimeMs
      ) {
        throw new SourceConversationRevisionChangedError(
          'The source conversation changed while it was being read'
        )
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

  constructor(seeds: Array<{ sourceConversationId: string; content: string | Buffer }> = []) {
    for (const seed of seeds) {
      this.records.set(
        seed.sourceConversationId,
        typeof seed.content === 'string' ? Buffer.from(seed.content, 'utf8') : Buffer.from(seed.content)
      )
    }
  }

  async read(input: SourceEvidenceReadInput): Promise<SourceEvidenceReadResult> {
    assertReadLimit(input.maxBytes)
    const stored = this.records.get(input.sourceConversationId)
    if (!stored) throw new SourceConversationUnavailableError()
    if (stored.length !== input.expectedSizeBytes) {
      throw new SourceConversationRevisionChangedError()
    }
    if (input.maxBytes !== undefined && stored.length > input.maxBytes) {
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

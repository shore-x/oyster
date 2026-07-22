import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, stat } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { RawEvidenceInput, RawEvidenceStore } from './model'

export class FileRawEvidenceStore implements RawEvidenceStore {
  constructor(private readonly rootPath: string) {}

  async importFile(input: RawEvidenceInput): Promise<string> {
    const sessionKey = createHash('sha256').update(input.sessionId).digest('hex').slice(0, 24)
    const evidenceId = randomUUID()
    const destination = join(this.rootPath, input.sourceId, sessionKey, `${evidenceId}.jsonl`)
    const temporary = `${destination}.tmp`
    await mkdir(dirname(destination), { recursive: true })

    const progress = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        input.onProgress(chunk.length)
        callback(null, chunk)
      }
    })

    try {
      await pipeline(createReadStream(input.absolutePath), progress, createWriteStream(temporary, { flags: 'wx' }), {
        signal: input.signal
      })
      await rename(temporary, destination)
      return `${input.sourceId}/${sessionKey}/${evidenceId}.jsonl`
    } catch (error) {
      const { rm } = await import('node:fs/promises')
      await rm(temporary, { force: true })
      throw error
    }
  }
}
export class MemoryRawEvidenceStore implements RawEvidenceStore {
  readonly records = new Map<string, Buffer>()

  async importFile(input: RawEvidenceInput): Promise<string> {
    input.signal.throwIfAborted()
    const content = await readFile(input.absolutePath)
    input.signal.throwIfAborted()
    input.onProgress((await stat(input.absolutePath)).size)
    const evidenceId = `${input.sourceId}/${randomUUID()}.jsonl`
    this.records.set(evidenceId, content)
    return evidenceId
  }
}

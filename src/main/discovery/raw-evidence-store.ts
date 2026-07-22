import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { basename, extname, join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { RawEvidenceInput, RawEvidenceReceipt, RawEvidenceStore } from './model'

interface RawEvidenceManifest {
  schemaVersion: 1
  evidenceId: string
  sourceId: string
  artifactId: string
  artifactKind: RawEvidenceInput['artifactKind']
  originalPath: string
  originalFileName: string
  storedFileName: string
  contentHash: string
  sizeBytes: number
  fingerprint: string
  importedAt: string
}

function safeExtension(filePath: string): string {
  const extension = extname(filePath)
  return /^\.[a-z0-9]{1,12}$/i.test(extension) ? extension : ''
}

export class FileRawEvidenceStore implements RawEvidenceStore {
  constructor(private readonly rootPath: string) {}

  async importFile(input: RawEvidenceInput): Promise<RawEvidenceReceipt> {
    const artifactKey = createHash('sha256').update(input.artifactId).digest('hex').slice(0, 24)
    const evidenceId = randomUUID()
    const evidencePath = join(this.rootPath, input.sourceId, artifactKey, evidenceId)
    const storedFileName = `payload${safeExtension(input.absolutePath)}`
    const destination = join(evidencePath, storedFileName)
    const manifestPath = join(evidencePath, 'manifest.json')
    const temporaryPayload = `${destination}.tmp`
    const temporaryManifest = `${manifestPath}.tmp`
    await mkdir(evidencePath, { recursive: true })

    const contentHash = createHash('sha256')
    let sizeBytes = 0

    const progress = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        contentHash.update(chunk)
        sizeBytes += chunk.length
        input.onProgress(chunk.length)
        callback(null, chunk)
      }
    })

    try {
      await pipeline(
        createReadStream(input.absolutePath),
        progress,
        createWriteStream(temporaryPayload, { flags: 'wx' }),
        { signal: input.signal }
      )
      const receipt: RawEvidenceReceipt = {
        id: `${input.sourceId}/${artifactKey}/${evidenceId}`,
        contentHash: contentHash.digest('hex'),
        sizeBytes
      }
      const manifest: RawEvidenceManifest = {
        schemaVersion: 1,
        evidenceId: receipt.id,
        sourceId: input.sourceId,
        artifactId: input.artifactId,
        artifactKind: input.artifactKind,
        originalPath: input.absolutePath,
        originalFileName: basename(input.absolutePath),
        storedFileName,
        contentHash: receipt.contentHash,
        sizeBytes,
        fingerprint: input.fingerprint,
        importedAt: new Date().toISOString()
      }
      await writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
      await rename(temporaryPayload, destination)
      await rename(temporaryManifest, manifestPath)
      return receipt
    } catch (error) {
      await rm(evidencePath, { recursive: true, force: true })
      throw error
    }
  }
}
export class MemoryRawEvidenceStore implements RawEvidenceStore {
  readonly records = new Map<string, Buffer>()

  async importFile(input: RawEvidenceInput): Promise<RawEvidenceReceipt> {
    input.signal.throwIfAborted()
    const content = await readFile(input.absolutePath)
    input.signal.throwIfAborted()
    const sizeBytes = (await stat(input.absolutePath)).size
    input.onProgress(sizeBytes)
    const evidenceId = `${input.sourceId}/${randomUUID()}`
    this.records.set(evidenceId, content)
    return {
      id: evidenceId,
      contentHash: createHash('sha256').update(content).digest('hex'),
      sizeBytes
    }
  }
}

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AgentSource, DiscoveryScan, SourceRecord } from '../../shared/discovery'
import type { DiscoveryStateData, DiscoveryRepository } from './model'

const EMPTY_STATE: DiscoveryStateData = { sources: [], records: [], scans: [] }

type StoredSourceRecord = Omit<SourceRecord, 'kind'> & {
  kind?: SourceRecord['kind']
  /** Legacy metadata hash that was once exposed as a source revision. */
  fingerprint?: string
  syncState?: string
  rawEvidenceId?: string
  rawContentHash?: string
  syncedFingerprint?: string
}
type StoredAgentSource = AgentSource & {
  syncedBytes?: number
  syncedConversationCount?: number
  /** Legacy name used before Source Conversation became the product term. */
  syncedSessionCount?: number
  syncedInstructionFileCount?: number
  lastSyncedAt?: string
}
type StoredDiscoveryScan = Omit<DiscoveryScan, 'scanId' | 'status'> & {
  scanId?: string
  status?: DiscoveryScan['status']
  id?: string
  state?: 'queued' | 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted'
  kind?: 'scan' | 'import'
}
type StoredDiscoveryState = {
  sources?: StoredAgentSource[]
  records?: StoredSourceRecord[]
  artifacts?: StoredSourceRecord[]
  conversations?: StoredSourceRecord[]
  /** Legacy pre-Source-Conversation catalog field. */
  sessions?: StoredSourceRecord[]
  scans?: StoredDiscoveryScan[]
  /** Legacy pre-terminology migration field. */
  runs?: StoredDiscoveryScan[]
}

function currentSource(value: StoredAgentSource): AgentSource {
  const copy = { ...value } as Record<string, unknown>
  delete copy.syncedBytes
  delete copy.syncedConversationCount
  delete copy.syncedSessionCount
  delete copy.syncedInstructionFileCount
  delete copy.lastSyncedAt
  return copy as unknown as AgentSource
}

function currentRecord(value: StoredSourceRecord): SourceRecord {
  const copy = { ...value, kind: value.kind ?? 'conversation' } as Record<string, unknown>
  delete copy.syncState
  delete copy.rawEvidenceId
  delete copy.rawContentHash
  delete copy.syncedFingerprint
  delete copy.fingerprint
  delete copy.errorMessage
  return copy as unknown as SourceRecord
}

function currentScan(value: StoredDiscoveryScan): DiscoveryScan | undefined {
  if (value.kind === 'import') return undefined
  const copy = { ...value } as Record<string, unknown>
  copy.scanId = value.scanId ?? value.id
  copy.status = value.status ?? (value.state === 'running' ? 'in_progress' : value.state)
  delete copy.id
  delete copy.state
  delete copy.kind
  return copy as unknown as DiscoveryScan
}

function cloneState(state: DiscoveryStateData): DiscoveryStateData {
  return structuredClone(state)
}

export class JsonDiscoveryRepository implements DiscoveryRepository {
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  async load(): Promise<DiscoveryStateData> {
    try {
      const value = JSON.parse(await readFile(this.filePath, 'utf8')) as StoredDiscoveryState
      const storedRecords = value.records
        ?? value.artifacts
        ?? value.conversations
        ?? value.sessions
        ?? []
      return {
        sources: (value.sources ?? []).map(currentSource),
        records: storedRecords.map(currentRecord),
        scans: (value.scans ?? value.runs ?? [])
          .map(currentScan)
          .filter((scan): scan is DiscoveryScan => Boolean(scan))
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return cloneState(EMPTY_STATE)
      throw error
    }
  }

  async save(state: DiscoveryStateData): Promise<void> {
    const snapshot = cloneState(state)
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      const temporaryPath = `${this.filePath}.tmp`
      await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
      await rename(temporaryPath, this.filePath)
    })
    return this.writeQueue
  }
}
export class InMemoryDiscoveryRepository implements DiscoveryRepository {
  private state: DiscoveryStateData

  constructor(initialState: DiscoveryStateData = EMPTY_STATE) {
    this.state = cloneState(initialState)
  }

  async load(): Promise<DiscoveryStateData> {
    return cloneState(this.state)
  }

  async save(state: DiscoveryStateData): Promise<void> {
    this.state = cloneState(state)
  }
}

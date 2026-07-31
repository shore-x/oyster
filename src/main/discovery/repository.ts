import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AgentSource, ScanRun, SourceRecord } from '../../shared/discovery'
import type { DiscoveryStateData, DiscoveryRepository } from './model'

const EMPTY_STATE: DiscoveryStateData = { sources: [], records: [], runs: [] }

type StoredSourceRecord = Omit<SourceRecord, 'kind'> & {
  kind?: SourceRecord['kind']
  syncState?: string
  rawEvidenceId?: string
  rawContentHash?: string
  syncedFingerprint?: string
}
type StoredAgentSource = AgentSource & {
  syncedBytes?: number
  syncedSessionCount?: number
  syncedInstructionFileCount?: number
  lastSyncedAt?: string
}
type StoredDiscoveryState = {
  sources?: StoredAgentSource[]
  records?: StoredSourceRecord[]
  artifacts?: StoredSourceRecord[]
  sessions?: StoredSourceRecord[]
  runs?: Array<ScanRun & { kind?: 'scan' | 'import' }>
}

function currentSource(value: StoredAgentSource): AgentSource {
  const copy = { ...value } as Record<string, unknown>
  delete copy.syncedBytes
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
  delete copy.errorMessage
  return copy as unknown as SourceRecord
}

function currentRun(value: ScanRun & { kind?: 'scan' | 'import' }): ScanRun | undefined {
  if (value.kind === 'import') return undefined
  const copy = { ...value } as Record<string, unknown>
  delete copy.kind
  return copy as unknown as ScanRun
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
      const storedRecords = value.records ?? value.artifacts ?? value.sessions ?? []
      return {
        sources: (value.sources ?? []).map(currentSource),
        records: storedRecords.map(currentRecord),
        runs: (value.runs ?? []).map(currentRun).filter((run): run is ScanRun => Boolean(run))
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

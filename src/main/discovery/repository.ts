import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DiscoveryStateData, DiscoveryRepository } from './model'

const EMPTY_STATE: DiscoveryStateData = { sources: [], sessions: [], runs: [] }

function cloneState(state: DiscoveryStateData): DiscoveryStateData {
  return structuredClone(state)
}

export class JsonDiscoveryRepository implements DiscoveryRepository {
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  async load(): Promise<DiscoveryStateData> {
    try {
      const value = JSON.parse(await readFile(this.filePath, 'utf8')) as DiscoveryStateData
      return {
        sources: value.sources ?? [],
        sessions: value.sessions ?? [],
        runs: value.runs ?? []
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

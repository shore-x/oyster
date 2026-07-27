import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AiBackendRepository, AiBackendStateData } from './model'

const EMPTY_STATE: AiBackendStateData = { connections: [] }

function cloneState(state: AiBackendStateData): AiBackendStateData {
  return structuredClone(state)
}

function isStoredConnection(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return record.adapterId === 'openai-compatible'
    && typeof record.id === 'string'
    && (record.providerId === 'openai' || record.providerId === 'openai_compatible')
    && (record.protocol === 'openai_responses' || record.protocol === 'openai_chat_completions')
    && typeof record.baseUrl === 'string'
    && typeof record.model === 'string'
    && (record.credentialRef === undefined || typeof record.credentialRef === 'string')
}

export class JsonAiBackendRepository implements AiBackendRepository {
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  async load(): Promise<AiBackendStateData> {
    try {
      const value = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown
      if (!value || typeof value !== 'object' || !Array.isArray((value as Record<string, unknown>).connections)) {
        throw new Error('AI Connection 配置缺少 connections 数组')
      }
      const rawConnections = (value as Record<string, unknown>).connections as unknown[]
      const invalidIndex = rawConnections.findIndex((connection) => !isStoredConnection(connection))
      if (invalidIndex >= 0) throw new Error(`AI Connection 配置中的第 ${invalidIndex + 1} 条记录无效`)
      const connections = rawConnections as AiBackendStateData['connections']
      if (new Set(connections.map((connection) => connection.id)).size !== connections.length) {
        throw new Error('AI Connection 配置包含重复 ID')
      }
      return cloneState({ connections })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return cloneState(EMPTY_STATE)
      throw error
    }
  }

  async save(state: AiBackendStateData): Promise<void> {
    const snapshot = cloneState(state)
    const write = async (): Promise<void> => {
      await mkdir(dirname(this.filePath), { recursive: true })
      const temporaryPath = `${this.filePath}.tmp`
      await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
      await rename(temporaryPath, this.filePath)
    }
    this.writeQueue = this.writeQueue.then(write, write)
    return this.writeQueue
  }
}

export class InMemoryAiBackendRepository implements AiBackendRepository {
  private state: AiBackendStateData

  constructor(initialState: AiBackendStateData = EMPTY_STATE) {
    this.state = cloneState(initialState)
  }

  async load(): Promise<AiBackendStateData> {
    return cloneState(this.state)
  }

  async save(state: AiBackendStateData): Promise<void> {
    this.state = cloneState(state)
  }
}

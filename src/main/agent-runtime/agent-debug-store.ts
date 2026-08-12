import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { AgentInvocationDebugRecord } from '../../shared/agent-runtime'
import { AGENT_INVOCATION_FORMAT_VERSION } from '../../shared/agent-runtime'
import { parseAgentInvocationDebugRecord } from './agent-invocation-record'

const MAX_INVOCATION_ID_LENGTH = 256

function normalizedInvocationId(value: string): string {
  const id = value.trim()
  if (!id || id.length > MAX_INVOCATION_ID_LENGTH || !/^[a-zA-Z0-9:_-]+$/.test(id)) {
    throw new Error('Agent Invocation ID 格式无效')
  }
  return id
}

export interface AgentDebugStore {
  save(record: AgentInvocationDebugRecord): void
  read(invocationId: string): AgentInvocationDebugRecord | undefined
}

/**
 * One atomic JSON file per Invocation. The format is intentionally local and
 * boring: no exporter, sampling, database, or telemetry dependency.
 */
export class FileAgentDebugStore implements AgentDebugStore {
  readonly rootPath: string

  constructor(rootPath: string) {
    this.rootPath = resolve(rootPath)
    mkdirSync(this.rootPath, { recursive: true })
  }

  private recordPath(invocationId: string): string {
    return join(this.rootPath, `${encodeURIComponent(normalizedInvocationId(invocationId))}.json`)
  }

  save(record: AgentInvocationDebugRecord): void {
    const parsed = parseAgentInvocationDebugRecord(record)
    const target = this.recordPath(parsed.invocationId)
    const temporary = `${target}.${randomUUID()}.tmp`
    writeFileSync(temporary, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
    renameSync(temporary, target)
  }

  read(invocationId: string): AgentInvocationDebugRecord | undefined {
    const id = normalizedInvocationId(invocationId)
    try {
      const raw = JSON.parse(readFileSync(this.recordPath(id), 'utf8')) as unknown
      const parsed = parseAgentInvocationDebugRecord(raw, id)
      const persisted = raw as { formatVersion?: unknown; invocationId?: unknown }
      if (
        persisted.formatVersion !== AGENT_INVOCATION_FORMAT_VERSION
        || persisted.invocationId !== parsed.invocationId
      ) this.save(parsed)
      return parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
}

/** Useful for fixtures and embedders that do not own an application data directory. */
export class InMemoryAgentDebugStore implements AgentDebugStore {
  private readonly records = new Map<string, AgentInvocationDebugRecord>()

  save(record: AgentInvocationDebugRecord): void {
    const parsed = parseAgentInvocationDebugRecord(record)
    this.records.set(parsed.invocationId, parsed)
  }

  read(invocationId: string): AgentInvocationDebugRecord | undefined {
    const record = this.records.get(normalizedInvocationId(invocationId))
    return record ? structuredClone(record) : undefined
  }
}

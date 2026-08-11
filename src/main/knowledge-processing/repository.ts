import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { KNOWLEDGE_AGENT_IDS, type KnowledgeAgentId } from '../../shared/knowledge-processing'
import type {
  KnowledgeProcessingConfigurationData,
  KnowledgeProcessingConfigurationRepository,
  StoredKnowledgeAgent
} from './model'

const EMPTY_CONFIGURATION: KnowledgeProcessingConfigurationData = { agents: [] }
const FORMAT_VERSION = 3

interface PersistedKnowledgeProcessingConfiguration
  extends KnowledgeProcessingConfigurationData {
  formatVersion: typeof FORMAT_VERSION
}

function cloneConfiguration(
  state: KnowledgeProcessingConfigurationData
): KnowledgeProcessingConfigurationData {
  return structuredClone(state)
}

function isStoredAgent(value: unknown): value is StoredKnowledgeAgent {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return Object.keys(record).every((key) => (
    key === 'agentId'
    || key === 'defaultInstructionsOverride'
    || key === 'instructionsOverride'
  ))
    && typeof record.agentId === 'string'
    && KNOWLEDGE_AGENT_IDS.includes(record.agentId as KnowledgeAgentId)
    && (
      record.defaultInstructionsOverride === undefined
      || (
        typeof record.defaultInstructionsOverride === 'string'
        && Boolean(record.defaultInstructionsOverride.trim())
      )
    )
    && (
      record.instructionsOverride === undefined
      || (
        typeof record.instructionsOverride === 'string'
        && Boolean(record.instructionsOverride.trim())
      )
    )
}

function validateCurrentConfiguration(
  value: Record<string, unknown>
): KnowledgeProcessingConfigurationData {
  if (!Array.isArray(value.agents)) {
    throw new Error('知识加工配置缺少 agents 数组')
  }
  const agents = value.agents as unknown[]
  const invalidIndex = agents.findIndex((agent) => !isStoredAgent(agent))
  if (invalidIndex >= 0) {
    throw new Error(`知识加工配置中的第 ${invalidIndex + 1} 条 Agent 记录无效`)
  }
  const typed = agents as StoredKnowledgeAgent[]
  if (new Set(typed.map((agent) => agent.agentId)).size !== typed.length) {
    throw new Error('知识加工配置包含重复 Agent')
  }
  return { agents: typed }
}

function persistedConfiguration(
  state: KnowledgeProcessingConfigurationData
): PersistedKnowledgeProcessingConfiguration {
  return { formatVersion: FORMAT_VERSION, ...cloneConfiguration(state) }
}

function parseConfiguration(value: unknown): KnowledgeProcessingConfigurationData | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('知识加工配置必须是对象')
  }
  const record = value as Record<string, unknown>
  if (record.formatVersion === undefined) return undefined
  if (!Number.isSafeInteger(record.formatVersion) || (record.formatVersion as number) < 1) {
    throw new Error('知识加工配置格式版本无效')
  }
  if ((record.formatVersion as number) < FORMAT_VERSION) return undefined
  if ((record.formatVersion as number) > FORMAT_VERSION) {
    throw new Error(`知识加工配置格式版本 ${record.formatVersion} 高于当前支持版本 ${FORMAT_VERSION}`)
  }
  return validateCurrentConfiguration(record)
}

export class JsonKnowledgeProcessingConfigurationRepository
implements KnowledgeProcessingConfigurationRepository {
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  async load(): Promise<KnowledgeProcessingConfigurationData> {
    try {
      const state = parseConfiguration(JSON.parse(await readFile(this.filePath, 'utf8')) as unknown)
      if (state) return cloneConfiguration(state)
      await this.save(EMPTY_CONFIGURATION)
      return cloneConfiguration(EMPTY_CONFIGURATION)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return cloneConfiguration(EMPTY_CONFIGURATION)
      }
      throw error
    }
  }

  async save(state: KnowledgeProcessingConfigurationData): Promise<void> {
    const snapshot = cloneConfiguration(state)
    const write = async (): Promise<void> => {
      await mkdir(dirname(this.filePath), { recursive: true })
      const temporaryPath = `${this.filePath}.tmp`
      await writeFile(
        temporaryPath,
        `${JSON.stringify(persistedConfiguration(snapshot), null, 2)}\n`,
        'utf8'
      )
      await rename(temporaryPath, this.filePath)
    }
    this.writeQueue = this.writeQueue.then(write, write)
    return this.writeQueue
  }
}

export class InMemoryKnowledgeProcessingConfigurationRepository
implements KnowledgeProcessingConfigurationRepository {
  private state: KnowledgeProcessingConfigurationData

  constructor(initialState: KnowledgeProcessingConfigurationData = EMPTY_CONFIGURATION) {
    this.state = cloneConfiguration(initialState)
  }

  async load(): Promise<KnowledgeProcessingConfigurationData> {
    return cloneConfiguration(this.state)
  }

  async save(state: KnowledgeProcessingConfigurationData): Promise<void> {
    this.state = cloneConfiguration(state)
  }
}

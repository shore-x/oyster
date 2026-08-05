import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { PROCESSING_STAGE_IDS, type ProcessingStageId } from '../../shared/knowledge-processing'
import { REASONING_EFFORTS, type ReasoningEffort } from '../../shared/ai-backends'
import type {
  KnowledgeProcessingRepository,
  KnowledgeProcessingStateData,
  StoredProcessingStage
} from './model'

const EMPTY_STATE: KnowledgeProcessingStateData = { stages: [] }
const FORMAT_VERSION = 1

interface PersistedKnowledgeProcessingState extends KnowledgeProcessingStateData {
  formatVersion: typeof FORMAT_VERSION
}

function cloneState(state: KnowledgeProcessingStateData): KnowledgeProcessingStateData {
  return structuredClone(state)
}

function isStoredStage(value: unknown): value is StoredProcessingStage {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.stageId === 'string'
    && PROCESSING_STAGE_IDS.includes(record.stageId as ProcessingStageId)
    && (
      record.connectionId === undefined
      || (typeof record.connectionId === 'string' && Boolean(record.connectionId.trim()) && record.connectionId.length <= 512)
    )
    && (
      record.modelId === undefined
      || (typeof record.modelId === 'string' && Boolean(record.modelId.trim()) && record.modelId.length <= 512)
    )
    && (
      record.reasoningEffort === undefined
      || (
        typeof record.reasoningEffort === 'string'
        && REASONING_EFFORTS.includes(record.reasoningEffort as ReasoningEffort)
      )
    )
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

function validateCurrentState(value: Record<string, unknown>): KnowledgeProcessingStateData {
  if (!Array.isArray(value.stages)) {
    throw new Error('知识加工配置缺少 stages 数组')
  }
  const stages = value.stages as unknown[]
  const invalidIndex = stages.findIndex((stage) => !isStoredStage(stage))
  if (invalidIndex >= 0) throw new Error(`知识加工配置中的第 ${invalidIndex + 1} 条记录无效`)
  const typed = stages as StoredProcessingStage[]
  if (new Set(typed.map((stage) => stage.stageId)).size !== typed.length) {
    throw new Error('知识加工配置包含重复阶段')
  }
  return { stages: typed }
}

function persistedState(state: KnowledgeProcessingStateData): PersistedKnowledgeProcessingState {
  return { formatVersion: FORMAT_VERSION, ...cloneState(state) }
}

function parseState(value: unknown): KnowledgeProcessingStateData | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('知识加工配置必须是对象')
  }
  const record = value as Record<string, unknown>
  if (record.formatVersion === undefined) return undefined
  if (!Number.isSafeInteger(record.formatVersion) || (record.formatVersion as number) < 1) {
    throw new Error('知识加工配置格式版本无效')
  }
  if ((record.formatVersion as number) > FORMAT_VERSION) {
    throw new Error(`知识加工配置格式版本 ${record.formatVersion} 高于当前支持版本 ${FORMAT_VERSION}`)
  }
  return validateCurrentState(record)
}

export class JsonKnowledgeProcessingRepository implements KnowledgeProcessingRepository {
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  async load(): Promise<KnowledgeProcessingStateData> {
    try {
      const state = parseState(JSON.parse(await readFile(this.filePath, 'utf8')) as unknown)
      if (state) return cloneState(state)
      await this.save(EMPTY_STATE)
      return cloneState(EMPTY_STATE)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return cloneState(EMPTY_STATE)
      throw error
    }
  }

  async save(state: KnowledgeProcessingStateData): Promise<void> {
    const snapshot = cloneState(state)
    const write = async (): Promise<void> => {
      await mkdir(dirname(this.filePath), { recursive: true })
      const temporaryPath = `${this.filePath}.tmp`
      await writeFile(temporaryPath, `${JSON.stringify(persistedState(snapshot), null, 2)}\n`, 'utf8')
      await rename(temporaryPath, this.filePath)
    }
    this.writeQueue = this.writeQueue.then(write, write)
    return this.writeQueue
  }
}

export class InMemoryKnowledgeProcessingRepository implements KnowledgeProcessingRepository {
  private state: KnowledgeProcessingStateData

  constructor(initialState: KnowledgeProcessingStateData = EMPTY_STATE) {
    this.state = cloneState(initialState)
  }

  async load(): Promise<KnowledgeProcessingStateData> {
    return cloneState(this.state)
  }

  async save(state: KnowledgeProcessingStateData): Promise<void> {
    this.state = cloneState(state)
  }
}

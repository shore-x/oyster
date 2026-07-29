import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ChatConfigurationRepository, ChatConfigurationStateData } from './model'

const EMPTY_STATE: ChatConfigurationStateData = {}

function cloneState(state: ChatConfigurationStateData): ChatConfigurationStateData {
  return structuredClone(state)
}

function validateState(value: unknown): ChatConfigurationStateData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('对话 Agent 配置必须是对象')
  }
  const override = (value as Record<string, unknown>).defaultInstructionsOverride
  if (override === undefined) return {}
  if (typeof override !== 'string' || !override.trim()) {
    throw new Error('对话 Agent 默认 System Prompt 无效')
  }
  return { defaultInstructionsOverride: override }
}

export class JsonChatConfigurationRepository implements ChatConfigurationRepository {
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  async load(): Promise<ChatConfigurationStateData> {
    try {
      return cloneState(validateState(JSON.parse(await readFile(this.filePath, 'utf8')) as unknown))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return cloneState(EMPTY_STATE)
      throw error
    }
  }

  async save(state: ChatConfigurationStateData): Promise<void> {
    const snapshot = cloneState(validateState(state))
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

export class InMemoryChatConfigurationRepository implements ChatConfigurationRepository {
  private state: ChatConfigurationStateData

  constructor(initialState: ChatConfigurationStateData = EMPTY_STATE) {
    this.state = cloneState(validateState(initialState))
  }

  async load(): Promise<ChatConfigurationStateData> {
    return cloneState(this.state)
  }

  async save(state: ChatConfigurationStateData): Promise<void> {
    this.state = cloneState(validateState(state))
  }
}

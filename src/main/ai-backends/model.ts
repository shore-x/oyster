import type {
  AiConnection,
  AvailableModel,
  ModelProtocol,
  ModelProviderId,
  ReasoningEffort
} from '../../shared/ai-backends'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import type { Api, Model } from '@earendil-works/pi-ai'

export interface StoredModelConnection {
  id: string
  adapterId: 'openai-compatible'
  providerId: ModelProviderId
  protocol: ModelProtocol
  baseUrl: string
  model: string
  credentialRef?: string
}

export interface AiBackendStateData {
  connections: StoredModelConnection[]
}

export interface AiBackendRepository {
  load(): Promise<AiBackendStateData>
  save(state: AiBackendStateData): Promise<void>
}

export interface CredentialStore {
  get(reference: string): Promise<string | undefined>
  set(reference: string, secret: string): Promise<void>
  delete(reference: string): Promise<void>
}

export interface ModelGenerationRequest {
  systemPrompt?: string
  prompt: string
  maxOutputTokens?: number
  timeoutMs?: number
  maxResponseBytes?: number
  reasoningEffort?: ReasoningEffort
  signal?: AbortSignal
}

export interface ModelGenerationResult {
  text: string
}

export interface ModelRuntime {
  model: Model<Api>
  streamFn: StreamFn
}

/** Marks a failure that came from the configured model transport, not from local Agent policy or tools. */
export class ModelConnectionFailureError extends Error {
  readonly operationError: Error

  constructor(error: unknown, fallback = '模型连接调用失败') {
    const operationError = error instanceof Error ? error : new Error(typeof error === 'string' ? error : fallback)
    super(operationError.message, { cause: operationError })
    this.name = 'ModelConnectionFailureError'
    this.operationError = operationError
  }
}

export interface ModelBackendAdapter {
  readonly id: 'openai-compatible'
  listModels(
    providerId: ModelProviderId,
    baseUrl: string,
    apiKey?: string,
    signal?: AbortSignal
  ): Promise<AvailableModel[]>
  generate(
    connection: StoredModelConnection,
    apiKey: string | undefined,
    request: ModelGenerationRequest
  ): Promise<ModelGenerationResult>
}

export interface AgentTaskRequest {
  prompt: string
  workspacePath: string
  modelId?: string
  reasoningEffort?: ReasoningEffort
  signal?: AbortSignal
}

export interface AgentTaskResult {
  text: string
}

export interface AgentAuthLaunch {
  url: string
}

export interface AgentBackendAdapter {
  readonly id: 'codex'
  inspect(): Promise<AiConnection>
  connect(): Promise<AgentAuthLaunch | undefined>
  cancelConnect(): void
  runTask(request: AgentTaskRequest): Promise<AgentTaskResult>
  subscribe(listener: () => void): () => void
  dispose(): void
}

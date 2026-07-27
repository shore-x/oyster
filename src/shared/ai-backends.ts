export const AI_BACKEND_KINDS = ['coding_plan', 'api'] as const
export const MODEL_PROTOCOLS = ['openai_responses', 'openai_chat_completions'] as const
export const MODEL_PROVIDER_IDS = ['openai', 'openai_compatible'] as const
export const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export type AiBackendKind = (typeof AI_BACKEND_KINDS)[number]
export type ModelProtocol = (typeof MODEL_PROTOCOLS)[number]
export type ModelProviderId = (typeof MODEL_PROVIDER_IDS)[number]
export type AiProviderId = 'openai_codex' | ModelProviderId
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]
export type AiConnectionStatus =
  | 'not_found'
  | 'needs_auth'
  | 'authenticating'
  | 'unverified'
  | 'ready'
  | 'unsupported'
  | 'unavailable'

export interface AiBackendOption {
  adapterId: 'codex' | 'openai-compatible'
  backendKind: AiBackendKind
  providerId: AiProviderId
  displayName: string
  description: string
}

export interface ModelConnectionConfig {
  providerId: ModelProviderId
  protocol: ModelProtocol
  baseUrl: string
  model: string
  hasApiKey: boolean
  reasoningEfforts?: ReasoningEffort[]
}

export interface AiConnection {
  id: string
  adapterId: AiBackendOption['adapterId']
  backendKind: AiBackendKind
  providerId: AiProviderId
  displayName: string
  credentialMode: 'provider_runtime' | 'oyster_keychain'
  status: AiConnectionStatus
  executablePath?: string
  accountLabel?: string
  planType?: string
  models: AvailableModel[]
  defaultModelId?: string
  modelConfig?: ModelConnectionConfig
  errorMessage?: string
  lastCheckedAt?: string
}

export interface AiBackendSnapshot {
  options: AiBackendOption[]
  connections: AiConnection[]
  configurationError?: string
}

export interface SaveModelConnectionInput {
  providerId: ModelProviderId
  protocol: ModelProtocol
  baseUrl: string
  model: string
  apiKey?: string
}

/** Connection details used only for a read-only `/models` request; the key is never persisted. */
export interface DiscoverModelsInput {
  providerId: ModelProviderId
  baseUrl: string
  apiKey?: string
}

export interface AvailableModel {
  id: string
  displayName: string
  reasoningEfforts: ReasoningEffort[]
}

export interface ModelDiscoveryResult {
  models: AvailableModel[]
}

export interface ConnectionTestResult {
  connectionId: string
  output: string
  durationMs: number
  cancelled?: boolean
}

export interface TestConnectionInput {
  connectionId: string
  modelId: string
  reasoningEffort?: ReasoningEffort
}

export interface AiBackendApi {
  getSnapshot(): Promise<AiBackendSnapshot>
  refresh(): Promise<AiBackendSnapshot>
  connect(connectionId: string): Promise<AiBackendSnapshot>
  saveModelConnection(input: SaveModelConnectionInput): Promise<AiBackendSnapshot>
  discoverModels(input: DiscoverModelsInput): Promise<ModelDiscoveryResult>
  removeConnection(connectionId: string): Promise<AiBackendSnapshot>
  testConnection(input: TestConnectionInput): Promise<ConnectionTestResult>
  subscribe(listener: (snapshot: AiBackendSnapshot) => void): () => void
}

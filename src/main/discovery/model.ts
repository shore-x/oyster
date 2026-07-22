import type { AgentSource, AgentType, HistorySession, SyncRun } from '../../shared/discovery'

export interface DiscoveryStateData {
  sources: AgentSource[]
  sessions: HistorySession[]
  runs: SyncRun[]
}

export interface DetectionContext {
  homeDirectory: string
  environment: NodeJS.ProcessEnv
  pathEntries: string[]
}

export interface DetectionResult {
  rootPath: string
  found: boolean
  executablePath?: string
  permissionDenied?: boolean
  errorMessage?: string
}

export interface SessionCandidate {
  externalId: string
  relativePath: string
  title?: string
  projectPath?: string
  startedAt?: string
  updatedAt?: string
  sizeBytes: number
  modifiedAt: string
}

export type ScanEntry =
  | { kind: 'session'; candidate: SessionCandidate }
  | { kind: 'invalid'; relativePath: string; sizeBytes: number }

export interface AgentHistoryAdapter {
  readonly agentType: AgentType
  readonly displayName: string
  defaultRoot(context: DetectionContext): string
  detect(context: DetectionContext, rootOverride?: string): Promise<DetectionResult>
  scan(rootPath: string, signal: AbortSignal): AsyncGenerator<ScanEntry>
  resolveSessionPath(rootPath: string, relativePath: string): string
}

export interface DiscoveryRepository {
  load(): Promise<DiscoveryStateData>
  save(state: DiscoveryStateData): Promise<void>
}

export interface RawEvidenceInput {
  sourceId: string
  sessionId: string
  absolutePath: string
  fingerprint: string
  signal: AbortSignal
  onProgress(bytes: number): void
}

export interface RawEvidenceStore {
  importFile(input: RawEvidenceInput): Promise<string>
}

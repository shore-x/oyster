export const AGENT_TYPES = ['claude', 'pi', 'codex'] as const

export type AgentType = (typeof AGENT_TYPES)[number]
export type ArtifactKind = 'conversation' | 'human_instruction'
export type InstructionScope = 'user' | 'project' | 'managed'
export type DiscoveryState = 'not_found' | 'found' | 'needs_permission' | 'error'
export type ScanState = 'idle' | 'scanning' | 'ready' | 'error'
export type ScanRunState = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted'

export interface AgentSource {
  id: string
  agentType: AgentType
  displayName: string
  rootPath: string
  executablePath?: string
  discoveryState: DiscoveryState
  scanState: ScanState
  fileCount: number
  sessionCount: number
  instructionFileCount: number
  totalBytes: number
  invalidFileCount: number
  oldestSessionAt?: string
  latestSessionAt?: string
  lastDetectedAt?: string
  lastScannedAt?: string
  errorMessage?: string
}
export interface HistoryArtifact {
  id: string
  sourceId: string
  kind: ArtifactKind
  externalId: string
  relativePath: string
  sourcePath?: string
  title?: string
  projectPath?: string
  instructionScope?: InstructionScope
  startedAt?: string
  endedAt?: string
  updatedAt?: string
  messageCount?: number
  sizeBytes: number
  modifiedAt: string
  fingerprint: string
}

export interface ScanRun {
  id: string
  sourceId: string
  state: ScanRunState
  totalFiles: number
  processedFiles: number
  totalBytes: number
  processedBytes: number
  invalidFiles: number
  startedAt?: string
  finishedAt?: string
  errorMessage?: string
}

export interface DiscoverySnapshot {
  sources: AgentSource[]
  runs: ScanRun[]
}

/** A path-free reference to one discovered conversation revision. */
export interface AvailableSessionSummary {
  artifactId: string
  sourceId: string
  agentType: AgentType
  sourceDisplayName: string
  externalId: string
  title?: string
  projectPath?: string
  startedAt?: string
  endedAt?: string
  updatedAt?: string
  messageCount?: number
  sizeBytes: number
  revision: string
}

export interface InspectAvailableSessionInput {
  artifactId: string
  expectedRevision: string
}

export interface DiscoveryApi {
  getSnapshot(): Promise<DiscoverySnapshot>
  listAvailableSessions(): Promise<AvailableSessionSummary[]>
  inspectAvailableSession(input: InspectAvailableSessionInput): Promise<AvailableSessionSummary>
  detectAgents(): Promise<DiscoverySnapshot>
  scanSource(sourceId: string): Promise<DiscoverySnapshot>
  cancelRun(runId: string): Promise<DiscoverySnapshot>
  chooseSourceRoot(sourceId: string): Promise<DiscoverySnapshot>
  subscribe(listener: (snapshot: DiscoverySnapshot) => void): () => void
}

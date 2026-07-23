export const AGENT_TYPES = ['claude', 'pi', 'codex'] as const

export type AgentType = (typeof AGENT_TYPES)[number]
export type ArtifactKind = 'conversation' | 'human_instruction'
export type InstructionScope = 'user' | 'project' | 'managed'
export type DiscoveryState = 'not_found' | 'found' | 'needs_permission' | 'error'
export type ScanState = 'idle' | 'scanning' | 'ready' | 'error'
export type ArtifactSyncState = 'pending' | 'syncing' | 'synced' | 'failed' | 'missing'
export type SyncRunState = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted'
export type SyncRunKind = 'scan' | 'import'

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
  syncedBytes: number
  syncedSessionCount: number
  syncedInstructionFileCount: number
  oldestSessionAt?: string
  latestSessionAt?: string
  lastDetectedAt?: string
  lastScannedAt?: string
  lastSyncedAt?: string
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
  updatedAt?: string
  sizeBytes: number
  modifiedAt: string
  fingerprint: string
  syncState: ArtifactSyncState
  rawEvidenceId?: string
  rawContentHash?: string
  syncedFingerprint?: string
  errorMessage?: string
}

export interface SyncRun {
  id: string
  sourceId: string
  kind: SyncRunKind
  state: SyncRunState
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
  runs: SyncRun[]
}

export interface DiscoveryApi {
  getSnapshot(): Promise<DiscoverySnapshot>
  detectAgents(): Promise<DiscoverySnapshot>
  scanSource(sourceId: string): Promise<DiscoverySnapshot>
  importSource(sourceId: string): Promise<DiscoverySnapshot>
  cancelRun(runId: string): Promise<DiscoverySnapshot>
  chooseSourceRoot(sourceId: string): Promise<DiscoverySnapshot>
  openRawEvidenceDirectory(): Promise<void>
  subscribe(listener: (snapshot: DiscoverySnapshot) => void): () => void
}

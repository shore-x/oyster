export const AGENT_TYPES = ['claude', 'pi', 'codex'] as const

export type AgentType = (typeof AGENT_TYPES)[number]
export type DiscoveryState = 'not_found' | 'found' | 'needs_permission' | 'error'
export type ScanState = 'idle' | 'scanning' | 'ready' | 'error'
export type SessionSyncState = 'pending' | 'syncing' | 'synced' | 'failed' | 'missing'
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
  totalBytes: number
  invalidFileCount: number
  syncedBytes: number
  syncedSessionCount: number
  oldestSessionAt?: string
  latestSessionAt?: string
  lastDetectedAt?: string
  lastScannedAt?: string
  lastSyncedAt?: string
  errorMessage?: string
}
export interface HistorySession {
  id: string
  sourceId: string
  externalId: string
  relativePath: string
  title?: string
  projectPath?: string
  startedAt?: string
  updatedAt?: string
  sizeBytes: number
  modifiedAt: string
  fingerprint: string
  syncState: SessionSyncState
  rawEvidenceId?: string
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
  subscribe(listener: (snapshot: DiscoverySnapshot) => void): () => void
}

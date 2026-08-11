export const AGENT_TYPES = ['claude', 'pi', 'codex'] as const

export type AgentType = (typeof AGENT_TYPES)[number]
export type SourceRecordKind = 'conversation' | 'human_instruction'
export type InstructionScope = 'user' | 'project' | 'managed'
export type DiscoveryState = 'not_found' | 'found' | 'needs_permission' | 'error'
export type ScanState = 'idle' | 'scanning' | 'ready' | 'error'
export type DiscoveryScanStatus =
  | 'queued'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'interrupted'

export interface AgentSource {
  id: string
  agentType: AgentType
  displayName: string
  rootPath: string
  executablePath?: string
  discoveryState: DiscoveryState
  scanState: ScanState
  fileCount: number
  conversationCount: number
  instructionFileCount: number
  totalBytes: number
  invalidFileCount: number
  oldestConversationAt?: string
  latestConversationAt?: string
  lastDetectedAt?: string
  lastScannedAt?: string
  errorMessage?: string
}

export interface SourceRecord {
  id: string
  sourceId: string
  kind: SourceRecordKind
  externalId: string
  relativePath: string
  sourcePath?: string
  title?: string
  projectPath?: string
  instructionScope?: InstructionScope
  startedAt?: string
  endedAt?: string
  updatedAt?: string
  sizeBytes: number
  modifiedAt: string
  fingerprint: string
}

export interface DiscoveryScan {
  scanId: string
  sourceId: string
  status: DiscoveryScanStatus
  totalFiles: number
  processedFiles: number
  totalBytes: number
  processedBytes: number
  invalidFiles: number
  startedAt?: string
  completedAt?: string
  errorMessage?: string
}

export interface DiscoveryStateView {
  sources: AgentSource[]
  scans: DiscoveryScan[]
}

/** Renderer-safe identity and metadata for one externally owned conversation. */
export interface SourceConversationSummary {
  sourceConversationId: string
  sourceId: string
  agentType: AgentType
  sourceDisplayName: string
  providerConversationId: string
  title?: string
  projectPath?: string
  startedAt?: string
  endedAt?: string
  updatedAt?: string
  sizeBytes: number
  sourceRevision: string
}

/** Exact external conversation revision accepted as immutable Task input. */
export interface SourceSnapshotRef {
  sourceConversationId: string
  sourceRevision: string
}

export type SourceConversationCatalogStatus = 'idle' | 'refreshing' | 'error'

export interface SourceConversationCatalogView {
  conversations: SourceConversationSummary[]
  status: SourceConversationCatalogStatus
  refreshedAt?: string
  errorMessage?: string
}

export interface DiscoveryApi {
  getState(): Promise<DiscoveryStateView>
  getSourceConversationCatalog(): Promise<SourceConversationCatalogView>
  refreshSourceConversationCatalog(): Promise<SourceConversationCatalogView>
  detectAgents(): Promise<DiscoveryStateView>
  scanSource(sourceId: string): Promise<DiscoveryStateView>
  cancelScan(scanId: string): Promise<DiscoveryStateView>
  chooseSourceRoot(sourceId: string): Promise<DiscoveryStateView>
  subscribe(listener: (state: DiscoveryStateView) => void): () => void
  subscribeSourceConversationCatalog(
    listener: (catalog: SourceConversationCatalogView) => void
  ): () => void
}

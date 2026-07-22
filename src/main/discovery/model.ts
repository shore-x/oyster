import type {
  AgentSource,
  AgentType,
  ArtifactKind,
  HistoryArtifact,
  InstructionScope,
  SyncRun
} from '../../shared/discovery'

export interface DiscoveryStateData {
  sources: AgentSource[]
  artifacts: HistoryArtifact[]
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

export interface ArtifactCandidate {
  kind: ArtifactKind
  externalId: string
  relativePath: string
  sourcePath: string
  title?: string
  projectPath?: string
  instructionScope?: InstructionScope
  startedAt?: string
  updatedAt?: string
  sizeBytes: number
  modifiedAt: string
}

export type ScanEntry =
  | { kind: 'artifact'; candidate: ArtifactCandidate }
  | { kind: 'invalid'; relativePath: string; sizeBytes: number }

export interface AgentHistoryAdapter {
  readonly agentType: AgentType
  readonly displayName: string
  defaultRoot(context: DetectionContext): string
  detect(context: DetectionContext, rootOverride?: string): Promise<DetectionResult>
  scan(rootPath: string, signal: AbortSignal, context?: DetectionContext): AsyncGenerator<ScanEntry>
  resolveArtifactPath(rootPath: string, artifact: HistoryArtifact): string
}

export interface DiscoveryRepository {
  load(): Promise<DiscoveryStateData>
  save(state: DiscoveryStateData): Promise<void>
}

export interface RawEvidenceInput {
  sourceId: string
  artifactId: string
  artifactKind: ArtifactKind
  absolutePath: string
  fingerprint: string
  signal: AbortSignal
  onProgress(bytes: number): void
}

export interface RawEvidenceReceipt {
  id: string
  contentHash: string
  sizeBytes: number
}

export interface RawEvidenceStore {
  importFile(input: RawEvidenceInput): Promise<RawEvidenceReceipt>
}

import type {
  AgentSource,
  AgentType,
  ArtifactKind,
  HistoryArtifact,
  InstructionScope,
  ScanRun
} from '../../shared/discovery'
import type { ObservationView } from '../observation/model'

export interface DiscoveryStateData {
  sources: AgentSource[]
  artifacts: HistoryArtifact[]
  runs: ScanRun[]
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
  endedAt?: string
  updatedAt?: string
  messageCount?: number
  sizeBytes: number
  modifiedAt: string
}

export type ScanEntry =
  | { kind: 'artifact'; candidate: ArtifactCandidate }
  | { kind: 'invalid'; relativePath: string; sizeBytes: number }

export interface SessionInspectionResult {
  messageCount: number
  startedAt?: string
  endedAt?: string
}

export interface SessionLineInspector {
  visitLine(line: string): void
  result(): SessionInspectionResult
}

export interface AgentHistoryAdapter {
  readonly agentType: AgentType
  readonly displayName: string
  defaultRoot(context: DetectionContext): string
  detect(context: DetectionContext, rootOverride?: string): Promise<DetectionResult>
  scan(rootPath: string, signal: AbortSignal, context?: DetectionContext): AsyncGenerator<ScanEntry>
  resolveArtifactPath(rootPath: string, artifact: HistoryArtifact): string
  createSessionInspector(): SessionLineInspector
  /** Builds the deterministic, format-specific model view while preserving raw-line provenance. */
  createObservationView(rawContent: string): ObservationView
}

export interface DiscoveryRepository {
  load(): Promise<DiscoveryStateData>
  save(state: DiscoveryStateData): Promise<void>
}

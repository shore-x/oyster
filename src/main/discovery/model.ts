import type {
  AgentSource,
  AgentType,
  SourceRecord,
  SourceRecordKind,
  InstructionScope,
  ScanRun
} from '../../shared/discovery'
import type { RawEvidence } from '../observation/model'

export interface DiscoveryStateData {
  sources: AgentSource[]
  records: SourceRecord[]
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

export interface SourceRecordCandidate {
  kind: SourceRecordKind
  externalId: string
  relativePath: string
  sourcePath: string
  title?: string
  projectPath?: string
  instructionScope?: InstructionScope
  startedAt?: string
  endedAt?: string
  updatedAt?: string
  sizeBytes: number
  modifiedAt: string
}

export type ScanEntry =
  | { kind: 'record'; candidate: SourceRecordCandidate }
  | { kind: 'invalid'; relativePath: string; sizeBytes: number }

export interface AgentHistoryAdapter {
  readonly agentType: AgentType
  readonly displayName: string
  defaultRoot(context: DetectionContext): string
  detect(context: DetectionContext, rootOverride?: string): Promise<DetectionResult>
  scan(rootPath: string, signal: AbortSignal, context?: DetectionContext): AsyncGenerator<ScanEntry>
  /** Re-discovers one conversation by its stable Agent-owned identity. Paths are only hints. */
  refreshConversation(
    rootPath: string,
    record: SourceRecord,
    signal: AbortSignal,
    context?: DetectionContext
  ): Promise<SourceRecordCandidate | undefined>
  resolveRecordPath(rootPath: string, record: SourceRecord): string
  /** Reads complete Raw Evidence and derives non-authoritative format-specific hints. */
  createRawEvidence(rawContent: string): RawEvidence
}

export interface DiscoveryRepository {
  load(): Promise<DiscoveryStateData>
  save(state: DiscoveryStateData): Promise<void>
}

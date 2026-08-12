import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import type {
  AgentSource,
  AgentType,
  SourceConversationSummary,
  DiscoveryStateView,
  SourceConversationCatalogView,
  DiscoveryScan,
  SourceRecord,
  SourceRecordKind
} from '../../shared/discovery'
import { AGENT_TYPES } from '../../shared/discovery'
import { createDetectionContext } from './adapters'
import type {
  AgentHistoryAdapter,
  DetectionContext,
  DiscoveryRepository,
  DiscoveryStateData,
  SourceRecordCandidate
} from './model'
import {
  SourceConversationChangedError,
  SourceConversationUnavailableError,
  type SourceEvidenceReader,
  type SourceEvidenceReadResult
} from './source-evidence-reader'
import type { CanonicalActivity, RawEvidence } from '../observation/model'

type DiscoveryStateListener = (state: DiscoveryStateView) => void
type SourceConversationCatalogListener = (state: SourceConversationCatalogView) => void

interface ActiveScan {
  scanId: string
  controller: AbortController
  task?: Promise<void>
}

interface DiscoveryServiceOptions {
  recoverInterruptedScans?: boolean
}

interface RefreshedConversationRecord {
  record?: SourceRecord
}

export interface ReadSourceSnapshotInput {
  sourceConversationId: string
}

export interface SourceSnapshotEvidence {
  sourceConversationId: string
  contentHash: string
  sizeBytes: number
  rawEvidence: RawEvidence
  canonicalActivity: CanonicalActivity
}

function now(): string {
  return new Date().toISOString()
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function sourceConversationId(sourceId: string, kind: SourceRecordKind, externalId: string): string {
  const key = kind === 'conversation' ? `${sourceId}\0${externalId}` : `${sourceId}\0${kind}\0${externalId}`
  return createHash('sha256').update(key).digest('hex').slice(0, 32)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.message.includes('aborted'))
}

function sourceConversationSummary(
  record: SourceRecord,
  source: AgentSource
): SourceConversationSummary {
  return {
    sourceConversationId: record.id,
    sourceId: source.id,
    agentType: source.agentType,
    sourceDisplayName: source.displayName,
    providerConversationId: record.externalId,
    title: record.title,
    projectPath: record.projectPath,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    updatedAt: record.updatedAt,
    sizeBytes: record.sizeBytes
  }
}

function sourceRecord(
  sourceId: string,
  candidate: SourceRecordCandidate,
  existing?: SourceRecord
): SourceRecord {
  return {
    id: sourceConversationId(sourceId, candidate.kind, candidate.externalId),
    sourceId,
    kind: candidate.kind,
    externalId: candidate.externalId,
    relativePath: candidate.relativePath,
    sourcePath: candidate.sourcePath,
    title: candidate.title,
    projectPath: candidate.projectPath,
    instructionScope: candidate.instructionScope,
    startedAt: candidate.startedAt,
    endedAt: candidate.endedAt
      ?? (
        existing?.sizeBytes === candidate.sizeBytes
        && existing.modifiedAt === candidate.modifiedAt
          ? existing.endedAt
          : undefined
      ),
    updatedAt: candidate.updatedAt,
    sizeBytes: candidate.sizeBytes,
    modifiedAt: candidate.modifiedAt
  }
}

function assertSourceConversationSelection(input: { sourceConversationId: string }): void {
  if (
    typeof input.sourceConversationId !== 'string'
    || input.sourceConversationId.length === 0
    || input.sourceConversationId.length > 256
  ) {
    throw new Error('Invalid source conversation ID')
  }
}

export class DiscoveryService {
  private state: DiscoveryStateData = { sources: [], records: [], scans: [] }
  private readonly listeners = new Set<DiscoveryStateListener>()
  private readonly sourceConversationCatalogListeners = new Set<SourceConversationCatalogListener>()
  private readonly activeScans = new Map<string, ActiveScan>()
  private readonly adapterByType = new Map<AgentType, AgentHistoryAdapter>()
  private detectionContext: DetectionContext

  constructor(
    private readonly repository: DiscoveryRepository,
    private readonly sourceEvidenceReader: SourceEvidenceReader,
    adapters: AgentHistoryAdapter[],
    detectionContext = createDetectionContext(homedir()),
    private readonly options: DiscoveryServiceOptions = {}
  ) {
    this.detectionContext = detectionContext
    for (const adapter of adapters) this.adapterByType.set(adapter.agentType, adapter)
  }

  async initialize(): Promise<DiscoveryStateView> {
    this.state = await this.repository.load()
    const stamp = now()

    for (const adapter of this.adapterByType.values()) {
      if (this.state.sources.some((source) => source.agentType === adapter.agentType)) continue
      this.state.sources.push({
        id: `source:${adapter.agentType}`,
        agentType: adapter.agentType,
        displayName: adapter.displayName,
        rootPath: adapter.defaultRoot(this.detectionContext),
        discoveryState: 'not_found',
        scanState: 'idle',
        fileCount: 0,
        conversationCount: 0,
        instructionFileCount: 0,
        totalBytes: 0,
        invalidFileCount: 0
      })
    }

    for (const source of this.state.sources) source.instructionFileCount ??= 0

    if (this.options.recoverInterruptedScans !== false) {
      for (const scan of this.state.scans) {
        if (scan.status !== 'in_progress' && scan.status !== 'queued') continue
        scan.status = 'interrupted'
        scan.completedAt = stamp
        scan.errorMessage = '应用在任务完成前退出'
      }
      for (const source of this.state.sources) {
        if (source.scanState === 'scanning') source.scanState = 'idle'
      }
    }

    await this.persist()
    return this.stateView()
  }

  stateView(): DiscoveryStateView {
    const sourceOrder = new Map(AGENT_TYPES.map((type, index) => [type, index]))
    return clone({
      sources: [...this.state.sources].sort(
        (left, right) => (sourceOrder.get(left.agentType) ?? 99) - (sourceOrder.get(right.agentType) ?? 99)
      ),
      scans: [...this.state.scans]
        .sort((left, right) => (right.startedAt || '').localeCompare(left.startedAt || ''))
        .slice(0, 30)
    })
  }

  sourceConversationCatalogView(): SourceConversationCatalogView {
    const failedSources = this.state.sources.filter((source) => (
      source.discoveryState === 'error' || source.scanState === 'error'
    ))
    const refreshedAt = this.state.sources
      .flatMap((source) => source.lastScannedAt ? [source.lastScannedAt] : [])
      .sort()
      .at(-1)
    return clone({
      conversations: this.listSourceConversations(),
      status: this.activeScans.size > 0
        ? 'refreshing'
        : failedSources.length > 0
          ? 'error'
          : 'idle',
      ...(refreshedAt ? { refreshedAt } : {}),
      ...(failedSources.length > 0
        ? {
            errorMessage: failedSources
              .map((source) => `${source.displayName}: ${source.errorMessage || 'Source Conversation 扫描失败'}`)
              .join('\n')
          }
        : {})
    })
  }

  listSourceConversations(): SourceConversationSummary[] {
    return this.state.records
      .filter((record) => record.kind === 'conversation')
      .flatMap<SourceConversationSummary>((record) => {
        const source = this.state.sources.find((candidate) => candidate.id === record.sourceId)
        if (
          !source
          || source.discoveryState !== 'found'
          || source.scanState === 'error'
        ) return []
        return [sourceConversationSummary(record, source)]
      })
      .sort((left, right) => {
        const leftDate = left.endedAt || left.updatedAt || left.startedAt || ''
        const rightDate = right.endedAt || right.updatedAt || right.startedAt || ''
        return rightDate.localeCompare(leftDate) || left.sourceConversationId.localeCompare(right.sourceConversationId)
      })
      .map((conversation) => clone(conversation))
  }

  async readSourceSnapshot(
    input: ReadSourceSnapshotInput,
    maxBytes?: number
  ): Promise<SourceSnapshotEvidence> {
    assertSourceConversationSelection(input)
    const record = this.state.records.find((candidate) => candidate.id === input.sourceConversationId)
    if (!record || record.kind !== 'conversation') {
      throw new SourceConversationUnavailableError()
    }
    const source = this.state.sources.find((candidate) => candidate.id === record.sourceId)
    if (!source) throw new SourceConversationUnavailableError()
    const adapter = this.requireAdapter(source.agentType)
    let currentRecord = record
    let evidence: SourceEvidenceReadResult
    try {
      evidence = await this.readRecordEvidence(source, adapter, currentRecord, maxBytes)
    } catch (error) {
      if (
        !(error instanceof SourceConversationUnavailableError)
        && !(error instanceof SourceConversationChangedError)
      ) {
        throw error
      }

      const refreshed = await this.refreshConversationRecord(source, adapter, currentRecord)
      if (!refreshed.record) throw new SourceConversationUnavailableError()
      currentRecord = refreshed.record
      try {
        evidence = await this.readRecordEvidence(source, adapter, currentRecord, maxBytes)
      } catch (retryError) {
        if (retryError instanceof SourceConversationChangedError) {
          throw new SourceConversationChangedError(
            'The source conversation kept changing while it was being read'
          )
        }
        throw retryError
      }
    }
    const content = new TextDecoder('utf-8', { fatal: true }).decode(evidence.content)
    const observation = adapter.createObservation(content)
    return {
      sourceConversationId: currentRecord.id,
      contentHash: evidence.contentHash,
      sizeBytes: evidence.sizeBytes,
      ...observation
    }
  }

  private readRecordEvidence(
    source: AgentSource,
    adapter: AgentHistoryAdapter,
    record: SourceRecord,
    maxBytes?: number
  ): Promise<SourceEvidenceReadResult> {
    return this.sourceEvidenceReader.read({
      sourceConversationId: record.id,
      absolutePath: adapter.resolveRecordPath(source.rootPath, record),
      expectedSizeBytes: record.sizeBytes,
      expectedModifiedAt: record.modifiedAt,
      ...(maxBytes === undefined ? {} : { maxBytes })
    })
  }

  private async refreshConversationRecord(
    source: AgentSource,
    adapter: AgentHistoryAdapter,
    previous: SourceRecord
  ): Promise<RefreshedConversationRecord> {
    const candidate = await adapter.refreshConversation(
      source.rootPath,
      clone(previous),
      new AbortController().signal,
      this.detectionContext
    )
    const current = this.state.records.find((record) => record.id === previous.id)
    if (!candidate) {
      this.state.records = this.state.records.filter((record) => record.id !== previous.id)
      this.updateSourceRecordSummary(source)
      await this.persistAndEmit()
      this.emitSourceConversationCatalog()
      return {}
    }
    if (candidate.kind !== 'conversation' || candidate.externalId !== previous.externalId) {
      throw new Error(`History adapter returned the wrong conversation while refreshing ${previous.externalId}`)
    }

    const next = sourceRecord(source.id, candidate, current)
    if (next.id !== previous.id) {
      throw new Error(`History adapter changed the stable conversation identity for ${previous.externalId}`)
    }
    if (current) Object.assign(current, next)
    else this.state.records.push(next)
    this.updateSourceRecordSummary(source)
    await this.persistAndEmit()
    this.emitSourceConversationCatalog()
    return { record: current ?? next }
  }

  private updateSourceRecordSummary(source: AgentSource): void {
    const records = this.currentRecords(source.id)
    const conversations = records.filter((record) => record.kind === 'conversation')
    source.fileCount = records.length + source.invalidFileCount
    source.conversationCount = conversations.length
    source.instructionFileCount = records.length - conversations.length
    source.totalBytes = records.reduce((total, record) => total + record.sizeBytes, 0)
    const dates = conversations
      .map((record) => record.startedAt || record.modifiedAt)
      .sort()
    source.oldestConversationAt = dates[0]
    source.latestConversationAt = dates.at(-1)
  }

  subscribe(listener: DiscoveryStateListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribeSourceConversationCatalog(listener: SourceConversationCatalogListener): () => void {
    this.sourceConversationCatalogListeners.add(listener)
    return () => this.sourceConversationCatalogListeners.delete(listener)
  }

  async refreshSourceConversationCatalog(): Promise<SourceConversationCatalogView> {
    await this.detectAgents()
    await this.waitForIdle()
    return this.sourceConversationCatalogView()
  }

  async detectAgents(): Promise<DiscoveryStateView> {
    await Promise.all(
      this.state.sources.map(async (source) => {
        const adapter = this.adapterByType.get(source.agentType)
        if (!adapter) return
        const detection = await adapter.detect(this.detectionContext, source.rootPath)
        source.rootPath = detection.rootPath
        source.executablePath = detection.executablePath
        source.lastDetectedAt = now()
        source.errorMessage = detection.errorMessage
        source.discoveryState = detection.permissionDenied
          ? 'needs_permission'
          : detection.errorMessage
            ? 'error'
            : detection.found
              ? 'found'
              : 'not_found'
        if (!detection.found) source.scanState = 'idle'
      })
    )
    await this.persistAndEmit()
    this.emitSourceConversationCatalog()

    for (const source of this.state.sources) {
      if (source.discoveryState === 'found' && !this.activeScans.has(source.id)) {
        await this.scanSource(source.id)
      }
    }
    return this.stateView()
  }

  async chooseSourceRoot(sourceId: string, rootPath: string): Promise<DiscoveryStateView> {
    const source = this.requireSource(sourceId)
    if (this.activeScans.has(sourceId)) return this.stateView()
    const adapter = this.requireAdapter(source.agentType)
    source.rootPath = rootPath
    source.scanState = 'idle'
    source.fileCount = 0
    source.conversationCount = 0
    source.instructionFileCount = 0
    source.totalBytes = 0
    source.invalidFileCount = 0
    source.oldestConversationAt = undefined
    source.latestConversationAt = undefined
    source.lastScannedAt = undefined
    this.state.records = this.state.records.filter((record) => record.sourceId !== sourceId)

    const detection = await adapter.detect(this.detectionContext, rootPath)
    source.executablePath = detection.executablePath
    source.lastDetectedAt = now()
    source.errorMessage = detection.errorMessage
    source.discoveryState = detection.permissionDenied
      ? 'needs_permission'
      : detection.errorMessage
        ? 'error'
        : detection.found
          ? 'found'
          : 'not_found'
    await this.persistAndEmit()
    this.emitSourceConversationCatalog()
    return this.stateView()
  }

  async scanSource(sourceId: string): Promise<DiscoveryStateView> {
    const source = this.requireSource(sourceId)
    if (source.discoveryState !== 'found' || this.activeScans.has(sourceId)) return this.stateView()

    const scan: DiscoveryScan = {
      scanId: randomUUID(),
      sourceId,
      status: 'in_progress',
      totalFiles: 0,
      processedFiles: 0,
      totalBytes: 0,
      processedBytes: 0,
      invalidFiles: 0,
      startedAt: now()
    }
    source.scanState = 'scanning'
    source.errorMessage = undefined
    this.addScan(scan)
    const operation: ActiveScan = { scanId: scan.scanId, controller: new AbortController() }
    this.activeScans.set(sourceId, operation)
    const started = this.persistAndEmit()
    operation.task = started.then(async () => {
      this.emitSourceConversationCatalog()
      await this.performScan(source, scan, operation.controller.signal)
    })
    await started
    return this.stateView()
  }

  async cancelScan(scanId: string): Promise<DiscoveryStateView> {
    const entry = [...this.activeScans.values()].find((operation) => operation.scanId === scanId)
    const scan = this.state.scans.find((candidate) => candidate.scanId === scanId)
    if (!entry || !scan) return this.stateView()
    scan.status = 'cancelled'
    scan.completedAt = now()
    entry.controller.abort()
    await this.persistAndEmit()
    return this.stateView()
  }

  async waitForIdle(sourceId?: string): Promise<void> {
    const tasks = [...this.activeScans.entries()]
      .filter(([id]) => !sourceId || id === sourceId)
      .map(([, operation]) => operation.task)
      .filter((task): task is Promise<void> => Boolean(task))
    await Promise.all(tasks)
  }

  private async performScan(source: AgentSource, scan: DiscoveryScan, signal: AbortSignal): Promise<void> {
    const adapter = this.requireAdapter(source.agentType)
    const previousRecords = this.currentRecords(source.id)
    const scannedRecords: SourceRecord[] = []
    let oldest: string | undefined
    let latest: string | undefined

    try {
      for await (const entry of adapter.scan(source.rootPath, signal, this.detectionContext)) {
        signal.throwIfAborted()
        scan.totalFiles += 1
        scan.processedFiles += 1
        const bytes = entry.kind === 'record' ? entry.candidate.sizeBytes : entry.sizeBytes
        scan.totalBytes += bytes
        scan.processedBytes += bytes
        if (entry.kind === 'invalid') {
          scan.invalidFiles += 1
        } else {
          const candidate = entry.candidate
          const id = sourceConversationId(source.id, candidate.kind, candidate.externalId)
          const existing = previousRecords.find((record) => record.id === id)
          const record = sourceRecord(source.id, candidate, existing)
          scannedRecords.push(record)

          if (candidate.kind === 'conversation') {
            const conversationDate = candidate.startedAt || candidate.modifiedAt
            if (!oldest || conversationDate < oldest) oldest = conversationDate
            if (!latest || conversationDate > latest) latest = conversationDate
          }
        }
        if (scan.processedFiles % 25 === 0) this.emit()
      }

      this.state.records = [
        ...this.state.records.filter((record) => record.sourceId !== source.id),
        ...scannedRecords
      ]
      const currentRecords = scannedRecords
      source.fileCount = scan.totalFiles
      source.conversationCount = currentRecords.filter((record) => record.kind === 'conversation').length
      source.instructionFileCount = currentRecords.filter(
        (record) => record.kind === 'human_instruction'
      ).length
      source.totalBytes = currentRecords.reduce((total, record) => total + record.sizeBytes, 0)
      source.invalidFileCount = scan.invalidFiles
      source.oldestConversationAt = oldest
      source.latestConversationAt = latest
      source.lastScannedAt = now()
      source.scanState = 'ready'
      source.errorMessage = undefined
      scan.status = 'completed'
      scan.completedAt = now()
    } catch (error) {
      const cancelled = signal.aborted || isAbortError(error)
      scan.status = cancelled ? 'cancelled' : 'failed'
      scan.completedAt = now()
      scan.errorMessage = cancelled ? undefined : errorMessage(error)
      source.scanState = cancelled ? 'idle' : 'error'
      source.errorMessage = cancelled ? undefined : errorMessage(error)
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EACCES' || code === 'EPERM') source.discoveryState = 'needs_permission'
    } finally {
      this.activeScans.delete(source.id)
      await this.persistAndEmit()
      this.emitSourceConversationCatalog()
    }
  }

  private currentRecords(sourceId: string): SourceRecord[] {
    return this.state.records.filter((record) => record.sourceId === sourceId)
  }

  private addScan(scan: DiscoveryScan): void {
    this.state.scans.unshift(scan)
    if (this.state.scans.length > 60) this.state.scans.length = 60
  }

  private requireSource(sourceId: string): AgentSource {
    const source = this.state.sources.find((candidate) => candidate.id === sourceId)
    if (!source) throw new Error(`Unknown agent source: ${sourceId}`)
    return source
  }

  private requireAdapter(agentType: AgentType): AgentHistoryAdapter {
    const adapter = this.adapterByType.get(agentType)
    if (!adapter) throw new Error(`No history adapter registered for ${agentType}`)
    return adapter
  }

  private async persist(): Promise<void> {
    await this.repository.save(this.state)
  }

  private async persistAndEmit(): Promise<void> {
    await this.persist()
    this.emit()
  }

  private emit(): void {
    const state = this.stateView()
    for (const listener of this.listeners) listener(state)
  }

  private emitSourceConversationCatalog(): void {
    const state = this.sourceConversationCatalogView()
    for (const listener of this.sourceConversationCatalogListeners) listener(state)
  }
}

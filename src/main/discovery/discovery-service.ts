import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import type {
  AgentSource,
  AgentType,
  AvailableSessionSummary,
  DiscoverySnapshot,
  ScanRun,
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
  SourceSessionRevisionChangedError,
  SourceSessionUnavailableError,
  type SourceEvidenceReader,
  type SourceEvidenceReadResult
} from './source-evidence-reader'
import type { ObservationView } from '../observation/model'

type SnapshotListener = (snapshot: DiscoverySnapshot) => void

interface ActiveOperation {
  runId: string
  controller: AbortController
  task?: Promise<void>
}

interface DiscoveryServiceOptions {
  recoverInterruptedRuns?: boolean
}

export interface ReadAvailableSessionInput {
  sourceRecordId: string
  expectedRevision: string
}

export interface AvailableSessionEvidence {
  sourceRecordId: string
  revision: string
  contentHash: string
  sizeBytes: number
  observationView: ObservationView
}

interface RefreshedConversationRecord {
  record?: SourceRecord
  grew: boolean
}

function now(): string {
  return new Date().toISOString()
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function fingerprint(sourceId: string, candidate: SourceRecordCandidate): string {
  return createHash('sha256')
    .update(`${sourceId}\0${candidate.externalId}\0${candidate.sizeBytes}\0${candidate.modifiedAt}`)
    .digest('hex')
}

function sourceRecordId(sourceId: string, kind: SourceRecordKind, externalId: string): string {
  const key = kind === 'conversation' ? `${sourceId}\0${externalId}` : `${sourceId}\0${kind}\0${externalId}`
  return createHash('sha256').update(key).digest('hex').slice(0, 32)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.message.includes('aborted'))
}

function sessionSummary(
  record: SourceRecord,
  source: AgentSource
): AvailableSessionSummary {
  return {
    sourceRecordId: record.id,
    sourceId: source.id,
    agentType: source.agentType,
    sourceDisplayName: source.displayName,
    externalId: record.externalId,
    title: record.title,
    projectPath: record.projectPath,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    updatedAt: record.updatedAt,
    sizeBytes: record.sizeBytes,
    revision: record.fingerprint
  }
}

function sourceRecord(
  sourceId: string,
  candidate: SourceRecordCandidate,
  existing?: SourceRecord
): SourceRecord {
  const nextFingerprint = fingerprint(sourceId, candidate)
  return {
    id: sourceRecordId(sourceId, candidate.kind, candidate.externalId),
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
      ?? (existing?.fingerprint === nextFingerprint ? existing.endedAt : undefined),
    updatedAt: candidate.updatedAt,
    sizeBytes: candidate.sizeBytes,
    modifiedAt: candidate.modifiedAt,
    fingerprint: nextFingerprint
  }
}

function assertSessionReference(input: { sourceRecordId: string; expectedRevision: string }): void {
  if (
    typeof input.sourceRecordId !== 'string'
    || input.sourceRecordId.length === 0
    || input.sourceRecordId.length > 256
  ) {
    throw new Error('Invalid Session source record ID')
  }
  if (!/^[a-f0-9]{64}$/i.test(input.expectedRevision)) {
    throw new Error('Invalid Session revision')
  }
}

export class DiscoveryService {
  private state: DiscoveryStateData = { sources: [], records: [], runs: [] }
  private readonly listeners = new Set<SnapshotListener>()
  private readonly activeOperations = new Map<string, ActiveOperation>()
  private readonly adapterByType = new Map<AgentType, AgentHistoryAdapter>()
  private detectionContext: DetectionContext
  private sessionCatalogVersion = 0

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

  async initialize(): Promise<DiscoverySnapshot> {
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
        sessionCount: 0,
        instructionFileCount: 0,
        totalBytes: 0,
        invalidFileCount: 0
      })
    }

    for (const source of this.state.sources) source.instructionFileCount ??= 0

    if (this.options.recoverInterruptedRuns !== false) {
      for (const run of this.state.runs) {
        if (run.state !== 'running' && run.state !== 'queued') continue
        run.state = 'interrupted'
        run.finishedAt = stamp
        run.errorMessage = '应用在任务完成前退出'
      }
      for (const source of this.state.sources) {
        if (source.scanState === 'scanning') source.scanState = 'idle'
      }
    }

    await this.persist()
    return this.snapshot()
  }

  snapshot(): DiscoverySnapshot {
    const sourceOrder = new Map(AGENT_TYPES.map((type, index) => [type, index]))
    return clone({
      sources: [...this.state.sources].sort(
        (left, right) => (sourceOrder.get(left.agentType) ?? 99) - (sourceOrder.get(right.agentType) ?? 99)
      ),
      runs: [...this.state.runs]
        .sort((left, right) => (right.startedAt || '').localeCompare(left.startedAt || ''))
        .slice(0, 30),
      sessionCatalogVersion: this.sessionCatalogVersion
    })
  }

  listAvailableSessions(): AvailableSessionSummary[] {
    return this.state.records
      .filter((record) => record.kind === 'conversation')
      .flatMap<AvailableSessionSummary>((record) => {
        const source = this.state.sources.find((candidate) => candidate.id === record.sourceId)
        if (!source || source.discoveryState !== 'found') return []
        return [sessionSummary(record, source)]
      })
      .sort((left, right) => {
        const leftDate = left.endedAt || left.updatedAt || left.startedAt || ''
        const rightDate = right.endedAt || right.updatedAt || right.startedAt || ''
        return rightDate.localeCompare(leftDate) || left.sourceRecordId.localeCompare(right.sourceRecordId)
      })
      .map((session) => clone(session))
  }

  async readAvailableSession(
    input: ReadAvailableSessionInput,
    maxBytes?: number
  ): Promise<AvailableSessionEvidence> {
    assertSessionReference(input)
    const record = this.state.records.find((candidate) => candidate.id === input.sourceRecordId)
    if (!record || record.kind !== 'conversation') {
      throw new SourceSessionUnavailableError()
    }
    if (record.fingerprint !== input.expectedRevision) {
      throw new SourceSessionRevisionChangedError()
    }
    const source = this.state.sources.find((candidate) => candidate.id === record.sourceId)
    if (!source) throw new SourceSessionUnavailableError()
    const adapter = this.requireAdapter(source.agentType)
    let currentRecord = record
    let evidence: SourceEvidenceReadResult
    try {
      evidence = await this.readRecordEvidence(source, adapter, currentRecord, maxBytes)
    } catch (error) {
      if (
        !(error instanceof SourceSessionUnavailableError)
        && !(error instanceof SourceSessionRevisionChangedError)
      ) {
        throw error
      }

      const refreshed = await this.refreshConversationRecord(source, adapter, currentRecord)
      if (!refreshed.record) throw new SourceSessionUnavailableError()
      currentRecord = refreshed.record
      if (currentRecord.fingerprint !== input.expectedRevision) {
        throw new SourceSessionRevisionChangedError(
          refreshed.grew
            ? 'The source Session has grown since it was selected; retry with the refreshed Session revision'
            : 'The source Session revision has changed'
        )
      }
      evidence = await this.readRecordEvidence(source, adapter, currentRecord, maxBytes)
    }
    const content = new TextDecoder('utf-8', { fatal: true }).decode(evidence.content)
    return {
      sourceRecordId: currentRecord.id,
      revision: currentRecord.fingerprint,
      contentHash: evidence.contentHash,
      sizeBytes: evidence.sizeBytes,
      observationView: adapter.createObservationView(content)
    }
  }

  private readRecordEvidence(
    source: AgentSource,
    adapter: AgentHistoryAdapter,
    record: SourceRecord,
    maxBytes?: number
  ): Promise<SourceEvidenceReadResult> {
    return this.sourceEvidenceReader.read({
      sourceRecordId: record.id,
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
      this.sessionCatalogVersion++
      await this.persistAndEmit()
      return { grew: false }
    }
    if (candidate.kind !== 'conversation' || candidate.externalId !== previous.externalId) {
      throw new Error(`History adapter returned the wrong Session while refreshing ${previous.externalId}`)
    }

    const previousSizeBytes = current?.sizeBytes ?? previous.sizeBytes
    const next = sourceRecord(source.id, candidate, current)
    if (next.id !== previous.id) {
      throw new Error(`History adapter changed the stable Session identity for ${previous.externalId}`)
    }
    if (current) Object.assign(current, next)
    else this.state.records.push(next)
    this.updateSourceRecordSummary(source)
    this.sessionCatalogVersion++
    await this.persistAndEmit()
    return {
      record: current ?? next,
      grew: next.sizeBytes > previousSizeBytes
    }
  }

  private updateSourceRecordSummary(source: AgentSource): void {
    const records = this.currentRecords(source.id)
    const conversations = records.filter((record) => record.kind === 'conversation')
    source.fileCount = records.length + source.invalidFileCount
    source.sessionCount = conversations.length
    source.instructionFileCount = records.length - conversations.length
    source.totalBytes = records.reduce((total, record) => total + record.sizeBytes, 0)
    const dates = conversations
      .map((record) => record.startedAt || record.modifiedAt)
      .sort()
    source.oldestSessionAt = dates[0]
    source.latestSessionAt = dates.at(-1)
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async detectAgents(): Promise<DiscoverySnapshot> {
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

    for (const source of this.state.sources) {
      if (source.discoveryState === 'found' && !this.activeOperations.has(source.id)) {
        await this.scanSource(source.id)
      }
    }
    return this.snapshot()
  }

  async setSourceRoot(sourceId: string, rootPath: string): Promise<DiscoverySnapshot> {
    const source = this.requireSource(sourceId)
    if (this.activeOperations.has(sourceId)) return this.snapshot()
    const adapter = this.requireAdapter(source.agentType)
    source.rootPath = rootPath
    source.scanState = 'idle'
    source.fileCount = 0
    source.sessionCount = 0
    source.instructionFileCount = 0
    source.totalBytes = 0
    source.invalidFileCount = 0
    source.oldestSessionAt = undefined
    source.latestSessionAt = undefined
    source.lastScannedAt = undefined
    const previousRecordCount = this.state.records.length
    this.state.records = this.state.records.filter((record) => record.sourceId !== sourceId)
    if (this.state.records.length !== previousRecordCount) this.sessionCatalogVersion++

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
    return this.snapshot()
  }

  async scanSource(sourceId: string): Promise<DiscoverySnapshot> {
    const source = this.requireSource(sourceId)
    if (source.discoveryState !== 'found' || this.activeOperations.has(sourceId)) return this.snapshot()

    const run: ScanRun = {
      id: randomUUID(),
      sourceId,
      state: 'running',
      totalFiles: 0,
      processedFiles: 0,
      totalBytes: 0,
      processedBytes: 0,
      invalidFiles: 0,
      startedAt: now()
    }
    source.scanState = 'scanning'
    source.errorMessage = undefined
    this.addRun(run)
    const operation: ActiveOperation = { runId: run.id, controller: new AbortController() }
    this.activeOperations.set(sourceId, operation)
    await this.persistAndEmit()
    operation.task = this.performScan(source, run, operation.controller.signal)
    return this.snapshot()
  }

  async cancelRun(runId: string): Promise<DiscoverySnapshot> {
    const entry = [...this.activeOperations.values()].find((operation) => operation.runId === runId)
    const run = this.state.runs.find((candidate) => candidate.id === runId)
    if (!entry || !run) return this.snapshot()
    run.state = 'cancelled'
    run.finishedAt = now()
    entry.controller.abort()
    await this.persistAndEmit()
    return this.snapshot()
  }

  async waitForIdle(sourceId?: string): Promise<void> {
    const tasks = [...this.activeOperations.entries()]
      .filter(([id]) => !sourceId || id === sourceId)
      .map(([, operation]) => operation.task)
      .filter((task): task is Promise<void> => Boolean(task))
    await Promise.all(tasks)
  }

  private async performScan(source: AgentSource, run: ScanRun, signal: AbortSignal): Promise<void> {
    const adapter = this.requireAdapter(source.agentType)
    const observed = new Set<string>()
    let oldest: string | undefined
    let latest: string | undefined

    try {
      for await (const entry of adapter.scan(source.rootPath, signal, this.detectionContext)) {
        signal.throwIfAborted()
        run.totalFiles += 1
        run.processedFiles += 1
        const bytes = entry.kind === 'record' ? entry.candidate.sizeBytes : entry.sizeBytes
        run.totalBytes += bytes
        run.processedBytes += bytes
        if (entry.kind === 'invalid') {
          run.invalidFiles += 1
        } else {
          const candidate = entry.candidate
          const id = sourceRecordId(source.id, candidate.kind, candidate.externalId)
          observed.add(id)
          const existing = this.state.records.find((record) => record.id === id)
          const record = sourceRecord(source.id, candidate, existing)
          if (existing) Object.assign(existing, record)
          else this.state.records.push(record)

          if (candidate.kind === 'conversation') {
            const sessionDate = candidate.startedAt || candidate.modifiedAt
            if (!oldest || sessionDate < oldest) oldest = sessionDate
            if (!latest || sessionDate > latest) latest = sessionDate
          }
        }
        if (run.processedFiles % 25 === 0) this.emit()
      }

      this.state.records = this.state.records.filter(
        (record) => record.sourceId !== source.id || observed.has(record.id)
      )
      const currentRecords = this.currentRecords(source.id)
      source.fileCount = run.totalFiles
      source.sessionCount = currentRecords.filter((record) => record.kind === 'conversation').length
      source.instructionFileCount = currentRecords.filter(
        (record) => record.kind === 'human_instruction'
      ).length
      source.totalBytes = currentRecords.reduce((total, record) => total + record.sizeBytes, 0)
      source.invalidFileCount = run.invalidFiles
      source.oldestSessionAt = oldest
      source.latestSessionAt = latest
      source.lastScannedAt = now()
      source.scanState = 'ready'
      source.errorMessage = undefined
      run.state = 'completed'
      run.finishedAt = now()
      this.sessionCatalogVersion++
    } catch (error) {
      const cancelled = signal.aborted || isAbortError(error)
      run.state = cancelled ? 'cancelled' : 'failed'
      run.finishedAt = now()
      run.errorMessage = cancelled ? undefined : errorMessage(error)
      source.scanState = cancelled ? 'idle' : 'error'
      source.errorMessage = cancelled ? undefined : errorMessage(error)
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EACCES' || code === 'EPERM') source.discoveryState = 'needs_permission'
    } finally {
      this.activeOperations.delete(source.id)
      await this.persistAndEmit()
    }
  }

  private currentRecords(sourceId: string): SourceRecord[] {
    return this.state.records.filter((record) => record.sourceId === sourceId)
  }

  private addRun(run: ScanRun): void {
    this.state.runs.unshift(run)
    if (this.state.runs.length > 60) this.state.runs.length = 60
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
    const snapshot = this.snapshot()
    for (const listener of this.listeners) listener(snapshot)
  }
}

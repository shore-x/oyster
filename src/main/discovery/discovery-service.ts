import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import type {
  AgentSource,
  AgentType,
  ArtifactKind,
  AvailableSessionSummary,
  DiscoverySnapshot,
  HistoryArtifact,
  ScanRun
} from '../../shared/discovery'
import { AGENT_TYPES } from '../../shared/discovery'
import { createDetectionContext } from './adapters'
import type {
  AgentHistoryAdapter,
  DetectionContext,
  DiscoveryRepository,
  DiscoveryStateData,
  ArtifactCandidate
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
  artifactId: string
  expectedRevision: string
}

export interface AvailableSessionEvidence {
  artifactId: string
  revision: string
  contentHash: string
  sizeBytes: number
  observationView: ObservationView
}

interface RefreshedConversationArtifact {
  artifact?: HistoryArtifact
  grew: boolean
}

function now(): string {
  return new Date().toISOString()
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function fingerprint(sourceId: string, candidate: ArtifactCandidate): string {
  return createHash('sha256')
    .update(`${sourceId}\0${candidate.externalId}\0${candidate.sizeBytes}\0${candidate.modifiedAt}`)
    .digest('hex')
}

function artifactId(sourceId: string, kind: ArtifactKind, externalId: string): string {
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
  artifact: HistoryArtifact,
  source: AgentSource
): AvailableSessionSummary {
  return {
    artifactId: artifact.id,
    sourceId: source.id,
    agentType: source.agentType,
    sourceDisplayName: source.displayName,
    externalId: artifact.externalId,
    title: artifact.title,
    projectPath: artifact.projectPath,
    startedAt: artifact.startedAt,
    endedAt: artifact.endedAt,
    updatedAt: artifact.updatedAt,
    sizeBytes: artifact.sizeBytes,
    revision: artifact.fingerprint
  }
}

function historyArtifact(
  sourceId: string,
  candidate: ArtifactCandidate,
  existing?: HistoryArtifact
): HistoryArtifact {
  const nextFingerprint = fingerprint(sourceId, candidate)
  return {
    id: artifactId(sourceId, candidate.kind, candidate.externalId),
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

function assertSessionReference(input: { artifactId: string; expectedRevision: string }): void {
  if (typeof input.artifactId !== 'string' || input.artifactId.length === 0 || input.artifactId.length > 256) {
    throw new Error('Invalid Session artifact ID')
  }
  if (!/^[a-f0-9]{64}$/i.test(input.expectedRevision)) {
    throw new Error('Invalid Session revision')
  }
}

export class DiscoveryService {
  private state: DiscoveryStateData = { sources: [], artifacts: [], runs: [] }
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
    return this.state.artifacts
      .filter((artifact) => artifact.kind === 'conversation')
      .flatMap<AvailableSessionSummary>((artifact) => {
        const source = this.state.sources.find((candidate) => candidate.id === artifact.sourceId)
        if (!source || source.discoveryState !== 'found') return []
        return [sessionSummary(artifact, source)]
      })
      .sort((left, right) => {
        const leftDate = left.endedAt || left.updatedAt || left.startedAt || ''
        const rightDate = right.endedAt || right.updatedAt || right.startedAt || ''
        return rightDate.localeCompare(leftDate) || left.artifactId.localeCompare(right.artifactId)
      })
      .map((session) => clone(session))
  }

  async readAvailableSession(
    input: ReadAvailableSessionInput,
    maxBytes?: number
  ): Promise<AvailableSessionEvidence> {
    assertSessionReference(input)
    const artifact = this.state.artifacts.find((candidate) => candidate.id === input.artifactId)
    if (!artifact || artifact.kind !== 'conversation') {
      throw new SourceSessionUnavailableError()
    }
    if (artifact.fingerprint !== input.expectedRevision) {
      throw new SourceSessionRevisionChangedError()
    }
    const source = this.state.sources.find((candidate) => candidate.id === artifact.sourceId)
    if (!source) throw new SourceSessionUnavailableError()
    const adapter = this.requireAdapter(source.agentType)
    let currentArtifact = artifact
    let evidence: SourceEvidenceReadResult
    try {
      evidence = await this.readArtifactEvidence(source, adapter, currentArtifact, maxBytes)
    } catch (error) {
      if (
        !(error instanceof SourceSessionUnavailableError)
        && !(error instanceof SourceSessionRevisionChangedError)
      ) {
        throw error
      }

      const refreshed = await this.refreshConversationArtifact(source, adapter, currentArtifact)
      if (!refreshed.artifact) throw new SourceSessionUnavailableError()
      currentArtifact = refreshed.artifact
      if (currentArtifact.fingerprint !== input.expectedRevision) {
        throw new SourceSessionRevisionChangedError(
          refreshed.grew
            ? 'The source Session has grown since it was selected; retry with the refreshed Session revision'
            : 'The source Session revision has changed'
        )
      }
      evidence = await this.readArtifactEvidence(source, adapter, currentArtifact, maxBytes)
    }
    const content = new TextDecoder('utf-8', { fatal: true }).decode(evidence.content)
    return {
      artifactId: currentArtifact.id,
      revision: currentArtifact.fingerprint,
      contentHash: evidence.contentHash,
      sizeBytes: evidence.sizeBytes,
      observationView: adapter.createObservationView(content)
    }
  }

  private readArtifactEvidence(
    source: AgentSource,
    adapter: AgentHistoryAdapter,
    artifact: HistoryArtifact,
    maxBytes?: number
  ): Promise<SourceEvidenceReadResult> {
    return this.sourceEvidenceReader.read({
      artifactId: artifact.id,
      absolutePath: adapter.resolveArtifactPath(source.rootPath, artifact),
      expectedSizeBytes: artifact.sizeBytes,
      expectedModifiedAt: artifact.modifiedAt,
      ...(maxBytes === undefined ? {} : { maxBytes })
    })
  }

  private async refreshConversationArtifact(
    source: AgentSource,
    adapter: AgentHistoryAdapter,
    previous: HistoryArtifact
  ): Promise<RefreshedConversationArtifact> {
    const candidate = await adapter.refreshConversation(
      source.rootPath,
      clone(previous),
      new AbortController().signal,
      this.detectionContext
    )
    const current = this.state.artifacts.find((artifact) => artifact.id === previous.id)
    if (!candidate) {
      this.state.artifacts = this.state.artifacts.filter((artifact) => artifact.id !== previous.id)
      this.updateSourceArtifactSummary(source)
      this.sessionCatalogVersion++
      await this.persistAndEmit()
      return { grew: false }
    }
    if (candidate.kind !== 'conversation' || candidate.externalId !== previous.externalId) {
      throw new Error(`History adapter returned the wrong Session while refreshing ${previous.externalId}`)
    }

    const previousSizeBytes = current?.sizeBytes ?? previous.sizeBytes
    const next = historyArtifact(source.id, candidate, current)
    if (next.id !== previous.id) {
      throw new Error(`History adapter changed the stable Session identity for ${previous.externalId}`)
    }
    if (current) Object.assign(current, next)
    else this.state.artifacts.push(next)
    this.updateSourceArtifactSummary(source)
    this.sessionCatalogVersion++
    await this.persistAndEmit()
    return {
      artifact: current ?? next,
      grew: next.sizeBytes > previousSizeBytes
    }
  }

  private updateSourceArtifactSummary(source: AgentSource): void {
    const artifacts = this.currentArtifacts(source.id)
    const conversations = artifacts.filter((artifact) => artifact.kind === 'conversation')
    source.fileCount = artifacts.length + source.invalidFileCount
    source.sessionCount = conversations.length
    source.instructionFileCount = artifacts.length - conversations.length
    source.totalBytes = artifacts.reduce((total, artifact) => total + artifact.sizeBytes, 0)
    const dates = conversations
      .map((artifact) => artifact.startedAt || artifact.modifiedAt)
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
    const previousArtifactCount = this.state.artifacts.length
    this.state.artifacts = this.state.artifacts.filter((artifact) => artifact.sourceId !== sourceId)
    if (this.state.artifacts.length !== previousArtifactCount) this.sessionCatalogVersion++

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
        const bytes = entry.kind === 'artifact' ? entry.candidate.sizeBytes : entry.sizeBytes
        run.totalBytes += bytes
        run.processedBytes += bytes
        if (entry.kind === 'invalid') {
          run.invalidFiles += 1
        } else {
          const candidate = entry.candidate
          const id = artifactId(source.id, candidate.kind, candidate.externalId)
          observed.add(id)
          const existing = this.state.artifacts.find((artifact) => artifact.id === id)
          const artifact = historyArtifact(source.id, candidate, existing)
          if (existing) Object.assign(existing, artifact)
          else this.state.artifacts.push(artifact)

          if (candidate.kind === 'conversation') {
            const sessionDate = candidate.startedAt || candidate.modifiedAt
            if (!oldest || sessionDate < oldest) oldest = sessionDate
            if (!latest || sessionDate > latest) latest = sessionDate
          }
        }
        if (run.processedFiles % 25 === 0) this.emit()
      }

      this.state.artifacts = this.state.artifacts.filter(
        (artifact) => artifact.sourceId !== source.id || observed.has(artifact.id)
      )
      const currentArtifacts = this.currentArtifacts(source.id)
      source.fileCount = run.totalFiles
      source.sessionCount = currentArtifacts.filter((artifact) => artifact.kind === 'conversation').length
      source.instructionFileCount = currentArtifacts.filter(
        (artifact) => artifact.kind === 'human_instruction'
      ).length
      source.totalBytes = currentArtifacts.reduce((total, artifact) => total + artifact.sizeBytes, 0)
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

  private currentArtifacts(sourceId: string): HistoryArtifact[] {
    return this.state.artifacts.filter((artifact) => artifact.sourceId === sourceId)
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

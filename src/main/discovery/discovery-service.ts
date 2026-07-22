import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import type {
  AgentSource,
  AgentType,
  DiscoverySnapshot,
  HistorySession,
  SyncRun
} from '../../shared/discovery'
import { AGENT_TYPES } from '../../shared/discovery'
import { createDetectionContext } from './adapters'
import type {
  AgentHistoryAdapter,
  DetectionContext,
  DiscoveryRepository,
  DiscoveryStateData,
  RawEvidenceStore,
  SessionCandidate
} from './model'

type SnapshotListener = (snapshot: DiscoverySnapshot) => void

interface ActiveOperation {
  runId: string
  controller: AbortController
  task?: Promise<void>
}

interface DiscoveryServiceOptions {
  recoverInterruptedRuns?: boolean
}

function now(): string {
  return new Date().toISOString()
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function fingerprint(sourceId: string, candidate: SessionCandidate): string {
  return createHash('sha256')
    .update(`${sourceId}\0${candidate.externalId}\0${candidate.sizeBytes}\0${candidate.modifiedAt}`)
    .digest('hex')
}

function sessionId(sourceId: string, externalId: string): string {
  return createHash('sha256').update(`${sourceId}\0${externalId}`).digest('hex').slice(0, 32)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.message.includes('aborted'))
}

export class DiscoveryService {
  private state: DiscoveryStateData = { sources: [], sessions: [], runs: [] }
  private readonly listeners = new Set<SnapshotListener>()
  private readonly activeOperations = new Map<string, ActiveOperation>()
  private readonly adapterByType = new Map<AgentType, AgentHistoryAdapter>()
  private detectionContext: DetectionContext

  constructor(
    private readonly repository: DiscoveryRepository,
    private readonly rawEvidenceStore: RawEvidenceStore,
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
        totalBytes: 0,
        invalidFileCount: 0,
        syncedBytes: 0,
        syncedSessionCount: 0
      })
    }

    if (this.options.recoverInterruptedRuns !== false) {
      for (const run of this.state.runs) {
        if (run.state !== 'running' && run.state !== 'queued') continue
        run.state = 'interrupted'
        run.finishedAt = stamp
        run.errorMessage = '应用在任务完成前退出'
      }
      for (const session of this.state.sessions) {
        if (session.syncState === 'syncing') session.syncState = 'pending'
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
        .slice(0, 30)
    })
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
    source.totalBytes = 0
    source.invalidFileCount = 0
    source.syncedBytes = 0
    source.syncedSessionCount = 0
    source.oldestSessionAt = undefined
    source.latestSessionAt = undefined
    source.lastScannedAt = undefined
    source.lastSyncedAt = undefined
    this.state.sessions = this.state.sessions.filter((session) => session.sourceId !== sourceId)

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

    const run: SyncRun = {
      id: randomUUID(),
      sourceId,
      kind: 'scan',
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

  async importSource(sourceId: string): Promise<DiscoverySnapshot> {
    const source = this.requireSource(sourceId)
    if (source.scanState !== 'ready' || this.activeOperations.has(sourceId)) return this.snapshot()
    const sessions = this.state.sessions.filter(
      (session) =>
        session.sourceId === sourceId &&
        session.syncState !== 'missing' &&
        session.syncedFingerprint !== session.fingerprint
    )
    const run: SyncRun = {
      id: randomUUID(),
      sourceId,
      kind: 'import',
      state: 'running',
      totalFiles: sessions.length,
      processedFiles: 0,
      totalBytes: sessions.reduce((total, session) => total + session.sizeBytes, 0),
      processedBytes: 0,
      invalidFiles: 0,
      startedAt: now()
    }
    this.addRun(run)
    const operation: ActiveOperation = { runId: run.id, controller: new AbortController() }
    this.activeOperations.set(sourceId, operation)
    await this.persistAndEmit()
    operation.task = this.performImport(source, run, sessions, operation.controller.signal)
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

  private async performScan(source: AgentSource, run: SyncRun, signal: AbortSignal): Promise<void> {
    const adapter = this.requireAdapter(source.agentType)
    const observed = new Set<string>()
    let oldest: string | undefined
    let latest: string | undefined

    try {
      for await (const entry of adapter.scan(source.rootPath, signal)) {
        signal.throwIfAborted()
        run.totalFiles += 1
        run.processedFiles += 1
        const bytes = entry.kind === 'session' ? entry.candidate.sizeBytes : entry.sizeBytes
        run.totalBytes += bytes
        run.processedBytes += bytes
        if (entry.kind === 'invalid') {
          run.invalidFiles += 1
        } else {
          const candidate = entry.candidate
          const id = sessionId(source.id, candidate.externalId)
          observed.add(id)
          const nextFingerprint = fingerprint(source.id, candidate)
          const existing = this.state.sessions.find((session) => session.id === id)
          const nextState =
            existing?.syncedFingerprint === nextFingerprint ? ('synced' as const) : ('pending' as const)
          const session: HistorySession = {
            id,
            sourceId: source.id,
            externalId: candidate.externalId,
            relativePath: candidate.relativePath,
            title: candidate.title,
            projectPath: candidate.projectPath,
            startedAt: candidate.startedAt,
            updatedAt: candidate.updatedAt,
            sizeBytes: candidate.sizeBytes,
            modifiedAt: candidate.modifiedAt,
            fingerprint: nextFingerprint,
            syncState: nextState,
            rawEvidenceId: nextState === 'synced' ? existing?.rawEvidenceId : undefined,
            syncedFingerprint: existing?.syncedFingerprint,
            errorMessage: undefined
          }
          if (existing) Object.assign(existing, session)
          else this.state.sessions.push(session)

          const sessionDate = candidate.startedAt || candidate.modifiedAt
          if (!oldest || sessionDate < oldest) oldest = sessionDate
          if (!latest || sessionDate > latest) latest = sessionDate
        }
        if (run.processedFiles % 25 === 0) this.emit()
      }

      for (const session of this.state.sessions) {
        if (session.sourceId === source.id && !observed.has(session.id)) session.syncState = 'missing'
      }
      const currentSessions = this.currentSessions(source.id)
      source.fileCount = run.totalFiles
      source.sessionCount = currentSessions.length
      source.totalBytes = currentSessions.reduce((total, session) => total + session.sizeBytes, 0)
      source.invalidFileCount = run.invalidFiles
      source.oldestSessionAt = oldest
      source.latestSessionAt = latest
      source.lastScannedAt = now()
      source.scanState = 'ready'
      source.errorMessage = undefined
      this.recalculateSync(source)
      run.state = 'completed'
      run.finishedAt = now()
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

  private async performImport(
    source: AgentSource,
    run: SyncRun,
    sessions: HistorySession[],
    signal: AbortSignal
  ): Promise<void> {
    const adapter = this.requireAdapter(source.agentType)
    let failures = 0
    let activeSession: HistorySession | undefined

    try {
      for (const session of sessions) {
        signal.throwIfAborted()
        activeSession = session
        session.syncState = 'syncing'
        this.emit()
        let sessionProgress = 0
        try {
          const rawEvidenceId = await this.rawEvidenceStore.importFile({
            sourceId: source.id,
            sessionId: session.id,
            absolutePath: adapter.resolveSessionPath(source.rootPath, session.relativePath),
            fingerprint: session.fingerprint,
            signal,
            onProgress: (bytes) => {
              const acceptedBytes = Math.max(0, Math.min(bytes, session.sizeBytes - sessionProgress))
              sessionProgress += acceptedBytes
              run.processedBytes += acceptedBytes
              this.emit()
            }
          })
          session.rawEvidenceId = rawEvidenceId
          session.syncedFingerprint = session.fingerprint
          session.syncState = 'synced'
          session.errorMessage = undefined
        } catch (error) {
          if (signal.aborted || isAbortError(error)) throw error
          failures += 1
          session.syncState = 'failed'
          session.errorMessage = errorMessage(error)
        }
        run.processedBytes += Math.max(0, session.sizeBytes - sessionProgress)
        activeSession = undefined
        run.processedFiles += 1
        this.recalculateSync(source)
        await this.persistAndEmit()
      }

      run.state = failures > 0 ? 'failed' : 'completed'
      run.errorMessage = failures > 0 ? `${failures} 个会话导入失败` : undefined
      run.finishedAt = now()
      source.lastSyncedAt = now()
    } catch (error) {
      const cancelled = signal.aborted || isAbortError(error)
      if (activeSession?.syncState === 'syncing') activeSession.syncState = 'pending'
      run.state = cancelled ? 'cancelled' : 'failed'
      run.finishedAt = now()
      run.errorMessage = cancelled ? undefined : errorMessage(error)
    } finally {
      this.recalculateSync(source)
      this.activeOperations.delete(source.id)
      await this.persistAndEmit()
    }
  }

  private currentSessions(sourceId: string): HistorySession[] {
    return this.state.sessions.filter(
      (session) => session.sourceId === sourceId && session.syncState !== 'missing'
    )
  }

  private recalculateSync(source: AgentSource): void {
    const sessions = this.currentSessions(source.id)
    const synced = sessions.filter(
      (session) => session.syncState === 'synced' && session.syncedFingerprint === session.fingerprint
    )
    source.syncedSessionCount = synced.length
    source.syncedBytes = synced.reduce((total, session) => total + session.sizeBytes, 0)
  }

  private addRun(run: SyncRun): void {
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

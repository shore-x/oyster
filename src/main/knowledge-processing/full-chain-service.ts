import { randomUUID } from 'node:crypto'
import type {
  ClearKnowledgeResult,
  KnowledgeCommitResult,
  KnowledgeContributionDraft
} from '../../shared/knowledge'
import type {
  KnowledgeFullChainRunRecord,
  KnowledgeFullChainRunSummary,
  KnowledgeFullChainResult,
  RunKnowledgeFullChainInput
} from '../../shared/knowledge-processing'
import type { AvailableSessionSummary } from '../../shared/discovery'
import type { DiscoveryService } from '../discovery/discovery-service'
import type { SqliteKnowledgeStoreManager } from '../knowledge-store/knowledge-store-manager'
import type { KnowledgeAgentRuntime, KnowledgeReader } from './model'
import {
  loadSessionMaterial,
  validateSessionSelection
} from './session'
import {
  KnowledgeProcessingService,
  type ProcessingDebugTraceContext,
  type ProcessingRunLease,
  type ProcessingStageRunBinding
} from './knowledge-processing-service'
import type { KnowledgeFullChainRunHistory } from './full-chain-run-repository'

export interface KnowledgeFullChainBindings {
  maintainer: ProcessingStageRunBinding
}

export type KnowledgeAgentFactory = (knowledgeReader: KnowledgeReader) => KnowledgeAgentRuntime

interface ActiveFullChainRun {
  runId: string
  controller: AbortController
  lease: ProcessingRunLease
  sandboxId?: string
}

function terminalStatus(signal: AbortSignal): 'failed' | 'cancelled' {
  return signal.aborted ? 'cancelled' : 'failed'
}

function terminalError(error: unknown, status: 'failed' | 'cancelled'): string {
  if (status === 'cancelled') return '加工测试运行已取消'
  return error instanceof Error ? error.message : String(error)
}

function validateInput(input: RunKnowledgeFullChainInput): void {
  validateSessionSelection(input)
  if (input.attention !== undefined && typeof input.attention !== 'string') {
    throw new Error('Attention 格式无效')
  }
}

function validateContribution(
  contribution: KnowledgeContributionDraft,
  expectedRunRef: string
): void {
  if (!contribution || contribution.runRef !== expectedRunRef || !Array.isArray(contribution.statements)) {
    throw new Error('Agent 返回的 Knowledge Contribution 与当前运行不匹配')
  }
}

/**
 * Runs the production processing path against one physically isolated Store.
 * The renderer can select a discovered Session, but never a source path, Store, or write payload.
 */
export class KnowledgeFullChainService {
  private active?: ActiveFullChainRun
  private readonly ownedSandboxes = new Set<string>()

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly processing: KnowledgeProcessingService,
    private readonly stores: SqliteKnowledgeStoreManager,
    private readonly knowledgeAgentFactory: KnowledgeAgentFactory,
    private readonly history?: KnowledgeFullChainRunHistory
  ) {}

  isRunning(): boolean {
    return Boolean(this.active)
  }

  async run(
    input: RunKnowledgeFullChainInput,
    bindings: KnowledgeFullChainBindings
  ): Promise<KnowledgeFullChainResult> {
    validateInput(input)
    if (this.active) throw new Error('完整链路正在运行')

    const lease = this.processing.acquireExclusiveRun()
    const runId = randomUUID()
    const debugTrace: ProcessingDebugTraceContext = { id: randomUUID(), origin: 'full_chain' }
    const controller = new AbortController()
    const active: ActiveFullChainRun = { runId, controller, lease }
    this.active = active
    const startedAt = Date.now()
    const startedAtIso = new Date(startedAt).toISOString()
    let sandboxId: string | undefined
    let session: AvailableSessionSummary | undefined
    let historySaveAttempted = false

    const saveHistory = (
      status: KnowledgeFullChainRunRecord['status'],
      completedAt: string,
      durationMs: number,
      result?: KnowledgeFullChainResult,
      error?: string
    ): void => {
      if (!this.history) return
      historySaveAttempted = true
      const agentRun = this.processing.agentRunSnapshot(debugTrace)
      this.history.save({
        formatVersion: 5,
        runId,
        status,
        startedAt: startedAtIso,
        completedAt,
        durationMs,
        input: structuredClone(input),
        ...(session ? { session: structuredClone(session) } : {}),
        configuration: {
          maintainer: structuredClone(bindings.maintainer)
        },
        agentRuns: agentRun ? [agentRun] : [],
        ...(result ? { result } : {}),
        ...(error ? { error } : {})
      })
    }

    try {
      const material = await loadSessionMaterial(this.discovery, input)
      session = material.session
      const { evidence, sourceRef } = material
      controller.signal.throwIfAborted()
      const sandbox = await this.stores.createSandbox()
      sandboxId = sandbox.id
      active.sandboxId = sandbox.id
      controller.signal.throwIfAborted()

      const contributionRunRef = `full-chain:${runId}`
      const maintenance = await this.processing.runKnowledgeMaintenance(
        evidence.rawEvidence,
        sourceRef,
        input.attention,
        {
        binding: structuredClone(bindings.maintainer),
        lease,
        knowledgeAgent: this.knowledgeAgentFactory(sandbox.store),
        contributionRunRef,
        debugTrace
        }
      )
      controller.signal.throwIfAborted()

      validateContribution(maintenance.contribution, contributionRunRef)
      controller.signal.throwIfAborted()
      const commit = sandbox.store.commit(maintenance.contribution)
      controller.signal.throwIfAborted()

      const statements = commit.statements.map((statement) => {
        const stored = sandbox.store.getStatement(statement.title)
        if (!stored) throw new Error(`已提交的 Knowledge Statement 无法回读：${statement.title}`)
        return stored
      })
      for (const previousSandboxId of [...this.ownedSandboxes]) {
        try {
          await this.stores.discardSandbox(previousSandboxId)
          this.ownedSandboxes.delete(previousSandboxId)
        } catch {
          // A stale disposable Sandbox must not turn a completed new run into a failure.
        }
      }
      controller.signal.throwIfAborted()
      const result: KnowledgeFullChainResult = {
        runId,
        session: structuredClone(session),
        sandbox: { id: sandbox.id, baselineCreatedAt: sandbox.baselineCreatedAt },
        sourceRef,
        maintenance,
        commit,
        knowledge: {
          writtenStatementTitles: commit.statements.map((statement) => statement.title),
          statements
        },
        durationMs: Date.now() - startedAt,
        completedAt: new Date().toISOString()
      }
      saveHistory('completed', result.completedAt, result.durationMs, result)
      this.ownedSandboxes.add(sandbox.id)
      return result
    } catch (error) {
      const status = terminalStatus(controller.signal)
      this.processing.failFullChainDebugTrace(
        debugTrace,
        status,
        error
      )
      if (sandboxId) {
        try {
          await this.stores.discardSandbox(sandboxId)
        } catch {
          // Preserve the processing failure/cancellation. Stale Sandboxes are cleaned on startup.
        }
      }
      if (!historySaveAttempted) {
        const completedAt = new Date().toISOString()
        saveHistory(
          status,
          completedAt,
          Math.max(0, new Date(completedAt).getTime() - startedAt),
          undefined,
          terminalError(error, status)
        )
      }
      throw error
    } finally {
      if (this.active === active) this.active = undefined
      this.processing.releaseExclusiveRun(lease)
    }
  }

  cancel(): void {
    const active = this.active
    if (!active) return
    active.controller.abort(new Error('用户取消了完整链路运行'))
    this.processing.cancelRun('knowledge_maintenance_agent')
  }

  async clearKnowledge(): Promise<ClearKnowledgeResult> {
    if (this.active) throw new Error('完整链路正在运行，不能清空知识')
    const lease = this.processing.acquireExclusiveRun()
    try {
      const result = this.stores.production.clear()
      for (const sandboxId of [...this.ownedSandboxes]) {
        try {
          await this.stores.discardSandbox(sandboxId)
        } catch {
          // Knowledge is already clear; stale disposable Sandboxes are cleaned on startup.
        } finally {
          this.ownedSandboxes.delete(sandboxId)
        }
      }
      return result
    } finally {
      this.processing.releaseExclusiveRun(lease)
    }
  }

  async discardSandbox(sandboxId: string): Promise<void> {
    if (this.active?.sandboxId === sandboxId) throw new Error('运行中的 Knowledge Sandbox 不能丢弃')
    if (!this.ownedSandboxes.has(sandboxId)) throw new Error('未找到当前会话创建的 Knowledge Sandbox')
    await this.stores.discardSandbox(sandboxId)
    this.ownedSandboxes.delete(sandboxId)
  }

  listRuns(): KnowledgeFullChainRunSummary[] {
    return this.history?.list() ?? []
  }

  readRun(runId: string): KnowledgeFullChainRunRecord | undefined {
    return this.history?.read(runId)
  }

  async importRun(runId: string): Promise<KnowledgeCommitResult> {
    if (this.active) throw new Error('完整链路正在运行，不能导入测试结果')
    const lease = this.processing.acquireExclusiveRun()
    try {
      const record = this.history?.read(runId)
      if (!record) throw new Error('未找到要导入的加工测试记录')
      if (record.status !== 'completed' || !record.result) {
        throw new Error('只有成功完成的加工测试记录可以导入')
      }
      return this.stores.production.commit({
        runRef: `full-chain-import:${record.runId}:${randomUUID()}`,
        statements: record.result.knowledge.statements.map(({ title, content }) => ({
          title,
          content
        }))
      })
    } finally {
      this.processing.releaseExclusiveRun(lease)
    }
  }

  dispose(): void {
    this.cancel()
    this.ownedSandboxes.clear()
  }
}

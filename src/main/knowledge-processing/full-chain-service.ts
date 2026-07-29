import { randomUUID } from 'node:crypto'
import type {
  KnowledgeContributionDraft
} from '../../shared/knowledge'
import type {
  ClearKnowledgeResult,
  KnowledgeFullChainResult,
  RunKnowledgeFullChainInput
} from '../../shared/knowledge-processing'
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

export interface KnowledgeFullChainBindings {
  preprocessor: ProcessingStageRunBinding
  maintainer: ProcessingStageRunBinding
}

export type KnowledgeAgentFactory = (knowledgeReader: KnowledgeReader) => KnowledgeAgentRuntime

interface ActiveFullChainRun {
  runId: string
  controller: AbortController
  lease: ProcessingRunLease
  sandboxId?: string
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
    private readonly knowledgeAgentFactory: KnowledgeAgentFactory
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
    const debugTrace: ProcessingDebugTraceContext = { id: runId, origin: 'full_chain' }
    const controller = new AbortController()
    const active: ActiveFullChainRun = { runId, controller, lease }
    this.active = active
    const startedAt = Date.now()
    let sandboxId: string | undefined

    try {
      this.processing.beginFullChainDebugTrace(debugTrace)
      const { session, evidence, sourceRef } = await loadSessionMaterial(this.discovery, input)
      controller.signal.throwIfAborted()
      const sandbox = await this.stores.createSandbox()
      sandboxId = sandbox.id
      active.sandboxId = sandbox.id
      controller.signal.throwIfAborted()

      const preprocessing = await this.processing.runObservationPreprocessorView(
        evidence.observationView,
        input.attention,
        undefined,
        {
          binding: structuredClone(bindings.preprocessor),
          lease,
          sourceRef,
          debugTrace
        }
      )
      controller.signal.throwIfAborted()

      const contributionRunRef = `full-chain:${runId}`
      const maintenance = await this.processing.runKnowledgeMaintenance({
        preprocessingRunId: preprocessing.runId,
        attention: input.attention
      }, undefined, {
        binding: structuredClone(bindings.maintainer),
        lease,
        knowledgeAgent: this.knowledgeAgentFactory(sandbox.store),
        contributionRunRef,
        debugTrace
      })
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
      this.ownedSandboxes.add(sandbox.id)
      const completedDebugTrace = this.processing.completeFullChainDebugTrace(debugTrace)

      return {
        runId,
        session: structuredClone(session),
        sandbox: { id: sandbox.id, baselineCreatedAt: sandbox.baselineCreatedAt },
        sourceRef,
        preprocessing: { ...preprocessing, debugTrace: completedDebugTrace },
        maintenance: { ...maintenance, debugTrace: completedDebugTrace },
        commit,
        knowledge: {
          writtenStatementTitles: commit.statements.map((statement) => statement.title),
          statements
        },
        durationMs: Date.now() - startedAt,
        completedAt: new Date().toISOString()
      }
    } catch (error) {
      this.processing.failFullChainDebugTrace(
        debugTrace,
        controller.signal.aborted ? 'cancelled' : 'failed',
        error
      )
      if (sandboxId) {
        try {
          await this.stores.discardSandbox(sandboxId)
        } catch {
          // Preserve the processing failure/cancellation. Stale Sandboxes are cleaned on startup.
        }
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
    this.processing.cancelRun('observation_preprocessor')
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

  dispose(): void {
    this.cancel()
    this.ownedSandboxes.clear()
  }
}

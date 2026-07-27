import { randomUUID } from 'node:crypto'
import type {
  KnowledgeContributionDraft,
  KnowledgeStatementDraft
} from '../../shared/knowledge'
import type {
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
  type ProcessingRunLease,
  type ProcessingStageRunBinding
} from './knowledge-processing-service'

const MAX_CONTRIBUTION_CHARACTERS = 64 * 1_024
const SOURCE_SELECTOR = /^L(\d{6})-L(\d{6})$/

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
  expectedRunRef: string,
  expectedSourceRef: string,
  observationLineCount: number
): void {
  if (!contribution || contribution.runRef !== expectedRunRef || !Array.isArray(contribution.statements)) {
    throw new Error('Agent 返回的 Knowledge Contribution 与当前运行不匹配')
  }
  if (JSON.stringify(contribution).length > MAX_CONTRIBUTION_CHARACTERS) {
    throw new Error(`Knowledge Contribution 总大小不能超过 ${MAX_CONTRIBUTION_CHARACTERS} 个字符`)
  }
  for (const statement of contribution.statements as KnowledgeStatementDraft[]) {
    for (const source of statement.sources ?? []) {
      if (source.sourceRef !== expectedSourceRef) {
        throw new Error('Knowledge Statement 引用了当前运行之外的 Observation')
      }
      if (!source.selector) continue
      const match = SOURCE_SELECTOR.exec(source.selector)
      if (!match) throw new Error('Knowledge Statement 的来源范围格式无效')
      const start = Number(match[1])
      const end = Number(match[2])
      if (start < 1 || end < start || end > observationLineCount) {
        throw new Error('Knowledge Statement 的来源范围超出当前 Observation')
      }
    }
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
    const controller = new AbortController()
    const active: ActiveFullChainRun = { runId, controller, lease }
    this.active = active
    const startedAt = Date.now()
    let sandboxId: string | undefined

    try {
      const { session, evidence, sourceRef } = await loadSessionMaterial(this.discovery, input)
      controller.signal.throwIfAborted()
      const observationLines = evidence.content.split(/\r\n|\r|\n/)
      const sandbox = await this.stores.createSandbox()
      sandboxId = sandbox.id
      active.sandboxId = sandbox.id
      controller.signal.throwIfAborted()

      const preprocessing = await this.processing.runObservationPreprocessor({
        observation: evidence.content,
        attention: input.attention
      }, undefined, {
        binding: structuredClone(bindings.preprocessor),
        lease,
        sourceRef
      })
      controller.signal.throwIfAborted()

      const contributionRunRef = `full-chain:${runId}`
      const maintenance = await this.processing.runKnowledgeMaintenance({
        preprocessingRunId: preprocessing.runId,
        attention: input.attention
      }, undefined, {
        binding: structuredClone(bindings.maintainer),
        lease,
        knowledgeAgent: this.knowledgeAgentFactory(sandbox.store),
        contributionRunRef
      })
      controller.signal.throwIfAborted()

      validateContribution(
        maintenance.contribution,
        contributionRunRef,
        sourceRef,
        observationLines.length
      )
      controller.signal.throwIfAborted()
      const commit = sandbox.store.commit(maintenance.contribution)
      controller.signal.throwIfAborted()

      const statementDetails = commit.statements.map((statement) => {
        const details = sandbox.store.getStatement(statement.id)
        if (!details) throw new Error(`已提交的 Knowledge Statement 无法回读：${statement.id}`)
        return details
      })
      for (const previousSandboxId of [...this.ownedSandboxes]) {
        try {
          await this.stores.discardSandbox(previousSandboxId)
          this.ownedSandboxes.delete(previousSandboxId)
        } catch {
          // A stale disposable Sandbox must not turn a completed new run into a failure.
        }
      }
      this.ownedSandboxes.add(sandbox.id)

      return {
        runId,
        session: structuredClone(session),
        sandbox: { id: sandbox.id, baselineCreatedAt: sandbox.baselineCreatedAt },
        sourceRef,
        preprocessing,
        maintenance,
        commit,
        knowledge: {
          createdStatementIds: commit.statements.map((statement) => statement.id),
          statements: statementDetails
        },
        durationMs: Date.now() - startedAt,
        completedAt: new Date().toISOString()
      }
    } catch (error) {
      if (sandboxId) await this.stores.discardSandbox(sandboxId)
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

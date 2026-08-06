import { randomUUID } from 'node:crypto'
import type {
  KnowledgeFullChainRunRecord,
  KnowledgeFullChainRunSummary,
  KnowledgeFullChainResult,
  KnowledgeMaintenanceResult,
  KnowledgeReviewResult,
  RunKnowledgeFullChainInput
} from '../../shared/knowledge-processing'
import type { AgentRunRecord } from '../../shared/agent-runtime'
import type { AvailableSessionSummary } from '../../shared/discovery'
import type { DiscoveryService } from '../discovery/discovery-service'
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
import {
  CollaborationRepository,
  type CollaborationWorkspace
} from './collaboration-repository'
import type { KnowledgeFullChainRunHistory } from './full-chain-run-repository'

export interface KnowledgeFullChainBindings {
  maintainer: ProcessingStageRunBinding
  reviewer: ProcessingStageRunBinding
}

interface ActiveFullChainRun {
  runId: string
  controller: AbortController
  lease: ProcessingRunLease
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

function internalWorkspace(
  repositoryPath: string,
  result: KnowledgeMaintenanceResult
): CollaborationWorkspace {
  return {
    ...result.workspace,
    repositoryPath
  }
}

/** Runs a real, unmerged Git collaboration through Maintainer/Reviewer handoffs. */
export class KnowledgeFullChainService {
  private active?: ActiveFullChainRun

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly processing: KnowledgeProcessingService,
    private readonly collaborations: CollaborationRepository,
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
    const controller = new AbortController()
    const active: ActiveFullChainRun = { runId, controller, lease }
    this.active = active
    const startedAt = Date.now()
    const startedAtIso = new Date(startedAt).toISOString()
    let session: AvailableSessionSummary | undefined
    const agentRuns: AgentRunRecord[] = []
    let historySaveAttempted = false

    const recordAgentRun = (context: ProcessingDebugTraceContext): void => {
      const run = this.processing.agentRunSnapshot(context)
      if (!run || agentRuns.some((candidate) => candidate.id === run.id)) return
      agentRuns.push(run)
    }

    const saveHistory = (
      status: KnowledgeFullChainRunRecord['status'],
      completedAt: string,
      durationMs: number,
      result?: KnowledgeFullChainResult,
      error?: string
    ): void => {
      if (!this.history) return
      historySaveAttempted = true
      this.history.save({
        formatVersion: 6,
        runId,
        status,
        startedAt: startedAtIso,
        completedAt,
        durationMs,
        input: structuredClone(input),
        ...(session ? { session: structuredClone(session) } : {}),
        configuration: {
          maintainer: structuredClone(bindings.maintainer),
          reviewer: structuredClone(bindings.reviewer)
        },
        agentRuns: structuredClone(agentRuns),
        ...(result ? { result } : {}),
        ...(error ? { error } : {})
      })
    }

    try {
      const material = await loadSessionMaterial(this.discovery, input)
      session = material.session
      controller.signal.throwIfAborted()
      const maintenanceRuns: KnowledgeMaintenanceResult[] = []
      const reviewRuns: KnowledgeReviewResult[] = []

      const firstContext: ProcessingDebugTraceContext = {
        id: randomUUID(),
        origin: 'full_chain'
      }
      const firstMaintenance = await this.processing.runKnowledgeMaintenance(
        {
          rawEvidence: material.evidence.rawEvidence,
          canonicalActivity: material.evidence.canonicalActivity
        },
        material.sourceRef,
        input.attention,
        {
          binding: structuredClone(bindings.maintainer),
          lease,
          debugTrace: firstContext
        }
      )
      maintenanceRuns.push(firstMaintenance)
      recordAgentRun(firstContext)
      const workspace = internalWorkspace(this.collaborations.repositoryPath, firstMaintenance)
      let revision = firstMaintenance.revision

      while (true) {
        controller.signal.throwIfAborted()
        const reviewContext: ProcessingDebugTraceContext = {
          id: randomUUID(),
          origin: 'full_chain'
        }
        const review = await this.processing.runKnowledgeReview(workspace, revision, {
          binding: structuredClone(bindings.reviewer),
          lease,
          debugTrace: reviewContext
        })
        reviewRuns.push(review)
        recordAgentRun(reviewContext)
        revision = review.revision
        if (review.outcome === 'approved') break

        const maintenanceContext: ProcessingDebugTraceContext = {
          id: randomUUID(),
          origin: 'full_chain'
        }
        const maintenance = await this.processing.runKnowledgeMaintenance(
          {
            rawEvidence: material.evidence.rawEvidence,
            canonicalActivity: material.evidence.canonicalActivity
          },
          material.sourceRef,
          input.attention,
          {
            binding: structuredClone(bindings.maintainer),
            lease,
            workspace,
            previousRevision: revision,
            debugTrace: maintenanceContext
          }
        )
        maintenanceRuns.push(maintenance)
        recordAgentRun(maintenanceContext)
        revision = maintenance.revision
      }

      controller.signal.throwIfAborted()
      const finalView = await this.collaborations.revisionView(revision)
      const result: KnowledgeFullChainResult = {
        runId,
        session: structuredClone(session),
        sourceRef: material.sourceRef,
        workspace: firstMaintenance.workspace,
        maintenanceRuns,
        reviewRuns,
        approvedRevision: revision,
        changedPaths: await this.collaborations.revisionChangedPaths(
          workspace.baseRevision,
          revision
        ),
        knowledge: finalView.knowledge.map(({ title, content }) => ({ title, content })),
        artifactPaths: finalView.artifactPaths,
        durationMs: Date.now() - startedAt,
        completedAt: new Date().toISOString()
      }
      saveHistory('completed', result.completedAt, result.durationMs, result)
      return result
    } catch (error) {
      const status = terminalStatus(controller.signal)
      const currentDebugTrace = this.processing.snapshot().debugTraces
        .find((trace) => trace.origin === 'full_chain')
      const currentTrace: ProcessingDebugTraceContext | undefined = currentDebugTrace
        ? {
            id: currentDebugTrace.run.id,
            origin: 'full_chain'
          }
        : undefined
      if (currentTrace) recordAgentRun(currentTrace)
      if (!historySaveAttempted) {
        const completedAt = new Date().toISOString()
        saveHistory(
          status,
          completedAt,
          Math.max(0, new Date(completedAt).getTime() - new Date(startedAtIso).getTime()),
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
    this.processing.cancelRun('knowledge_reviewer_agent')
  }

  listRuns(): KnowledgeFullChainRunSummary[] {
    return this.history?.list() ?? []
  }

  readRun(runId: string): KnowledgeFullChainRunRecord | undefined {
    return this.history?.read(runId)
  }

  dispose(): void {
    this.cancel()
  }
}

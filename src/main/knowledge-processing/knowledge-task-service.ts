import { randomUUID } from 'node:crypto'
import type {
  KnowledgeAgentBinding,
  KnowledgeTaskDetail,
  KnowledgeTaskRecord,
  KnowledgeTaskResult,
  KnowledgeTaskRound,
  KnowledgeTaskSummary,
  StartKnowledgeTaskInput
} from '../../shared/knowledge-processing'
import type { AgentInvocationRecord } from '../../shared/agent-runtime'
import type { SourceConversationSummary } from '../../shared/discovery'
import type { DiscoveryService } from '../discovery/discovery-service'
import {
  loadSourceSnapshotMaterial,
  validateSourceSnapshot
} from './source-snapshot'
import {
  KnowledgeProcessingService,
  type AgentInvocationContext
} from './knowledge-processing-service'
import {
  KnowledgeTaskWorkspaceRepository,
  type KnowledgeTaskWorkspace
} from './knowledge-task-workspace-repository'
import type { KnowledgeTaskHistory } from './knowledge-task-history'
import {
  InMemoryAgentDebugStore,
  type AgentDebugStore
} from '../agent-runtime/agent-debug-store'

export interface KnowledgeTaskBindings {
  maintainer: KnowledgeAgentBinding
  reviewer: KnowledgeAgentBinding
}

interface ActiveKnowledgeTask {
  taskId: string
  controller: AbortController
}

function terminalStatus(signal: AbortSignal): 'failed' | 'cancelled' {
  return signal.aborted ? 'cancelled' : 'failed'
}

function terminalError(error: unknown, status: 'failed' | 'cancelled'): string {
  if (status === 'cancelled') return 'Knowledge Processing Task 已取消'
  return error instanceof Error ? error.message : String(error)
}

function terminalRecordFailure(primary: unknown, secondary: unknown): AggregateError {
  const primaryError = primary instanceof Error ? primary : new Error(String(primary))
  const secondaryError = secondary instanceof Error ? secondary : new Error(String(secondary))
  return new AggregateError([primaryError, secondaryError], primaryError.message)
}

function validateInput(input: StartKnowledgeTaskInput): void {
  validateSourceSnapshot(input)
  if (input.attention !== undefined && typeof input.attention !== 'string') {
    throw new Error('Attention 格式无效')
  }
}

function internalWorkspace(result: KnowledgeTaskRound['maintenance']): KnowledgeTaskWorkspace {
  return { ...result.workspace }
}

/** Executes one accepted Knowledge Processing Task through Maintainer/Reviewer rounds. */
export class KnowledgeTaskService {
  private active?: ActiveKnowledgeTask

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly processing: KnowledgeProcessingService,
    private readonly workspaces: KnowledgeTaskWorkspaceRepository,
    private readonly history?: KnowledgeTaskHistory,
    private readonly debugStore: AgentDebugStore = new InMemoryAgentDebugStore()
  ) {}

  isActive(): boolean {
    return Boolean(this.active)
  }

  async start(
    input: StartKnowledgeTaskInput,
    bindings: KnowledgeTaskBindings
  ): Promise<KnowledgeTaskResult> {
    validateInput(input)
    if (this.active) throw new Error('另一个 Knowledge Processing Task 正在进行')

    const taskId = randomUUID()
    const controller = new AbortController()
    const active: ActiveKnowledgeTask = { taskId, controller }
    this.active = active
    let startedAt = Date.now()
    let startedAtIso = new Date(startedAt).toISOString()
    let taskAccepted = false
    let workspace: KnowledgeTaskWorkspace | undefined
    let sourceConversation: SourceConversationSummary | undefined
    const agentInvocations: AgentInvocationRecord[] = []
    let historySaveAttempted = false

    const recordInvocation = (context: AgentInvocationContext): void => {
      const invocation = this.processing.invocationRecord(context)
      if (
        !invocation
        || agentInvocations.some((candidate) => candidate.id === invocation.id)
      ) return
      agentInvocations.push(invocation)
    }

    const saveHistory = (
      status: KnowledgeTaskRecord['status'],
      completedAt: string,
      durationMs: number,
      result?: KnowledgeTaskResult,
      error?: string
    ): void => {
      if (!this.history) return
      historySaveAttempted = true
      this.history.save({
        formatVersion: 1,
        taskId,
        status,
        startedAt: startedAtIso,
        completedAt,
        durationMs,
        input: structuredClone(input),
        ...(sourceConversation
          ? { sourceConversation: structuredClone(sourceConversation) }
          : {}),
        configuration: {
          maintainer: structuredClone(bindings.maintainer),
          reviewer: structuredClone(bindings.reviewer)
        },
        agentInvocations: structuredClone(agentInvocations),
        ...(result ? { result } : {}),
        ...(error ? { error } : {})
      })
    }

    try {
      const material = await loadSourceSnapshotMaterial(this.discovery, input)
      sourceConversation = material.sourceConversation
      controller.signal.throwIfAborted()
      taskAccepted = true
      startedAt = Date.now()
      startedAtIso = new Date(startedAt).toISOString()
      this.processing.clearLiveInvocations('knowledge_task')
      const rounds: KnowledgeTaskRound[] = []

      const firstMaintenanceContext: AgentInvocationContext = {
        invocationId: randomUUID(),
        origin: 'knowledge_task'
      }
      let maintenance = await this.processing.executeMaintenance(
        {
          rawEvidence: material.evidence.rawEvidence,
          canonicalActivity: material.evidence.canonicalActivity
        },
        material.sourceRef,
        input.attention,
        {
          binding: structuredClone(bindings.maintainer),
          taskId,
          invocation: firstMaintenanceContext,
          onWorkspaceCreated: (created) => {
            workspace = created
          }
        }
      )
      recordInvocation(firstMaintenanceContext)
      const taskWorkspace = internalWorkspace(maintenance)
      workspace = taskWorkspace
      let candidateRepositoryRevision = maintenance.candidateRepositoryRevision

      while (true) {
        controller.signal.throwIfAborted()
        const reviewContext: AgentInvocationContext = {
          invocationId: randomUUID(),
          origin: 'knowledge_task'
        }
        const review = await this.processing.executeReview(
          taskWorkspace,
          candidateRepositoryRevision,
          {
            binding: structuredClone(bindings.reviewer),
            invocation: reviewContext
          }
        )
        recordInvocation(reviewContext)
        rounds.push({
          roundId: randomUUID(),
          sequence: rounds.length + 1,
          maintenance,
          review
        })
        candidateRepositoryRevision = review.candidateRepositoryRevision
        if (review.decision === 'approved') break

        const maintenanceContext: AgentInvocationContext = {
          invocationId: randomUUID(),
          origin: 'knowledge_task'
        }
        maintenance = await this.processing.executeMaintenance(
          {
            rawEvidence: material.evidence.rawEvidence,
            canonicalActivity: material.evidence.canonicalActivity
          },
          material.sourceRef,
          input.attention,
          {
            binding: structuredClone(bindings.maintainer),
            workspace: taskWorkspace,
            previousRepositoryRevision: candidateRepositoryRevision,
            invocation: maintenanceContext
          }
        )
        recordInvocation(maintenanceContext)
        candidateRepositoryRevision = maintenance.candidateRepositoryRevision
      }

      controller.signal.throwIfAborted()
      const finalView = await this.workspaces.revisionView(candidateRepositoryRevision)
      const result: KnowledgeTaskResult = {
        taskId,
        sourceConversation: structuredClone(sourceConversation),
        sourceSnapshot: {
          sourceConversationId: input.sourceConversationId,
          sourceRevision: input.sourceRevision
        },
        sourceRef: material.sourceRef,
        workspace: maintenance.workspace,
        rounds,
        approvedRepositoryRevision: candidateRepositoryRevision,
        changedPaths: await this.workspaces.revisionChangedPaths(
          taskWorkspace.baseRepositoryRevision,
          candidateRepositoryRevision
        ),
        knowledge: finalView.knowledge.map(({ title, content }) => ({ title, content })),
        artifactPaths: finalView.artifactPaths,
        durationMs: Date.now() - startedAt,
        completedAt: new Date().toISOString()
      }
      saveHistory('completed', result.completedAt, result.durationMs, result)
      return result
    } catch (error) {
      let reportedError = error
      const status = terminalStatus(controller.signal)
      if (taskAccepted) {
        for (const view of this.processing.stateView().liveInvocations) {
          if (view.origin !== 'knowledge_task') continue
          recordInvocation({
            invocationId: view.invocation.id,
            origin: view.origin
          })
        }
      }
      if (taskAccepted && !historySaveAttempted) {
        try {
          if (workspace) await this.workspaces.removeReservedTaskRecord(workspace)
          const completedAt = new Date().toISOString()
          saveHistory(
            status,
            completedAt,
            Math.max(0, new Date(completedAt).getTime() - new Date(startedAtIso).getTime()),
            undefined,
            terminalError(error, status)
          )
        } catch (recordError) {
          reportedError = terminalRecordFailure(error, recordError)
        }
      }
      throw reportedError
    } finally {
      if (this.active === active) this.active = undefined
    }
  }

  cancel(): void {
    const active = this.active
    if (!active) return
    active.controller.abort(new Error('用户取消了 Knowledge Processing Task'))
    this.processing.cancelAgentInvocation('knowledge_maintainer')
    this.processing.cancelAgentInvocation('knowledge_reviewer')
  }

  listTasks(): KnowledgeTaskSummary[] {
    return this.history?.list() ?? []
  }

  readTask(taskId: string): KnowledgeTaskDetail | undefined {
    const record = this.history?.read(taskId)
    if (!record) return undefined
    return {
      ...record,
      invocationDebugRecords: record.agentInvocations.flatMap((invocation) => {
        const debug = this.debugStore.read(invocation.debugRecordId)
        return debug ? [debug] : []
      })
    }
  }

  dispose(): void {
    this.cancel()
  }
}

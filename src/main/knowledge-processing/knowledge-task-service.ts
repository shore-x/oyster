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
  KnowledgeTaskGitRepository,
  type KnowledgeTaskWorktree
} from './knowledge-task-git-repository'
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

function errorText(error: unknown, cancelled: boolean): string {
  if (cancelled) return 'Knowledge Processing Task 的当前 Agent 执行已取消；Task 仍可继续'
  return error instanceof Error ? error.message : String(error)
}

function validateInput(input: StartKnowledgeTaskInput): void {
  validateSourceSnapshot(input)
  if (input.attention !== undefined && typeof input.attention !== 'string') {
    throw new Error('Attention 格式无效')
  }
}

/** Executes accepted Tasks; failed Agent turns leave an open, checkpointed Task branch. */
export class KnowledgeTaskService {
  private readonly active = new Map<string, ActiveKnowledgeTask>()

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly processing: KnowledgeProcessingService,
    private readonly tasks: KnowledgeTaskGitRepository,
    private readonly history?: KnowledgeTaskHistory,
    private readonly debugStore: AgentDebugStore = new InMemoryAgentDebugStore()
  ) {}

  isActive(): boolean {
    return this.active.size > 0
  }

  async start(
    input: StartKnowledgeTaskInput,
    bindings: KnowledgeTaskBindings
  ): Promise<KnowledgeTaskResult> {
    validateInput(input)
    const taskId = randomUUID()
    const controller = new AbortController()
    const active: ActiveKnowledgeTask = { taskId, controller }
    if (!this.active.size) this.processing.clearLiveInvocations('knowledge_task')
    this.active.set(taskId, active)

    let startedAt = Date.now()
    let startedAtIso = new Date(startedAt).toISOString()
    let worktree: KnowledgeTaskWorktree | undefined
    let sourceConversation: SourceConversationSummary | undefined
    const agentInvocations: AgentInvocationRecord[] = []
    const invocationContexts: AgentInvocationContext[] = []

    const createInvocationContext = (): AgentInvocationContext => {
      const context: AgentInvocationContext = {
        invocationId: randomUUID(),
        origin: 'knowledge_task'
      }
      invocationContexts.push(context)
      return context
    }

    const recordInvocation = (context: AgentInvocationContext): void => {
      const invocation = this.processing.invocationRecord(context)
      if (
        !invocation
        || agentInvocations.some((candidate) => candidate.id === invocation.id)
      ) return
      agentInvocations.push(invocation)
    }

    const record = (
      status: KnowledgeTaskRecord['status'],
      updatedAt: string,
      result?: KnowledgeTaskResult,
      lastError?: string
    ): KnowledgeTaskRecord => ({
      formatVersion: 2,
      taskId,
      status,
      startedAt: startedAtIso,
      updatedAt,
      ...(status === 'completed' ? { completedAt: updatedAt } : {}),
      durationMs: Math.max(0, new Date(updatedAt).getTime() - new Date(startedAtIso).getTime()),
      input: structuredClone(input),
      ...(sourceConversation ? { sourceConversation: structuredClone(sourceConversation) } : {}),
      configuration: {
        maintainer: structuredClone(bindings.maintainer),
        reviewer: structuredClone(bindings.reviewer)
      },
      agentInvocations: structuredClone(agentInvocations),
      ...(result ? { result } : {}),
      ...(lastError ? { lastError } : {})
    })

    try {
      const material = await loadSourceSnapshotMaterial(this.discovery, input)
      sourceConversation = material.sourceConversation
      controller.signal.throwIfAborted()
      startedAt = Date.now()
      startedAtIso = new Date(startedAt).toISOString()
      const rounds: KnowledgeTaskRound[] = []
      const initialRecord = record('open', startedAtIso)

      const firstMaintenanceContext = createInvocationContext()
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
          taskRecord: initialRecord,
          invocation: firstMaintenanceContext,
          onWorktreeCreated: (created) => {
            worktree = created
          }
        }
      )
      recordInvocation(firstMaintenanceContext)
      if (!worktree) throw new Error('Knowledge Processing Task worktree 未创建')
      const taskWorktree = worktree
      let candidateRepositoryRevision = maintenance.candidateRepositoryRevision

      while (true) {
        controller.signal.throwIfAborted()
        const reviewContext = createInvocationContext()
        const review = await this.processing.executeReview(
          taskWorktree,
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

        const maintenanceContext = createInvocationContext()
        maintenance = await this.processing.executeMaintenance(
          {
            rawEvidence: material.evidence.rawEvidence,
            canonicalActivity: material.evidence.canonicalActivity
          },
          material.sourceRef,
          input.attention,
          {
            binding: structuredClone(bindings.maintainer),
            worktree: taskWorktree,
            previousRepositoryRevision: candidateRepositoryRevision,
            invocation: maintenanceContext
          }
        )
        recordInvocation(maintenanceContext)
        candidateRepositoryRevision = maintenance.candidateRepositoryRevision
      }

      controller.signal.throwIfAborted()
      const finalView = await this.tasks.revisionView(candidateRepositoryRevision)
      const completedAt = new Date().toISOString()
      const result: KnowledgeTaskResult = {
        taskId,
        sourceConversation: structuredClone(sourceConversation),
        sourceSnapshot: {
          sourceConversationId: input.sourceConversationId,
          sourceRevision: input.sourceRevision
        },
        sourceRef: material.sourceRef,
        worktree: maintenance.worktree,
        rounds,
        approvedRepositoryRevision: candidateRepositoryRevision,
        changedPaths: await this.tasks.revisionChangedPaths(
          taskWorktree.baseRepositoryRevision,
          candidateRepositoryRevision
        ),
        knowledge: finalView.knowledge.map(({ title, content }) => ({ title, content })),
        artifactPaths: finalView.artifactPaths,
        durationMs: Date.now() - startedAt,
        completedAt
      }
      if (this.history) await this.history.save(record('completed', completedAt, result), taskWorktree)
      return result
    } catch (error) {
      for (const context of invocationContexts) recordInvocation(context)
      if (worktree && this.history) {
        const updatedAt = new Date().toISOString()
        try {
          await this.history.save(record(
            'open',
            updatedAt,
            undefined,
            errorText(error, controller.signal.aborted)
          ), worktree)
        } catch (checkpointError) {
          const primary = error instanceof Error ? error : new Error(String(error))
          const secondary = checkpointError instanceof Error
            ? checkpointError
            : new Error(String(checkpointError))
          throw new AggregateError([primary, secondary], primary.message)
        }
      }
      throw error
    } finally {
      if (this.active.get(taskId) === active) this.active.delete(taskId)
    }
  }

  cancel(): void {
    for (const active of this.active.values()) {
      active.controller.abort(new Error('用户取消了当前 Knowledge Agent 执行'))
    }
    this.processing.cancelAgentInvocation('knowledge_maintainer')
    this.processing.cancelAgentInvocation('knowledge_reviewer')
  }

  async listTasks(): Promise<KnowledgeTaskSummary[]> {
    return await this.history?.list() ?? []
  }

  async readTask(taskId: string): Promise<KnowledgeTaskDetail | undefined> {
    const record = await this.history?.read(taskId)
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

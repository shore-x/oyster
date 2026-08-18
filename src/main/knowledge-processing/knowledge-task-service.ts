import { randomUUID } from 'node:crypto'
import type {
  KnowledgeAgentBinding,
  KnowledgeTaskDetail,
  KnowledgeTaskDefinition,
  KnowledgeTaskResult,
  KnowledgeTaskSummary,
  StartKnowledgeTaskInput
} from '../../shared/knowledge-processing'
import type { DiscoveryService } from '../discovery/discovery-service'
import {
  loadSourceSnapshotMaterial,
  normalizeStartKnowledgeTaskInput
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

export interface KnowledgeTaskBindings {
  maintainer: KnowledgeAgentBinding
  reviewer: KnowledgeAgentBinding
}

interface ActiveKnowledgeTask {
  taskId: string
  controller: AbortController
}

/** Executes accepted Tasks; Agent commits and Git ancestry own durable Task state. */
export class KnowledgeTaskService {
  private readonly active = new Map<string, ActiveKnowledgeTask>()

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly processing: KnowledgeProcessingService,
    private readonly tasks: KnowledgeTaskGitRepository,
    private readonly history?: KnowledgeTaskHistory
  ) {}

  isActive(): boolean {
    return this.active.size > 0
  }

  async start(
    input: StartKnowledgeTaskInput,
    bindings: KnowledgeTaskBindings
  ): Promise<KnowledgeTaskResult> {
    const normalizedInput = normalizeStartKnowledgeTaskInput(input)
    const taskId = randomUUID()
    const controller = new AbortController()
    const active: ActiveKnowledgeTask = { taskId, controller }
    if (!this.active.size) this.processing.clearLiveInvocations('knowledge_task')
    this.active.set(taskId, active)

    let startedAt = Date.now()
    let worktree: KnowledgeTaskWorktree | undefined

    const createInvocationContext = (): AgentInvocationContext => {
      return {
        invocationId: randomUUID(),
        origin: 'knowledge_task'
      }
    }

    try {
      const material = await loadSourceSnapshotMaterial(this.discovery, normalizedInput)
      controller.signal.throwIfAborted()
      startedAt = Date.now()
      const startedAtIso = new Date(startedAt).toISOString()
      const bindingSummary = ({
        connectionId,
        modelId,
        reasoningEffort
      }: KnowledgeAgentBinding) => ({
        connectionId,
        modelId,
        ...(reasoningEffort ? { reasoningEffort } : {})
      })
      const taskDefinition: KnowledgeTaskDefinition = {
        formatVersion: 3,
        taskId,
        startedAt: startedAtIso,
        input: structuredClone(normalizedInput),
        sourceConversation: structuredClone(material.sourceConversation),
        sourceRef: material.sourceRef,
        configuration: {
          maintainer: bindingSummary(bindings.maintainer),
          reviewer: bindingSummary(bindings.reviewer)
        }
      }

      const firstMaintenanceContext = createInvocationContext()
      let maintenance = await this.processing.executeMaintenance(
        {
          rawEvidence: material.evidence.rawEvidence,
          canonicalActivity: material.evidence.canonicalActivity
        },
        material.sourceRef,
        normalizedInput.attention,
        {
          binding: structuredClone(bindings.maintainer),
          taskId,
          taskDefinition,
          invocation: firstMaintenanceContext,
          onWorktreeCreated: (created) => {
            worktree = created
          }
        }
      )
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
        candidateRepositoryRevision = review.candidateRepositoryRevision
        if (review.decision === 'approved') {
          if (!review.integratedRepositoryRevision) {
            throw new Error('Reviewer 批准结果缺少目标分支 revision')
          }
          controller.signal.throwIfAborted()
          const completedAt = new Date().toISOString()
          const result: KnowledgeTaskResult = {
            taskId,
            sourceConversation: structuredClone(material.sourceConversation),
            sourceRef: material.sourceRef,
            worktree: maintenance.worktree,
            approvedRepositoryRevision: candidateRepositoryRevision,
            integratedRepositoryRevision: review.integratedRepositoryRevision,
            changedPaths: await this.tasks.taskChangedPaths(
              taskId,
              review.candidateRepositoryRevision
            ),
            durationMs: Date.now() - startedAt,
            completedAt
          }
          try {
            await this.tasks.releaseCompletedWorktree(taskWorktree)
          } catch (error) {
            // main already owns the completed Task; cleanup failure must not falsify that fact.
            console.warn('已完成 Knowledge Task 的临时 worktree 清理失败。', error)
          }
          return result
        }

        const maintenanceContext = createInvocationContext()
        maintenance = await this.processing.executeMaintenance(
          {
            rawEvidence: material.evidence.rawEvidence,
            canonicalActivity: material.evidence.canonicalActivity
          },
          material.sourceRef,
          normalizedInput.attention,
          {
            binding: structuredClone(bindings.maintainer),
            worktree: taskWorktree,
            previousRepositoryRevision: candidateRepositoryRevision,
            invocation: maintenanceContext
          }
        )
        candidateRepositoryRevision = maintenance.candidateRepositoryRevision
      }
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
    return this.history?.read(taskId)
  }

  dispose(): void {
    this.cancel()
  }
}

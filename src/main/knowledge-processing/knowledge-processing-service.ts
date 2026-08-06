import { randomUUID } from 'node:crypto'
import {
  PROCESSING_STAGE_IDS,
  type KnowledgeMaintenanceResult,
  type KnowledgeProcessingDebugTrace,
  type KnowledgeProcessingSnapshot,
  type KnowledgeReviewResult,
  type ProcessingConnectionView,
  type ProcessingDebugTraceOrigin,
  type ProcessingExecutionSummary,
  type ProcessingStageId,
  type SaveProcessingDefaultInstructionsInput,
  type SaveProcessingStageInput
} from '../../shared/knowledge-processing'
import type { AiBackendSnapshot, AiConnection, ReasoningEffort } from '../../shared/ai-backends'
import type { AgentRunRecord } from '../../shared/agent-runtime'
import type { AgentObservation, CanonicalActivity, RawEvidence } from '../observation/model'
import { parseAgentRunRecord } from '../agent-runtime/agent-run-record'
import type {
  AiBackendPort,
  KnowledgeMaintainerRuntime,
  KnowledgeProcessingRepository,
  KnowledgeProcessingStateData,
  KnowledgeReviewerRuntime,
  ProcessingSnapshotListener,
  StoredProcessingStage
} from './model'
import { PROCESSING_STAGE_DEFINITIONS, stageDefinition } from './prompts'
import {
  activitySegmentCharacterLimit,
  planActivityWork
} from './activity-work-plan'
import {
  CollaborationRepository,
  type CollaborationWorkspace
} from './collaboration-repository'

const MAX_SOURCE_REF_CHARACTERS = 512
const MAX_DEBUG_TRACE_ERROR_CHARACTERS = 2 * 1_024

export interface ProcessingStageRunBinding {
  connectionId: string
  modelId: string
  instructions: string
  reasoningEffort?: ReasoningEffort
}

export interface ProcessingRunLease {
  readonly id: string
}

export interface ProcessingDebugTraceContext {
  id: string
  origin: ProcessingDebugTraceOrigin
}

export interface KnowledgeMaintenanceRunOptions {
  binding?: ProcessingStageRunBinding
  lease?: ProcessingRunLease
  agent?: KnowledgeMaintainerRuntime
  workspace?: CollaborationWorkspace
  previousRevision?: string
  debugTrace?: ProcessingDebugTraceContext
}

export interface KnowledgeReviewRunOptions {
  binding?: ProcessingStageRunBinding
  lease?: ProcessingRunLease
  agent?: KnowledgeReviewerRuntime
  debugTrace?: ProcessingDebugTraceContext
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function boundedDebugText(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`
}

function debugError(error: unknown): string {
  return boundedDebugText(errorText(error), MAX_DEBUG_TRACE_ERROR_CHARACTERS)
}

function traceTerminalStatus(signal: AbortSignal): 'failed' | 'cancelled' {
  return signal.aborted ? 'cancelled' : 'failed'
}

function isStageId(value: unknown): value is ProcessingStageId {
  return typeof value === 'string' && PROCESSING_STAGE_IDS.includes(value as ProcessingStageId)
}

function defaultInstructions(stageId: ProcessingStageId, stored?: StoredProcessingStage): string {
  return stored?.defaultInstructionsOverride ?? stageDefinition(stageId).defaultInstructions
}

function processingConnections(snapshot: AiBackendSnapshot): ProcessingConnectionView[] {
  return snapshot.connections.flatMap((connection) => {
    if (!connection.models.length) return []
    return [{
      id: connection.id,
      displayName: connection.displayName,
      backendKind: connection.backendKind,
      providerId: connection.providerId,
      destination: connection.modelConfig?.baseUrl ?? 'OpenAI Codex Coding Plan',
      protocol: connection.modelConfig?.protocol,
      accountLabel: connection.accountLabel,
      planType: connection.planType,
      status: connection.status,
      models: connection.models.map((model) => ({
        ...model,
        reasoningEfforts: [...model.reasoningEfforts]
      })),
      defaultModelId: connection.defaultModelId
    }]
  })
}

function selectedModel(connection: ProcessingConnectionView | undefined, modelId: string | undefined) {
  return connection?.models.find((model) => model.id === modelId)
}

function normalizeAttention(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new Error('关注点格式无效')
  return value.trim() || undefined
}

function assertRawEvidence(evidence: RawEvidence): void {
  if (
    !evidence
    || typeof evidence !== 'object'
    || typeof evidence.formatVersion !== 'string'
    || !evidence.formatVersion.trim()
    || !Array.isArray(evidence.lines)
    || !evidence.lines.length
    || evidence.lines.some((line) => typeof line !== 'string' || /[\r\n]/.test(line))
    || !evidence.lines.some((line) => line.trim())
    || !Array.isArray(evidence.skillHints)
  ) throw new Error('Raw Evidence 无效')
}

function assertCanonicalActivity(activity: CanonicalActivity, evidence: RawEvidence): void {
  if (
    !activity
    || typeof activity.formatVersion !== 'string'
    || !activity.formatVersion.trim()
    || !Array.isArray(activity.items)
    || !activity.items.length
    || !Array.isArray(activity.attachments)
  ) throw new Error('Canonical Activity 无效')
  const attachmentIds = new Set(activity.attachments.map((attachment) => attachment.id))
  for (const item of activity.items) {
    if (!item?.content?.trim() || !item.rawRanges?.length) {
      throw new Error('Canonical Activity Item 无效')
    }
    if (item.attachmentId && !attachmentIds.has(item.attachmentId)) {
      throw new Error('Canonical Activity Attachment 引用无效')
    }
    for (const range of item.rawRanges) {
      const line = evidence.lines[range.start.line - 1]
      if (
        line === undefined
        || range.start.line !== range.end.line
        || range.start.offset < 0
        || range.end.offset < range.start.offset
        || range.end.offset > line.length
      ) throw new Error('Canonical Activity Raw locator 无效')
    }
  }
}

function executionSummary(
  connection: AiConnection,
  modelId: string,
  modelCallCount: number,
  toolCalls: string[],
  reasoningEffort?: ReasoningEffort
): ProcessingExecutionSummary {
  return {
    connectionId: connection.id,
    connectionName: connection.displayName,
    backendKind: connection.backendKind,
    providerId: connection.providerId,
    model: modelId,
    runtime: 'pi_agent_core',
    modelCallCount,
    toolCalls,
    ...(reasoningEffort ? { reasoningEffort } : {})
  }
}

function workspaceView(workspace: CollaborationWorkspace) {
  return {
    id: workspace.id,
    worktreePath: workspace.worktreePath,
    branchName: workspace.branchName,
    targetBranch: workspace.targetBranch,
    baseRevision: workspace.baseRevision,
    workOrderRevision: workspace.workOrderRevision
  }
}

export class KnowledgeProcessingService {
  private state: KnowledgeProcessingStateData = { stages: [] }
  private configurationError?: string
  private mutationQueue: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<ProcessingSnapshotListener>()
  private readonly activeRuns = new Map<ProcessingStageId, AbortController>()
  private readonly debugTraces = new Map<ProcessingDebugTraceOrigin, KnowledgeProcessingDebugTrace>()
  private exclusiveLease?: ProcessingRunLease
  private readonly unsubscribeAiBackend: () => void

  constructor(
    private readonly repository: KnowledgeProcessingRepository,
    private readonly aiBackend: AiBackendPort,
    private readonly collaborations: CollaborationRepository,
    private readonly maintainer: KnowledgeMaintainerRuntime,
    private readonly reviewer: KnowledgeReviewerRuntime
  ) {
    this.unsubscribeAiBackend = aiBackend.subscribe(() => this.emit())
  }

  async initialize(): Promise<void> {
    try {
      this.state = await this.repository.load()
      this.configurationError = undefined
    } catch (error) {
      this.state = { stages: [] }
      this.configurationError = `知识加工配置无法读取：${errorText(error)}`
    }
    await this.collaborations.initialize()
  }

  snapshot(): KnowledgeProcessingSnapshot {
    const backendSnapshot = this.aiBackend.snapshot()
    const connections = processingConnections(backendSnapshot)
    return structuredClone({
      stages: PROCESSING_STAGE_DEFINITIONS.map((definition) => {
        const stored = this.state.stages.find((candidate) => candidate.stageId === definition.id)
        const configuredDefault = defaultInstructions(definition.id, stored)
        return {
          id: definition.id,
          displayName: definition.displayName,
          description: definition.description,
          inputDescription: definition.inputDescription,
          outputDescription: definition.outputDescription,
          runtime: definition.runtime,
          capabilities: [...definition.capabilities],
          tools: definition.tools.map((tool) => ({ ...tool })),
          builtInInstructions: definition.defaultInstructions,
          defaultInstructions: configuredDefault,
          effectiveInstructions: stored?.instructionsOverride ?? configuredDefault,
          isDefaultCustomized: stored?.defaultInstructionsOverride !== undefined,
          isCustomized: stored?.instructionsOverride !== undefined
        }
      }),
      connections,
      ...(backendSnapshot.defaultLlm ? { defaultLlm: { ...backendSnapshot.defaultLlm } } : {}),
      runningStageIds: [...this.activeRuns.keys()],
      debugTraces: [...this.debugTraces.values()],
      configurationError: this.configurationError
    })
  }

  private assertConfigurationWritable(): void {
    if (this.configurationError) {
      throw new Error('知识加工配置当前不可修改；请先修复配置文件并重新启动 Oyster')
    }
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation)
    this.mutationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  saveStage(input: SaveProcessingStageInput): Promise<KnowledgeProcessingSnapshot> {
    return this.enqueueMutation(async () => {
      this.assertConfigurationWritable()
      if (!input || typeof input !== 'object' || !isStageId(input.stageId)) {
        throw new Error('未知的知识加工阶段')
      }
      if (input.instructionsOverride !== null && typeof input.instructionsOverride !== 'string') {
        throw new Error('System Prompt 配置无效')
      }
      const current = this.state.stages.find((stage) => stage.stageId === input.stageId)
      const normalized = input.instructionsOverride?.trim()
      if (input.instructionsOverride !== null && !normalized) throw new Error('System Prompt 不能为空')
      const instructionsOverride = normalized === defaultInstructions(input.stageId, current)
        ? undefined
        : normalized
      const next: StoredProcessingStage = {
        stageId: input.stageId,
        ...(current?.defaultInstructionsOverride
          ? { defaultInstructionsOverride: current.defaultInstructionsOverride }
          : {}),
        ...(instructionsOverride ? { instructionsOverride } : {})
      }
      this.state = {
        stages: [
          ...this.state.stages.filter((stage) => stage.stageId !== input.stageId),
          next
        ]
      }
      await this.repository.save(this.state)
      this.emit()
      return this.snapshot()
    })
  }

  saveDefaultInstructions(
    input: SaveProcessingDefaultInstructionsInput
  ): Promise<KnowledgeProcessingSnapshot> {
    return this.enqueueMutation(async () => {
      this.assertConfigurationWritable()
      if (!input || typeof input !== 'object' || !isStageId(input.stageId)) {
        throw new Error('未知的知识加工阶段')
      }
      if (input.instructionsOverride !== null && typeof input.instructionsOverride !== 'string') {
        throw new Error('默认 System Prompt 配置无效')
      }
      const normalized = input.instructionsOverride?.trim()
      if (input.instructionsOverride !== null && !normalized) {
        throw new Error('默认 System Prompt 不能为空')
      }
      const configuredDefault = normalized === stageDefinition(input.stageId).defaultInstructions
        ? undefined
        : normalized
      const current = this.state.stages.find((stage) => stage.stageId === input.stageId)
      const next: StoredProcessingStage = {
        stageId: input.stageId,
        ...(configuredDefault ? { defaultInstructionsOverride: configuredDefault } : {}),
        ...(current?.instructionsOverride ? { instructionsOverride: current.instructionsOverride } : {})
      }
      this.state = {
        stages: [
          ...this.state.stages.filter((stage) => stage.stageId !== input.stageId),
          next
        ]
      }
      await this.repository.save(this.state)
      this.emit()
      return this.snapshot()
    })
  }

  private configuredStage(stageId: ProcessingStageId): ProcessingStageRunBinding {
    const stored = this.state.stages.find((candidate) => candidate.stageId === stageId)
    const backendSnapshot = this.aiBackend.snapshot()
    const binding = backendSnapshot.defaultLlm
    if (!binding) throw new Error('请先在 AI 后端页面配置默认 LLM')
    const connection = processingConnections(backendSnapshot)
      .find((candidate) => candidate.id === binding.connectionId)
    if (!connection) throw new Error('默认 LLM 的 Connection 当前不可用')
    const model = selectedModel(connection, binding.modelId)
    if (!model) throw new Error('默认 LLM 的 Model 当前不可用，系统不会自动回退')
    if (binding.reasoningEffort && !model.reasoningEfforts.includes(binding.reasoningEffort)) {
      throw new Error('默认 LLM 的思考强度不再受当前 Model 支持')
    }
    return {
      connectionId: binding.connectionId,
      modelId: model.id,
      instructions: stored?.instructionsOverride ?? defaultInstructions(stageId, stored),
      ...(binding.reasoningEffort ? { reasoningEffort: binding.reasoningEffort } : {})
    }
  }

  runBinding(stageId: ProcessingStageId): ProcessingStageRunBinding {
    return structuredClone(this.configuredStage(stageId))
  }

  acquireExclusiveRun(): ProcessingRunLease {
    if (this.exclusiveLease || this.activeRuns.size) throw new Error('已有知识加工运行正在占用工作区')
    const lease = Object.freeze({ id: randomUUID() })
    this.exclusiveLease = lease
    return lease
  }

  releaseExclusiveRun(lease: ProcessingRunLease): void {
    if (this.exclusiveLease !== lease) throw new Error('知识加工运行租约无效')
    if (this.activeRuns.size) throw new Error('知识加工阶段尚未结束，不能释放运行租约')
    this.exclusiveLease = undefined
  }

  private beginRun(stageId: ProcessingStageId, lease?: ProcessingRunLease): AbortController {
    if (this.exclusiveLease && this.exclusiveLease !== lease) {
      throw new Error('完整链路正在运行，不能启动独立阶段')
    }
    if (!this.exclusiveLease && lease) throw new Error('知识加工运行租约已失效')
    if (this.activeRuns.size) throw new Error('已有知识加工阶段正在运行')
    const controller = new AbortController()
    this.activeRuns.set(stageId, controller)
    this.emit()
    return controller
  }

  private finishRun(stageId: ProcessingStageId, controller: AbortController): void {
    if (this.activeRuns.get(stageId) === controller) this.activeRuns.delete(stageId)
    this.emit()
  }

  private recordAgentRun(context: ProcessingDebugTraceContext, run: AgentRunRecord): void {
    const parsed = parseAgentRunRecord(run, context.id)
    this.debugTraces.set(context.origin, { origin: context.origin, run: parsed })
    this.emit()
  }

  private failDebugTrace(
    context: ProcessingDebugTraceContext,
    status: 'failed' | 'cancelled',
    error: unknown
  ): void {
    const trace = this.debugTraces.get(context.origin)
    if (!trace || trace.run.id !== context.id || trace.run.status !== 'running') return
    const completedAt = new Date().toISOString()
    trace.run.status = status
    trace.run.completedAt = completedAt
    trace.run.durationMs = Math.max(
      0,
      new Date(completedAt).getTime() - new Date(trace.run.startedAt).getTime()
    )
    trace.run.error = status === 'cancelled' ? '知识加工运行已取消' : debugError(error)
    this.emit()
  }

  agentRunSnapshot(context: ProcessingDebugTraceContext): AgentRunRecord | undefined {
    const trace = this.debugTraces.get(context.origin)
    return trace?.run.id === context.id ? structuredClone(trace.run) : undefined
  }

  async runKnowledgeMaintenance(
    observation: AgentObservation,
    sourceRef: string,
    attention?: string,
    options: KnowledgeMaintenanceRunOptions = {}
  ): Promise<KnowledgeMaintenanceResult> {
    const { rawEvidence, canonicalActivity } = observation
    assertRawEvidence(rawEvidence)
    assertCanonicalActivity(canonicalActivity, rawEvidence)
    if (!sourceRef.trim() || sourceRef.length > MAX_SOURCE_REF_CHARACTERS) {
      throw new Error('Raw Evidence sourceRef 无效')
    }
    const normalizedAttention = normalizeAttention(attention)
    const stage = options.binding ?? this.configuredStage('knowledge_maintenance_agent')
    const connection = this.aiBackend.snapshot().connections.find((item) => item.id === stage.connectionId)
    if (!connection) throw new Error('已配置的 Connection 不再可用')
    const controller = this.beginRun('knowledge_maintenance_agent', options.lease)
    const debugTrace = options.debugTrace ?? { id: randomUUID(), origin: 'stage_debug' }
    const startedAt = Date.now()
    try {
      return await this.aiBackend.withModelRuntime(
        stage.connectionId,
        stage.modelId,
        async (runtime) => {
          if (
            canonicalActivity.attachments.some((attachment) => attachment.mimeType.startsWith('image/'))
            && !runtime.model.input?.includes('image')
          ) throw new Error('所选 Maintainer Model 不支持图片输入')
          const plan = planActivityWork(
            canonicalActivity,
            rawEvidence.skillHints,
            activitySegmentCharacterLimit(runtime.model.contextWindow)
          )
          const workspace = options.workspace ?? await this.collaborations.createCollaboration({
            sourceRef,
            attention: normalizedAttention,
            items: plan.items
          })
          const previousRevision = options.previousRevision ?? workspace.workOrderRevision
          const result = await (options.agent ?? this.maintainer).run({
            runtime,
            systemPrompt: stage.instructions,
            workspace,
            observation,
            sourceRef,
            previousRevision,
            reasoningEffort: stage.reasoningEffort,
            runId: debugTrace.id,
            onRunUpdate: (run) => this.recordAgentRun(debugTrace, run),
            signal: controller.signal
          })
          const handoff = await this.collaborations.recordMaintainerHandoff(
            workspace,
            previousRevision
          )
          this.recordAgentRun(debugTrace, result.run)
          return {
            stageId: 'knowledge_maintenance_agent' as const,
            sourceRef,
            activitySegmentCount: plan.segmentCount,
            workspace: workspaceView(workspace),
            previousRevision,
            revision: handoff.revision,
            changedPaths: handoff.changedPaths,
            agentRunId: result.run.id,
            durationMs: Date.now() - startedAt,
            completedAt: new Date().toISOString(),
            execution: executionSummary(
              connection,
              stage.modelId,
              result.modelCallCount,
              result.toolCalls,
              stage.reasoningEffort
            )
          }
        },
        { trackHealth: true }
      )
    } catch (error) {
      this.failDebugTrace(debugTrace, traceTerminalStatus(controller.signal), error)
      throw error
    } finally {
      this.finishRun('knowledge_maintenance_agent', controller)
    }
  }

  async runKnowledgeReview(
    workspace: CollaborationWorkspace,
    reviewedRevision: string,
    options: KnowledgeReviewRunOptions = {}
  ): Promise<KnowledgeReviewResult> {
    const stage = options.binding ?? this.configuredStage('knowledge_reviewer_agent')
    const connection = this.aiBackend.snapshot().connections.find((item) => item.id === stage.connectionId)
    if (!connection) throw new Error('已配置的 Connection 不再可用')
    const controller = this.beginRun('knowledge_reviewer_agent', options.lease)
    const debugTrace = options.debugTrace ?? { id: randomUUID(), origin: 'stage_debug' }
    const startedAt = Date.now()
    try {
      return await this.aiBackend.withModelRuntime(
        stage.connectionId,
        stage.modelId,
        async (runtime) => {
          if (await this.collaborations.collaborationRevision(workspace) !== reviewedRevision) {
            throw new Error('Reviewer 输入 revision 已经过期')
          }
          const result = await (options.agent ?? this.reviewer).run({
            runtime,
            systemPrompt: stage.instructions,
            workspace,
            reviewedRevision,
            reasoningEffort: stage.reasoningEffort,
            runId: debugTrace.id,
            onRunUpdate: (run) => this.recordAgentRun(debugTrace, run),
            signal: controller.signal
          })
          const outcome = await this.collaborations.recordReviewerOutcome(workspace, reviewedRevision)
          this.recordAgentRun(debugTrace, result.run)
          return {
            stageId: 'knowledge_reviewer_agent' as const,
            outcome: outcome.kind,
            reviewedRevision,
            revision: outcome.revision,
            changedPaths: outcome.kind === 'changes_requested' ? outcome.changedPaths : ['.oyster/WORK.md'],
            markerPaths: outcome.kind === 'changes_requested' ? outcome.markerPaths : [],
            agentRunId: result.run.id,
            durationMs: Date.now() - startedAt,
            completedAt: new Date().toISOString(),
            execution: executionSummary(
              connection,
              stage.modelId,
              result.modelCallCount,
              result.toolCalls,
              stage.reasoningEffort
            )
          }
        },
        { trackHealth: true }
      )
    } catch (error) {
      this.failDebugTrace(debugTrace, traceTerminalStatus(controller.signal), error)
      throw error
    } finally {
      this.finishRun('knowledge_reviewer_agent', controller)
    }
  }

  cancelRun(stageId: ProcessingStageId): void {
    if (!isStageId(stageId)) throw new Error('未知的知识加工阶段')
    this.activeRuns.get(stageId)?.abort(new Error('用户取消了运行'))
  }

  subscribe(listener: ProcessingSnapshotListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    const snapshot = this.snapshot()
    for (const listener of this.listeners) listener(snapshot)
  }

  dispose(): void {
    for (const controller of this.activeRuns.values()) controller.abort(new Error('Oyster 正在退出'))
    this.activeRuns.clear()
    this.unsubscribeAiBackend()
    this.listeners.clear()
  }
}

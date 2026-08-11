import { randomUUID } from 'node:crypto'
import {
  KNOWLEDGE_AGENT_IDS,
  type AgentInvocationOrigin,
  type AgentInvocationSummary,
  type AiConnectionView,
  type KnowledgeAgentBinding,
  type KnowledgeAgentId,
  type KnowledgeMaintenanceResult,
  type KnowledgeProcessingStateView,
  type KnowledgeReviewResult,
  type KnowledgeTaskRecord,
  type LiveAgentInvocationView,
  type SaveKnowledgeAgentDefaultInstructionsInput,
  type SaveKnowledgeAgentInput
} from '../../shared/knowledge-processing'
import type { AiBackendSnapshot, AiConnection, ReasoningEffort } from '../../shared/ai-backends'
import type {
  AgentInvocationDebugRecord,
  AgentInvocationRecord
} from '../../shared/agent-runtime'
import type { AgentObservation, CanonicalActivity, RawEvidence } from '../observation/model'
import {
  parseAgentInvocationDebugRecord,
  parseAgentInvocationRecord
} from '../agent-runtime/agent-invocation-record'
import type {
  AiBackendPort,
  KnowledgeMaintainerRuntime,
  KnowledgeProcessingConfigurationData,
  KnowledgeProcessingConfigurationRepository,
  KnowledgeProcessingStateListener,
  KnowledgeReviewerRuntime,
  StoredKnowledgeAgent
} from './model'
import { KNOWLEDGE_AGENT_DEFINITIONS, knowledgeAgentDefinition } from './prompts'
import {
  activitySegmentCharacterLimit,
  planKnowledgeTaskInput
} from './task-input'
import {
  KnowledgeTaskGitRepository,
  type KnowledgeTaskWorktree
} from './knowledge-task-git-repository'

const MAX_SOURCE_REF_CHARACTERS = 512
const MAX_LIVE_ERROR_CHARACTERS = 2 * 1_024

export interface AgentInvocationContext {
  invocationId: string
  origin: AgentInvocationOrigin
}

export interface KnowledgeMaintenanceInvocationOptions {
  binding?: KnowledgeAgentBinding
  agent?: KnowledgeMaintainerRuntime
  worktree?: KnowledgeTaskWorktree
  taskId?: string
  previousRepositoryRevision?: string
  invocation?: AgentInvocationContext
  taskRecord?: KnowledgeTaskRecord
  onWorktreeCreated?: (worktree: KnowledgeTaskWorktree) => void
}

export interface KnowledgeReviewInvocationOptions {
  binding?: KnowledgeAgentBinding
  agent?: KnowledgeReviewerRuntime
  invocation?: AgentInvocationContext
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function boundedError(error: unknown): string {
  const value = errorText(error)
  return value.length <= MAX_LIVE_ERROR_CHARACTERS
    ? value
    : `${value.slice(0, MAX_LIVE_ERROR_CHARACTERS - 1)}…`
}

function terminalStatus(signal: AbortSignal): 'failed' | 'cancelled' {
  return signal.aborted ? 'cancelled' : 'failed'
}

function isKnowledgeAgentId(value: unknown): value is KnowledgeAgentId {
  return typeof value === 'string' && KNOWLEDGE_AGENT_IDS.includes(value as KnowledgeAgentId)
}

function defaultInstructions(agentId: KnowledgeAgentId, stored?: StoredKnowledgeAgent): string {
  return stored?.defaultInstructionsOverride
    ?? knowledgeAgentDefinition(agentId).defaultInstructions
}

function connectionViews(snapshot: AiBackendSnapshot): AiConnectionView[] {
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

function selectedModel(connection: AiConnectionView | undefined, modelId: string | undefined) {
  return connection?.models.find((model) => model.id === modelId)
}

function normalizeAttention(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new Error('关注点格式无效')
  return value.trim() || undefined
}

function assertObservation(observation: AgentObservation): void {
  const { rawEvidence, canonicalActivity } = observation
  assertRawEvidence(rawEvidence)
  assertCanonicalActivity(canonicalActivity, rawEvidence)
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

function invocationSummary(
  connection: AiConnection,
  modelId: string,
  modelCallCount: number,
  toolCalls: string[],
  reasoningEffort?: ReasoningEffort
): AgentInvocationSummary {
  return {
    connectionId: connection.id,
    connectionName: connection.displayName,
    backendKind: connection.backendKind,
    providerId: connection.providerId,
    model: modelId,
    runtime: 'pi_coding_agent',
    modelCallCount,
    toolCalls,
    ...(reasoningEffort ? { reasoningEffort } : {})
  }
}

function worktreeView(worktree: KnowledgeTaskWorktree) {
  return {
    taskId: worktree.taskId,
    repositoryPath: worktree.repositoryPath,
    worktreePath: worktree.worktreePath,
    runtimePath: worktree.runtimePath,
    taskPath: worktree.taskPath,
    briefPath: worktree.briefPath,
    progressPath: worktree.progressPath,
    inputPath: worktree.inputPath,
    branchName: worktree.branchName,
    targetBranch: worktree.targetBranch,
    baseRepositoryRevision: worktree.baseRepositoryRevision,
    taskStartRepositoryRevision: worktree.taskStartRepositoryRevision
  }
}

export class KnowledgeProcessingService {
  private state: KnowledgeProcessingConfigurationData = { agents: [] }
  private configurationError?: string
  private mutationQueue: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<KnowledgeProcessingStateListener>()
  private readonly activeInvocations = new Map<string, {
    agentId: KnowledgeAgentId
    controller: AbortController
  }>()
  private readonly activeWorktrees = new Set<string>()
  private readonly liveInvocations = new Map<string, LiveAgentInvocationView>()
  private readonly unsubscribeAiBackend: () => void

  constructor(
    private readonly configuration: KnowledgeProcessingConfigurationRepository,
    private readonly aiBackend: AiBackendPort,
    private readonly tasks: KnowledgeTaskGitRepository,
    private readonly maintainer: KnowledgeMaintainerRuntime,
    private readonly reviewer: KnowledgeReviewerRuntime
  ) {
    this.unsubscribeAiBackend = aiBackend.subscribe(() => this.emit())
  }

  async initialize(): Promise<void> {
    try {
      this.state = await this.configuration.load()
      this.configurationError = undefined
    } catch (error) {
      this.state = { agents: [] }
      this.configurationError = `知识加工配置无法读取：${errorText(error)}`
    }
    await this.tasks.initialize()
  }

  stateView(): KnowledgeProcessingStateView {
    const backend = this.aiBackend.snapshot()
    const connections = connectionViews(backend)
    return structuredClone({
      agents: KNOWLEDGE_AGENT_DEFINITIONS.map((definition) => {
        const stored = this.state.agents.find((candidate) => candidate.agentId === definition.id)
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
      ...(backend.defaultLlm ? { defaultLlm: { ...backend.defaultLlm } } : {}),
      activeAgentIds: [...new Set(
        [...this.activeInvocations.values()].map(({ agentId }) => agentId)
      )],
      liveInvocations: [...this.liveInvocations.values()],
      ...(this.configurationError ? { configurationError: this.configurationError } : {})
    })
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation)
    this.mutationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  private assertConfigurationWritable(): void {
    if (this.configurationError) {
      throw new Error('知识加工配置当前不可修改；请先修复配置文件并重新启动 Oyster')
    }
  }

  saveAgent(input: SaveKnowledgeAgentInput): Promise<KnowledgeProcessingStateView> {
    return this.enqueueMutation(async () => {
      this.assertConfigurationWritable()
      if (!input || typeof input !== 'object' || !isKnowledgeAgentId(input.agentId)) {
        throw new Error('未知的知识 Agent')
      }
      if (input.instructionsOverride !== null && typeof input.instructionsOverride !== 'string') {
        throw new Error('System Prompt 配置无效')
      }
      const current = this.state.agents.find((agent) => agent.agentId === input.agentId)
      const normalized = input.instructionsOverride?.trim()
      if (input.instructionsOverride !== null && !normalized) {
        throw new Error('System Prompt 不能为空')
      }
      const instructionsOverride = normalized === defaultInstructions(input.agentId, current)
        ? undefined
        : normalized
      const next: StoredKnowledgeAgent = {
        agentId: input.agentId,
        ...(current?.defaultInstructionsOverride
          ? { defaultInstructionsOverride: current.defaultInstructionsOverride }
          : {}),
        ...(instructionsOverride ? { instructionsOverride } : {})
      }
      this.state = {
        agents: [
          ...this.state.agents.filter((agent) => agent.agentId !== input.agentId),
          next
        ]
      }
      await this.configuration.save(this.state)
      this.emit()
      return this.stateView()
    })
  }

  saveAgentDefaultInstructions(
    input: SaveKnowledgeAgentDefaultInstructionsInput
  ): Promise<KnowledgeProcessingStateView> {
    return this.enqueueMutation(async () => {
      this.assertConfigurationWritable()
      if (!input || typeof input !== 'object' || !isKnowledgeAgentId(input.agentId)) {
        throw new Error('未知的知识 Agent')
      }
      if (input.instructionsOverride !== null && typeof input.instructionsOverride !== 'string') {
        throw new Error('默认 System Prompt 配置无效')
      }
      const normalized = input.instructionsOverride?.trim()
      if (input.instructionsOverride !== null && !normalized) {
        throw new Error('默认 System Prompt 不能为空')
      }
      const configuredDefault = normalized === knowledgeAgentDefinition(input.agentId).defaultInstructions
        ? undefined
        : normalized
      const current = this.state.agents.find((agent) => agent.agentId === input.agentId)
      const next: StoredKnowledgeAgent = {
        agentId: input.agentId,
        ...(configuredDefault ? { defaultInstructionsOverride: configuredDefault } : {}),
        ...(current?.instructionsOverride ? { instructionsOverride: current.instructionsOverride } : {})
      }
      this.state = {
        agents: [
          ...this.state.agents.filter((agent) => agent.agentId !== input.agentId),
          next
        ]
      }
      await this.configuration.save(this.state)
      this.emit()
      return this.stateView()
    })
  }

  agentBinding(agentId: KnowledgeAgentId): KnowledgeAgentBinding {
    const stored = this.state.agents.find((candidate) => candidate.agentId === agentId)
    const backend = this.aiBackend.snapshot()
    const binding = backend.defaultLlm
    if (!binding) throw new Error('请先在 AI 后端页面配置默认 LLM')
    const connection = connectionViews(backend)
      .find((candidate) => candidate.id === binding.connectionId)
    if (!connection) throw new Error('默认 LLM 的 Connection 当前不可用')
    const model = selectedModel(connection, binding.modelId)
    if (!model) throw new Error('默认 LLM 的 Model 当前不可用，系统不会自动回退')
    if (binding.reasoningEffort && !model.reasoningEfforts.includes(binding.reasoningEffort)) {
      throw new Error('默认 LLM 的思考强度不再受当前 Model 支持')
    }
    return structuredClone({
      connectionId: binding.connectionId,
      modelId: model.id,
      instructions: stored?.instructionsOverride ?? defaultInstructions(agentId, stored),
      ...(binding.reasoningEffort ? { reasoningEffort: binding.reasoningEffort } : {})
    })
  }

  private beginInvocation(agentId: KnowledgeAgentId, invocationId: string): AbortController {
    const controller = new AbortController()
    this.activeInvocations.set(invocationId, { agentId, controller })
    this.emit()
    return controller
  }

  private finishInvocation(invocationId: string, controller: AbortController): void {
    if (this.activeInvocations.get(invocationId)?.controller === controller) {
      this.activeInvocations.delete(invocationId)
    }
    this.emit()
  }

  private beginWorktree(worktreePath: string): void {
    if (this.activeWorktrees.has(worktreePath)) {
      throw new Error('这个 Task worktree 已有 Agent 正在执行')
    }
    this.activeWorktrees.add(worktreePath)
  }

  private finishWorktree(worktreePath: string | undefined): void {
    if (worktreePath) this.activeWorktrees.delete(worktreePath)
  }

  private recordInvocation(
    context: AgentInvocationContext,
    debugRecord: AgentInvocationDebugRecord
  ): void {
    const parsed = parseAgentInvocationDebugRecord(debugRecord, context.invocationId)
    this.liveInvocations.set(context.invocationId, { origin: context.origin, invocation: parsed })
    this.emit()
  }

  private settleInvocation(
    context: AgentInvocationContext,
    invocation: AgentInvocationRecord
  ): void {
    const parsed = parseAgentInvocationRecord(invocation, context.invocationId)
    const view = this.liveInvocations.get(context.invocationId)
    if (!view || view.origin !== context.origin) return
    Object.assign(view.invocation, parsed)
    this.emit()
  }

  clearLiveInvocations(origin: AgentInvocationOrigin): void {
    let changed = false
    for (const [invocationId, view] of this.liveInvocations) {
      if (view.origin !== origin) continue
      this.liveInvocations.delete(invocationId)
      changed = true
    }
    if (changed) this.emit()
  }

  private failLiveInvocation(
    context: AgentInvocationContext,
    status: 'failed' | 'cancelled',
    error: unknown
  ): void {
    const view = this.liveInvocations.get(context.invocationId)
    if (
      !view
      || view.origin !== context.origin
      || view.invocation.status !== 'in_progress'
    ) return
    const completedAt = new Date().toISOString()
    view.invocation.status = status
    view.invocation.completedAt = completedAt
    view.invocation.durationMs = Math.max(
      0,
      new Date(completedAt).getTime() - new Date(view.invocation.startedAt).getTime()
    )
    view.invocation.error = status === 'cancelled'
      ? '知识 Agent Invocation 已取消'
      : boundedError(error)
    this.emit()
  }

  invocationRecord(context: AgentInvocationContext): AgentInvocationRecord | undefined {
    const view = this.liveInvocations.get(context.invocationId)
    return view?.origin === context.origin
      ? parseAgentInvocationRecord(view.invocation)
      : undefined
  }

  async executeMaintenance(
    observation: AgentObservation,
    sourceRef: string,
    attention?: string,
    options: KnowledgeMaintenanceInvocationOptions = {}
  ): Promise<KnowledgeMaintenanceResult> {
    assertObservation(observation)
    if (!sourceRef.trim() || sourceRef.length > MAX_SOURCE_REF_CHARACTERS) {
      throw new Error('Raw Evidence sourceRef 无效')
    }
    const normalizedAttention = normalizeAttention(attention)
    const binding = options.binding ?? this.agentBinding('knowledge_maintainer')
    const connection = this.aiBackend.snapshot().connections.find(
      (item) => item.id === binding.connectionId
    )
    if (!connection) throw new Error('已配置的 Connection 不再可用')
    const invocation = options.invocation ?? {
      invocationId: randomUUID(),
      origin: 'agent_preview' as const
    }
    if (!options.invocation) this.clearLiveInvocations(invocation.origin)
    const controller = this.beginInvocation('knowledge_maintainer', invocation.invocationId)
    let activeWorktreePath: string | undefined
    const startedAt = Date.now()
    try {
      return await this.aiBackend.withModelStream(
        binding.connectionId,
        binding.modelId,
        async (modelStream) => {
          if (
            observation.canonicalActivity.attachments.some(
              (attachment) => attachment.mimeType.startsWith('image/')
            )
            && !modelStream.model.input?.includes('image')
          ) throw new Error('所选 Maintainer Model 不支持图片输入')
          const taskId = options.worktree?.taskId ?? options.taskId ?? randomUUID()
          const inputPlan = planKnowledgeTaskInput(
            observation,
            sourceRef,
            activitySegmentCharacterLimit(modelStream.model.contextWindow)
          )
          const worktreeInput = {
            taskId,
            sourceRef,
            attention: normalizedAttention,
            plan: inputPlan,
            kind: invocation.origin === 'knowledge_task' ? 'task' as const : 'preview' as const,
            taskRecord: options.taskRecord
          }
          const worktree = options.worktree
            ?? await this.tasks.createWorktree(worktreeInput)
          if (!options.worktree) options.onWorktreeCreated?.(worktree)
          this.beginWorktree(worktree.worktreePath)
          activeWorktreePath = worktree.worktreePath
          const expectedRepositoryRevision = options.previousRepositoryRevision
            ?? worktree.taskStartRepositoryRevision
          const previousRepositoryRevision = await this.tasks.prepareAgentTurn(
            worktree,
            expectedRepositoryRevision
          )
          const result = await (options.agent ?? this.maintainer).invoke({
            modelStream,
            systemPrompt: binding.instructions,
            worktree,
            previousRepositoryRevision,
            reasoningEffort: binding.reasoningEffort,
            invocationId: invocation.invocationId,
            onInvocationUpdate: (record) => this.recordInvocation(invocation, record),
            signal: controller.signal
          })
          const handoff = await this.tasks.checkpointMaintainer(
            worktree,
            previousRepositoryRevision,
            result.invocation.id
          )
          this.settleInvocation(invocation, result.invocation)
          return {
            agentId: 'knowledge_maintainer' as const,
            sourceRef,
            activitySegmentCount: inputPlan.activitySegmentCount,
            worktree: worktreeView(worktree),
            previousRepositoryRevision: handoff.previousRepositoryRevision,
            candidateRepositoryRevision: handoff.candidateRepositoryRevision,
            changedPaths: handoff.changedPaths,
            agentInvocationId: result.invocation.id,
            durationMs: Date.now() - startedAt,
            completedAt: new Date().toISOString(),
            invocation: invocationSummary(
              connection,
              binding.modelId,
              result.modelCallCount,
              result.toolCalls,
              binding.reasoningEffort
            )
          }
        },
        { trackHealth: true }
      )
    } catch (error) {
      this.failLiveInvocation(invocation, terminalStatus(controller.signal), error)
      throw error
    } finally {
      this.finishWorktree(activeWorktreePath)
      this.finishInvocation(invocation.invocationId, controller)
    }
  }

  async executeReview(
    worktree: KnowledgeTaskWorktree,
    reviewedRepositoryRevision: string,
    options: KnowledgeReviewInvocationOptions = {}
  ): Promise<KnowledgeReviewResult> {
    const binding = options.binding ?? this.agentBinding('knowledge_reviewer')
    const connection = this.aiBackend.snapshot().connections.find(
      (item) => item.id === binding.connectionId
    )
    if (!connection) throw new Error('已配置的 Connection 不再可用')
    const invocation = options.invocation ?? {
      invocationId: randomUUID(),
      origin: 'agent_preview' as const
    }
    if (!options.invocation) this.clearLiveInvocations(invocation.origin)
    const controller = this.beginInvocation('knowledge_reviewer', invocation.invocationId)
    let activeWorktreePath: string | undefined
    const startedAt = Date.now()
    try {
      return await this.aiBackend.withModelStream(
        binding.connectionId,
        binding.modelId,
        async (modelStream) => {
          this.beginWorktree(worktree.worktreePath)
          activeWorktreePath = worktree.worktreePath
          const actualReviewedRepositoryRevision = await this.tasks.prepareAgentTurn(
            worktree,
            reviewedRepositoryRevision
          )
          const result = await (options.agent ?? this.reviewer).invoke({
            modelStream,
            systemPrompt: binding.instructions,
            worktree,
            reviewedRepositoryRevision: actualReviewedRepositoryRevision,
            reasoningEffort: binding.reasoningEffort,
            invocationId: invocation.invocationId,
            onInvocationUpdate: (record) => this.recordInvocation(invocation, record),
            signal: controller.signal
          })
          const decision = await this.tasks.checkpointReview(
            worktree,
            actualReviewedRepositoryRevision,
            result.invocation.id
          )
          this.settleInvocation(invocation, result.invocation)
          return {
            agentId: 'knowledge_reviewer' as const,
            decision: decision.kind,
            reviewedRepositoryRevision: decision.reviewedRepositoryRevision,
            candidateRepositoryRevision: decision.candidateRepositoryRevision,
            changedPaths: decision.kind === 'changes_requested' ? decision.changedPaths : [],
            markerPaths: decision.kind === 'changes_requested' ? decision.markerPaths : [],
            agentInvocationId: result.invocation.id,
            durationMs: Date.now() - startedAt,
            completedAt: new Date().toISOString(),
            invocation: invocationSummary(
              connection,
              binding.modelId,
              result.modelCallCount,
              result.toolCalls,
              binding.reasoningEffort
            )
          }
        },
        { trackHealth: true }
      )
    } catch (error) {
      this.failLiveInvocation(invocation, terminalStatus(controller.signal), error)
      throw error
    } finally {
      this.finishWorktree(activeWorktreePath)
      this.finishInvocation(invocation.invocationId, controller)
    }
  }

  cancelAgentInvocation(agentId: KnowledgeAgentId): void {
    if (!isKnowledgeAgentId(agentId)) throw new Error('未知的知识 Agent')
    for (const active of this.activeInvocations.values()) {
      if (active.agentId === agentId) {
        active.controller.abort(new Error('用户取消了 Agent Invocation'))
      }
    }
  }

  subscribe(listener: KnowledgeProcessingStateListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    const state = this.stateView()
    for (const listener of this.listeners) listener(state)
  }

  dispose(): void {
    for (const { controller } of this.activeInvocations.values()) {
      controller.abort(new Error('Oyster 正在退出'))
    }
    this.activeInvocations.clear()
    this.activeWorktrees.clear()
    this.unsubscribeAiBackend()
    this.listeners.clear()
  }
}

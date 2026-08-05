import { randomUUID } from 'node:crypto'
import {
  PROCESSING_STAGE_IDS,
  type KnowledgeMaintenanceResult,
  type KnowledgeProcessingDebugTrace,
  type KnowledgeProcessingSnapshot,
  type ProcessingConnectionView,
  type ProcessingDebugTraceOrigin,
  type ProcessingExecutionSummary,
  type ProcessingStageId,
  type SaveProcessingDefaultInstructionsInput,
  type SaveProcessingStageInput
} from '../../shared/knowledge-processing'
import type { AiBackendSnapshot, AiConnection, ReasoningEffort } from '../../shared/ai-backends'
import type { RawEvidence } from '../observation/model'
import type {
  AiBackendPort,
  KnowledgeAgentTraceEvent,
  KnowledgeAgentRuntime,
  KnowledgeProcessingRepository,
  KnowledgeProcessingStateData,
  ProcessingSnapshotListener,
  StoredProcessingStage
} from './model'
import { PROCESSING_STAGE_DEFINITIONS, stageDefinition } from './prompts'
import { KNOWLEDGE_MAINTENANCE_TOOL_CATALOG } from './knowledge-maintenance-tool-catalog'
import { planEvidenceSegmentTodos } from './evidence-segment-todos'

const MAX_SOURCE_REF_CHARACTERS = 512
const MAX_DEBUG_TRACE_ERROR_CHARACTERS = 2 * 1_024
const MAX_DEBUG_TRACE_DETAIL_CHARACTERS = 1 * 1_024
const MAX_DEBUG_TRACE_EVENT_PAYLOAD_CHARACTERS = 64 * 1_024

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
  knowledgeAgent?: KnowledgeAgentRuntime
  contributionRunRef?: string
  debugTrace?: ProcessingDebugTraceContext
  initialTodos?: readonly string[]
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function boundedDebugText(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`
}

function setBoundedEventPayload(
  target: {
    input?: string
    inputTruncated?: boolean
    output?: string
    outputTruncated?: boolean
  },
  field: 'input' | 'output',
  value?: string
): void {
  if (value === undefined) return
  target[field] = boundedDebugText(value, MAX_DEBUG_TRACE_EVENT_PAYLOAD_CHARACTERS)
  if (value.length > MAX_DEBUG_TRACE_EVENT_PAYLOAD_CHARACTERS) {
    target[field === 'input' ? 'inputTruncated' : 'outputTruncated'] = true
  }
}

function debugError(error: unknown): string {
  return boundedDebugText(errorText(error), MAX_DEBUG_TRACE_ERROR_CHARACTERS)
}

function traceTerminalStatus(signal: AbortSignal): 'failed' | 'cancelled' {
  return signal.aborted ? 'cancelled' : 'failed'
}

const KNOWLEDGE_TOOL_LABELS: Record<string, string> = Object.fromEntries(
  KNOWLEDGE_MAINTENANCE_TOOL_CATALOG.map((tool) => [tool.name, tool.label])
)

function knowledgeToolLabel(toolName: string): string {
  return KNOWLEDGE_TOOL_LABELS[toolName] ?? '未知工具'
}

function safeKnowledgeToolName(toolName: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(KNOWLEDGE_TOOL_LABELS, toolName)
    ? toolName
    : undefined
}

function isStageId(value: unknown): value is ProcessingStageId {
  return typeof value === 'string' && PROCESSING_STAGE_IDS.includes(value as ProcessingStageId)
}

function defaultInstructions(
  stageId: ProcessingStageId,
  stored?: StoredProcessingStage
): string {
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

function selectedModel(
  connection: ProcessingConnectionView | undefined,
  modelId: string | undefined
) {
  return connection?.models.find((model) => model.id === modelId)
}

function normalizeAttention(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new Error('关注点格式无效')
  const normalized = value.trim()
  return normalized || undefined
}

function assertRawEvidence(evidence: RawEvidence): void {
  if (
    !evidence
    || typeof evidence !== 'object'
    || typeof evidence.formatVersion !== 'string'
    || !evidence.formatVersion.trim()
    || evidence.formatVersion.length > 128
    || !Array.isArray(evidence.lines)
    || !evidence.lines.length
    || evidence.lines.some((line) => typeof line !== 'string' || /[\r\n]/.test(line))
    || !evidence.lines.some((line) => line.trim())
    || !Array.isArray(evidence.skillHints)
  ) {
    throw new Error('Raw Evidence 无效')
  }
  for (const hint of evidence.skillHints) {
    const line = hint?.location?.line
    const offset = hint?.location?.offset
    const sourceLine = Number.isSafeInteger(line) ? evidence.lines[line - 1] : undefined
    if (
      !Number.isSafeInteger(line)
      || !Number.isSafeInteger(offset)
      || line < 1
      || offset < 0
      || sourceLine === undefined
      || offset > sourceLine.length
      || (hint.name !== undefined && (typeof hint.name !== 'string' || !hint.name.trim()))
      || (hint.tool !== undefined && (typeof hint.tool !== 'string' || !hint.tool.trim()))
      || (hint.source !== 'runtime_injection' && hint.source !== 'tool_call')
    ) throw new Error('Raw Evidence Skill hint 无效')
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

export class KnowledgeProcessingService {
  private state: KnowledgeProcessingStateData = { stages: [] }
  private configurationError?: string
  private mutationQueue: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<ProcessingSnapshotListener>()
  private readonly activeRuns = new Map<ProcessingStageId, AbortController>()
  private readonly debugTraces = new Map<ProcessingDebugTraceOrigin, KnowledgeProcessingDebugTrace>()
  private readonly maintenanceToolTraceIds = new Map<ProcessingDebugTraceOrigin, {
    traceId: string
    eventIds: Map<string, string>
  }>()
  private exclusiveLease?: ProcessingRunLease
  private readonly unsubscribeAiBackend: () => void

  constructor(
    private readonly repository: KnowledgeProcessingRepository,
    private readonly aiBackend: AiBackendPort,
    private readonly knowledgeAgent: KnowledgeAgentRuntime
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
      ...(backendSnapshot.defaultLlm
        ? { defaultLlm: { ...backendSnapshot.defaultLlm } }
        : {}),
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

      const currentStage = this.state.stages.find((candidate) => candidate.stageId === input.stageId)
      let instructionsOverride: string | undefined
      if (typeof input.instructionsOverride === 'string') {
        instructionsOverride = input.instructionsOverride.trim()
        if (!instructionsOverride) throw new Error('System Prompt 不能为空')
        if (instructionsOverride === defaultInstructions(input.stageId, currentStage)) {
          instructionsOverride = undefined
        }
      }
      const nextStage: StoredProcessingStage = {
        stageId: input.stageId,
        ...(currentStage?.defaultInstructionsOverride
          ? { defaultInstructionsOverride: currentStage.defaultInstructionsOverride }
          : {}),
        ...(instructionsOverride ? { instructionsOverride } : {})
      }
      const nextState = { stages: [nextStage] }
      await this.repository.save(nextState)
      this.state = nextState
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
      let configuredDefault: string | undefined
      if (typeof input.instructionsOverride === 'string') {
        configuredDefault = input.instructionsOverride.trim()
        if (!configuredDefault) throw new Error('默认 System Prompt 不能为空')
        if (configuredDefault === stageDefinition(input.stageId).defaultInstructions) {
          configuredDefault = undefined
        }
      }
      const currentStage = this.state.stages.find((candidate) => candidate.stageId === input.stageId)
      const nextStage: StoredProcessingStage = {
        ...currentStage,
        stageId: input.stageId,
        ...(configuredDefault ? { defaultInstructionsOverride: configuredDefault } : {})
      }
      if (!configuredDefault) delete nextStage.defaultInstructionsOverride
      const nextState = { stages: [nextStage] }
      await this.repository.save(nextState)
      this.state = nextState
      this.emit()
      return this.snapshot()
    })
  }

  private configuredStage(stageId: ProcessingStageId): ProcessingStageRunBinding {
    const stored = this.state.stages.find((candidate) => candidate.stageId === stageId)
    const backendSnapshot = this.aiBackend.snapshot()
    const binding = backendSnapshot.defaultLlm
    if (!binding) throw new Error('请先在 AI 后端页面配置默认 LLM')
    const connection = processingConnections(backendSnapshot).find((candidate) => candidate.id === binding.connectionId)
    if (!connection) throw new Error('默认 LLM 的 Connection 当前不可用')
    const model = selectedModel(connection, binding.modelId)
    if (!model) throw new Error('默认 LLM 的 Model 当前不可用，系统不会自动回退到其他 Model')
    if (binding.reasoningEffort && !model.reasoningEfforts.includes(binding.reasoningEffort)) {
      throw new Error('默认 LLM 的思考强度不再受当前 Model 支持，系统不会自动改用模型默认值')
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
    if (this.exclusiveLease || this.activeRuns.size) {
      throw new Error('已有知识加工运行正在占用工作区')
    }
    const lease = Object.freeze({ id: randomUUID() })
    this.exclusiveLease = lease
    return lease
  }

  releaseExclusiveRun(lease: ProcessingRunLease): void {
    if (this.exclusiveLease !== lease) throw new Error('知识加工运行租约无效')
    if (this.activeRuns.size) throw new Error('知识加工阶段尚未结束，不能释放运行租约')
    this.exclusiveLease = undefined
  }

  private beginRun(lease?: ProcessingRunLease): AbortController {
    if (this.exclusiveLease && this.exclusiveLease !== lease) {
      throw new Error('完整链路正在运行，不能启动独立阶段')
    }
    if (!this.exclusiveLease && lease) throw new Error('知识加工运行租约已失效')
    if (this.activeRuns.size) throw new Error('已有知识加工阶段正在运行')
    const controller = new AbortController()
    this.activeRuns.set('knowledge_maintenance_agent', controller)
    this.emit()
    return controller
  }

  private finishRun(controller: AbortController): void {
    if (this.activeRuns.get('knowledge_maintenance_agent') === controller) {
      this.activeRuns.delete('knowledge_maintenance_agent')
    }
    this.emit()
  }

  beginFullChainDebugTrace(context: ProcessingDebugTraceContext): void {
    if (context.origin !== 'full_chain') throw new Error('完整链路调试轨迹来源无效')
    this.beginMaintenanceDebugTrace(context)
  }

  private beginMaintenanceDebugTrace(context: ProcessingDebugTraceContext): void {
    const trace: KnowledgeProcessingDebugTrace = {
      id: context.id,
      origin: context.origin,
      status: 'running',
      startedAt: new Date().toISOString(),
      maintenance: {
        modelCallCount: 0,
        toolCallCount: 0,
        events: []
      }
    }
    this.maintenanceToolTraceIds.set(context.origin, {
      traceId: context.id,
      eventIds: new Map()
    })
    this.debugTraces.set(context.origin, trace)
    this.emit()
  }

  private updateDebugTrace(
    context: ProcessingDebugTraceContext,
    update: (trace: KnowledgeProcessingDebugTrace) => void
  ): void {
    const trace = this.debugTraces.get(context.origin)
    if (!trace || trace.id !== context.id) return
    update(trace)
    this.emit()
  }

  private finishMaintenanceToolTrace(context: ProcessingDebugTraceContext): void {
    const toolTraceIds = this.maintenanceToolTraceIds.get(context.origin)
    if (toolTraceIds?.traceId === context.id) this.maintenanceToolTraceIds.delete(context.origin)
  }

  private completeStageDebugTrace(context: ProcessingDebugTraceContext): KnowledgeProcessingDebugTrace {
    this.finishMaintenanceToolTrace(context)
    this.updateDebugTrace(context, (trace) => {
      if (context.origin === 'stage_debug') {
        trace.status = 'completed'
        trace.completedAt = new Date().toISOString()
      }
      delete trace.error
    })
    return this.debugTraceSnapshot(context)
  }

  completeFullChainDebugTrace(context: ProcessingDebugTraceContext): KnowledgeProcessingDebugTrace {
    if (context.origin !== 'full_chain') throw new Error('完整链路调试轨迹来源无效')
    this.updateDebugTrace(context, (trace) => {
      trace.status = 'completed'
      trace.completedAt = new Date().toISOString()
      delete trace.error
    })
    return this.debugTraceSnapshot(context)
  }

  failFullChainDebugTrace(
    context: ProcessingDebugTraceContext,
    status: 'failed' | 'cancelled',
    error: unknown
  ): void {
    if (context.origin === 'full_chain') this.failDebugTrace(context, status, error)
  }

  private failDebugTrace(
    context: ProcessingDebugTraceContext,
    status: 'failed' | 'cancelled',
    error: unknown
  ): void {
    const completedAt = new Date().toISOString()
    this.updateDebugTrace(context, (trace) => {
      const hasFailedEvent = trace.maintenance.events.some(
        (event) => event.status === 'failed' || event.status === 'cancelled'
      )
      const message = status === 'cancelled'
        ? '知识加工运行已取消'
        : hasFailedEvent ? '知识维护 Agent 运行失败' : debugError(error)
      trace.status = status
      trace.completedAt = completedAt
      trace.error = message
      for (const event of trace.maintenance.events) {
        if (event.status !== 'running') continue
        event.status = status
        event.completedAt = completedAt
        event.durationMs = Date.now() - new Date(event.startedAt).getTime()
        event.detail ??= message
      }
    })
    this.finishMaintenanceToolTrace(context)
  }

  private debugTraceSnapshot(context: ProcessingDebugTraceContext): KnowledgeProcessingDebugTrace {
    const trace = this.debugTraces.get(context.origin)
    if (!trace || trace.id !== context.id) throw new Error('知识加工调试轨迹已失效')
    return structuredClone(trace)
  }

  private recordKnowledgeAgentTrace(
    context: ProcessingDebugTraceContext,
    event: KnowledgeAgentTraceEvent
  ): void {
    this.updateDebugTrace(context, (trace) => {
      const maintenance = trace.maintenance
      if (event.type === 'model_started') {
        maintenance.modelCallCount = Math.max(maintenance.modelCallCount, event.callNumber)
        maintenance.events.push({
          id: `model-call-${event.callNumber}`,
          sequence: maintenance.events.length + 1,
          kind: 'model_call',
          label: event.purpose === 'context_compaction'
            ? `上下文压缩 ${event.callNumber}`
            : `模型轮次 ${event.callNumber}`,
          status: 'running',
          startedAt: new Date().toISOString()
        })
        return
      }
      if (event.type === 'model_completed') {
        const modelEvent = maintenance.events.find(
          (candidate) => candidate.id === `model-call-${event.callNumber}`
        )
        if (!modelEvent || modelEvent.status !== 'running') return
        modelEvent.status = event.status
        modelEvent.completedAt = new Date().toISOString()
        modelEvent.durationMs = Date.now() - new Date(modelEvent.startedAt).getTime()
        if (event.detail) modelEvent.detail = boundedDebugText(event.detail, MAX_DEBUG_TRACE_DETAIL_CHARACTERS)
        setBoundedEventPayload(modelEvent, 'output', event.output)
        return
      }
      if (event.type === 'workspace_status') {
        maintenance.workspace = {
          todos: { ...event.todos },
          draftStatementCount: event.draftStatementCount
        }
        return
      }

      const toolName = safeKnowledgeToolName(event.toolName)
      const traceToolName = toolName ?? 'unknown_tool'
      if (event.type === 'tool_started') {
        maintenance.toolCallCount++
        const eventId = `tool-call-${maintenance.toolCallCount}`
        const toolTraceIds = this.maintenanceToolTraceIds.get(context.origin)
        if (toolTraceIds?.traceId === context.id) {
          toolTraceIds.eventIds.set(event.toolCallId, eventId)
        }
        maintenance.events.push({
          id: eventId,
          sequence: maintenance.events.length + 1,
          kind: 'tool_call',
          label: knowledgeToolLabel(event.toolName),
          status: 'running',
          startedAt: new Date().toISOString(),
          detail: traceToolName
        })
        setBoundedEventPayload(maintenance.events.at(-1)!, 'input', event.input)
        return
      }
      const toolTraceIds = this.maintenanceToolTraceIds.get(context.origin)
      const eventId = toolTraceIds?.traceId === context.id
        ? toolTraceIds.eventIds.get(event.toolCallId)
        : undefined
      if (eventId) toolTraceIds?.eventIds.delete(event.toolCallId)
      const toolEvent = eventId
        ? maintenance.events.find((candidate) => candidate.id === eventId)
        : undefined
      if (!toolEvent || toolEvent.status !== 'running') return
      toolEvent.status = event.status
      toolEvent.completedAt = new Date().toISOString()
      toolEvent.durationMs = Date.now() - new Date(toolEvent.startedAt).getTime()
      if (event.detail) toolEvent.detail = boundedDebugText(event.detail, MAX_DEBUG_TRACE_DETAIL_CHARACTERS)
      setBoundedEventPayload(toolEvent, 'output', event.output)
    })
  }

  async runKnowledgeMaintenance(
    evidence: RawEvidence,
    sourceRef: string,
    attention?: string,
    options: KnowledgeMaintenanceRunOptions = {}
  ): Promise<KnowledgeMaintenanceResult> {
    assertRawEvidence(evidence)
    if (typeof sourceRef !== 'string' || !sourceRef.trim() || sourceRef.length > MAX_SOURCE_REF_CHARACTERS) {
      throw new Error('Raw Evidence sourceRef 无效')
    }
    const normalizedAttention = normalizeAttention(attention)
    const stage = options.binding ?? this.configuredStage('knowledge_maintenance_agent')
    const connection = this.aiBackend.snapshot().connections.find((item) => item.id === stage.connectionId)
    if (!connection) throw new Error('已配置的 Connection 不再可用')
    const plan = planEvidenceSegmentTodos(evidence)
    const controller = this.beginRun(options.lease)
    const debugTrace = options.debugTrace ?? { id: randomUUID(), origin: 'stage_debug' }
    this.beginMaintenanceDebugTrace(debugTrace)
    const startedAt = Date.now()

    try {
      const result = await this.aiBackend.withModelRuntime(
        stage.connectionId,
        stage.modelId,
        (runtime) => (options.knowledgeAgent ?? this.knowledgeAgent).run({
          runtime,
          systemPrompt: stage.instructions,
          evidenceLines: evidence.lines,
          evidenceFormatVersion: evidence.formatVersion,
          sourceRef,
          contributionRunRef: options.contributionRunRef ?? `manual:${randomUUID()}`,
          attention: normalizedAttention,
          initialTodos: [...plan.todos, ...(options.initialTodos ?? [])],
          reasoningEffort: stage.reasoningEffort,
          onTrace: (event) => {
            try {
              this.recordKnowledgeAgentTrace(debugTrace, event)
            } catch {
              // Debug telemetry must never change the Agent result.
            }
          },
          signal: controller.signal
        }),
        { trackHealth: true }
      )
      controller.signal.throwIfAborted()
      this.updateDebugTrace(debugTrace, (trace) => {
        trace.maintenance.modelCallCount = result.modelCallCount
        trace.maintenance.toolCallCount = result.toolCalls.length
      })
      const completedDebugTrace = this.completeStageDebugTrace(debugTrace)
      return {
        stageId: 'knowledge_maintenance_agent',
        sourceRef,
        evidenceSegmentCount: plan.segmentCount,
        contribution: result.contribution,
        todos: result.todos.map((todo) => ({ ...todo })),
        debugTrace: completedDebugTrace,
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
    } catch (error) {
      this.failDebugTrace(debugTrace, traceTerminalStatus(controller.signal), error)
      throw error
    } finally {
      this.finishRun(controller)
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
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        // Snapshot observers are diagnostics/UI plumbing and must not change processing results.
      }
    }
  }

  dispose(): void {
    this.unsubscribeAiBackend()
    for (const controller of this.activeRuns.values()) controller.abort(new Error('Oyster 正在退出'))
    this.activeRuns.clear()
    this.exclusiveLease = undefined
    this.debugTraces.clear()
    this.maintenanceToolTraceIds.clear()
    this.listeners.clear()
  }
}

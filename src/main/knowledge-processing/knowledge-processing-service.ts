import { randomUUID } from 'node:crypto'
import {
  PROCESSING_STAGE_IDS,
  type KnowledgeMaintenanceResult,
  type KnowledgeProcessingDebugTrace,
  type KnowledgeProcessingSnapshot,
  type ObservationPreprocessingProgress,
  type ObservationPreprocessingResult,
  type ProcessingConnectionView,
  type ProcessingDebugStatus,
  type ProcessingDebugTraceOrigin,
  type ProcessingExecutionSummary,
  type ProcessingStageId,
  type RunKnowledgeMaintenanceInput,
  type RunObservationPreprocessorInput,
  type SaveProcessingStageInput
} from '../../shared/knowledge-processing'
import {
  REASONING_EFFORTS,
  type AiConnection,
  type ReasoningEffort
} from '../../shared/ai-backends'
import type {
  AiBackendPort,
  EvidenceMapSection,
  KnowledgeAgentTraceEvent,
  KnowledgeAgentRuntime,
  KnowledgeProcessingRepository,
  KnowledgeProcessingStateData,
  PreprocessingWorkspace,
  ProcessingSnapshotListener,
  StoredProcessingStage
} from './model'
import {
  DEFAULT_ADJACENT_CONTEXT_CHARACTERS,
  DEFAULT_MAP_MERGE_CHARACTERS,
  DEFAULT_OBSERVATION_SEGMENT_CHARACTERS,
  evidenceMapNodeText,
  groupEvidenceMapNodes,
  numberedObservation,
  observationSelector,
  planObservationSegments,
  resolveEvidenceMapPlannerOptions,
  type EvidenceMapNode,
  type EvidenceMapPlannerOptions,
  type ObservationSegment,
  type ResolvedEvidenceMapPlannerOptions
} from './evidence-map-planner'
import { PROCESSING_STAGE_DEFINITIONS, stageDefinition } from './prompts'

const MAX_INSTRUCTIONS_CHARACTERS = 20_000
const MAX_MANUAL_OBSERVATION_CHARACTERS = 120_000
const MAX_SEGMENTED_OBSERVATION_CHARACTERS = 16 * 1024 * 1024
const MAX_ATTENTION_CHARACTERS = 10_000
const MAX_SOURCE_REF_CHARACTERS = 512
const MAX_PREPROCESSOR_PROMPT_STRUCTURE_CHARACTERS = 8 * 1_024
const MAX_EVIDENCE_MAP_CHARACTERS = 128 * 1_024
const MAX_EVIDENCE_MAP_SECTION_CHARACTERS = 24 * 1_024
const MAX_PREPROCESSOR_SEGMENTS = 32
const MAX_PREPROCESSOR_MODEL_CALLS = MAX_PREPROCESSOR_SEGMENTS * 2 - 1
const MAX_PREPROCESSOR_RUN_MS = 30 * 60_000
const MAX_WORKSPACES = 20
const MAX_WORKSPACE_CHARACTERS = 64 * 1024 * 1024
const ESTIMATED_OBSERVATION_LINE_OVERHEAD = 16
const MAX_DEBUG_TRACE_ERROR_CHARACTERS = 2 * 1_024
const MAX_DEBUG_TRACE_DETAIL_CHARACTERS = 1 * 1_024
const MAX_DEBUG_TRACE_PREPROCESSOR_OUTPUT_CHARACTERS = 8 * 1_024

const MAX_PREPROCESSOR_MODEL_INPUT_CHARACTERS = MAX_INSTRUCTIONS_CHARACTERS
  + MAX_ATTENTION_CHARACTERS
  + MAX_SOURCE_REF_CHARACTERS
  + Math.max(DEFAULT_OBSERVATION_SEGMENT_CHARACTERS, DEFAULT_MAP_MERGE_CHARACTERS)
  + DEFAULT_ADJACENT_CONTEXT_CHARACTERS
  + MAX_PREPROCESSOR_PROMPT_STRUCTURE_CHARACTERS

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

export interface ObservationPreprocessorRunOptions {
  binding?: ProcessingStageRunBinding
  lease?: ProcessingRunLease
  sourceRef?: string
  allowSegmentedObservation?: boolean
  debugTrace?: ProcessingDebugTraceContext
}

export interface KnowledgeMaintenanceRunOptions {
  binding?: ProcessingStageRunBinding
  lease?: ProcessingRunLease
  knowledgeAgent?: KnowledgeAgentRuntime
  contributionRunRef?: string
  debugTrace?: ProcessingDebugTraceContext
}

export interface KnowledgeProcessingServiceOptions {
  evidenceMapPlanner?: EvidenceMapPlannerOptions
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

class PreprocessingDeadlineExceededError extends Error {}

function traceTerminalStatus(signal: AbortSignal): 'failed' | 'cancelled' {
  if (!signal.aborted) return 'failed'
  return signal.reason instanceof PreprocessingDeadlineExceededError ? 'failed' : 'cancelled'
}

const KNOWLEDGE_TOOL_LABELS: Record<string, string> = {
  search_knowledge: '搜索已有知识',
  read_knowledge_statement: '读取 Knowledge Statement',
  read_evidence_map_section: '展开局部 Evidence Map',
  read_evidence: '读取原始观察证据',
  submit_knowledge_contribution: '提交 Knowledge Contribution'
}

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

function processingConnections(aiBackend: AiBackendPort): ProcessingConnectionView[] {
  return aiBackend.snapshot().connections.flatMap((connection) => {
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
  if (!normalized) return undefined
  if (normalized.length > MAX_ATTENTION_CHARACTERS) throw new Error('关注点内容过长')
  return normalized
}

function assertObservationInput(
  input: unknown,
  allowSegmentedObservation: boolean
): asserts input is RunObservationPreprocessorInput {
  if (!input || typeof input !== 'object') throw new Error('观察预处理输入无效')
  const observation = (input as Record<string, unknown>).observation
  if (typeof observation !== 'string' || !observation.trim()) throw new Error('请输入需要处理的 Observation')
  const maximum = allowSegmentedObservation
    ? MAX_SEGMENTED_OBSERVATION_CHARACTERS
    : MAX_MANUAL_OBSERVATION_CHARACTERS
  if (observation.length > maximum) {
    throw new Error(`Observation 不能超过 ${maximum} 个字符`)
  }
  normalizeAttention((input as Record<string, unknown>).attention)
}

function assertMaintenanceInput(input: unknown): asserts input is RunKnowledgeMaintenanceInput {
  if (!input || typeof input !== 'object') throw new Error('知识维护输入无效')
  const runId = (input as Record<string, unknown>).preprocessingRunId
  if (typeof runId !== 'string' || !runId.trim() || runId.length > 200) {
    throw new Error('预处理 Run ID 无效')
  }
  normalizeAttention((input as Record<string, unknown>).attention)
}

function executionSummary(
  connection: AiConnection,
  modelId: string,
  runtime: ProcessingExecutionSummary['runtime'],
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
    runtime,
    modelCallCount,
    toolCalls,
    ...(reasoningEffort ? { reasoningEffort } : {})
  }
}

function segmentPrompt(
  segment: ObservationSegment,
  sourceRef: string,
  attention?: string
): string {
  const context = segment.contextLines.length && segment.contextStartLine
    ? `\nBEGIN_ADJACENT_CONTEXT\n${numberedObservation(segment.contextLines, segment.contextStartLine)}\nEND_ADJACENT_CONTEXT\n`
    : ''
  return `Create the Evidence Map material for the primary Observation range ${observationSelector(segment.startLine, segment.endLine)}. This may be one part of a longer Session. Follow the System Prompt's language policy and preserve global line references exactly.

Adjacent context, when present, is provided only to resolve continuity at the boundary. Do not treat it as new coverage or repeat its candidates unless it is necessary to explain a correction or dependency in the primary range.${context}
Operator attention:
${attention ?? 'No additional focus.'}

Source reference: ${sourceRef}
BEGIN_AUTHORIZED_OBSERVATION
${numberedObservation(segment.lines, segment.startLine)}
END_AUTHORIZED_OBSERVATION`
}

function mergePrompt(nodes: EvidenceMapNode[], attention?: string): string {
  return `Assemble the Evidence Map materials below into one concise navigation map for a downstream Knowledge Maintenance Agent. Follow the System Prompt's language policy.

Preserve the original global line references and expandable map section IDs. Surface cross-range corrections, rejections, dependencies, conflicts, uncertainty, and areas that require consulting the original evidence. Do not turn candidates into facts, invent missing evidence, or replace the source citations with references to this generated map.

Operator attention:
${attention ?? 'No additional focus.'}

BEGIN_EVIDENCE_MAP_MATERIALS
${nodes.map((node) => evidenceMapNodeText(node)).join('\n\n---\n\n')}
END_EVIDENCE_MAP_MATERIALS

Output only the assembled navigation map as Markdown.`
}

function completedEvidenceMap(
  navigation: string,
  sourceRef: string,
  sections: EvidenceMapSection[],
  lineCount: number
): string {
  const manifest = sections.map((section) => `- ${section.id}: ${section.selector}`).join('\n')
  return [
    '# Evidence Map',
    '',
    '## Coverage',
    `- Source: ${sourceRef}`,
    `- Processed range: ${observationSelector(1, lineCount)}`,
    `- Local map sections: ${sections.length}`,
    '',
    '## Expandable map sections',
    manifest,
    '',
    '## Navigation',
    navigation
  ].join('\n')
}

function workspaceCharacters(workspace: PreprocessingWorkspace): number {
  return workspace.observationLines.reduce(
    (total, line) => total + line.length + 1 + ESTIMATED_OBSERVATION_LINE_OVERHEAD,
    0
  )
    + workspace.evidenceMap.length
    + workspace.evidenceMapSections.reduce((total, section) => total + section.content.length, 0)
}

export class KnowledgeProcessingService {
  private state: KnowledgeProcessingStateData = { stages: [] }
  private configurationError?: string
  private mutationQueue: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<ProcessingSnapshotListener>()
  private readonly workspaces = new Map<string, PreprocessingWorkspace>()
  private readonly activeRuns = new Map<ProcessingStageId, AbortController>()
  private readonly debugTraces = new Map<ProcessingDebugTraceOrigin, KnowledgeProcessingDebugTrace>()
  private readonly maintenanceToolTraceIds = new Map<ProcessingDebugTraceOrigin, {
    traceId: string
    eventIds: Map<string, string>
  }>()
  private preprocessingProgress?: ObservationPreprocessingProgress
  private exclusiveLease?: ProcessingRunLease
  private readonly unsubscribeAiBackend: () => void
  private readonly evidenceMapPlanner: ResolvedEvidenceMapPlannerOptions

  constructor(
    private readonly repository: KnowledgeProcessingRepository,
    private readonly aiBackend: AiBackendPort,
    private readonly knowledgeAgent: KnowledgeAgentRuntime,
    options: KnowledgeProcessingServiceOptions = {}
  ) {
    this.evidenceMapPlanner = resolveEvidenceMapPlannerOptions(options.evidenceMapPlanner)
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
    const connections = processingConnections(this.aiBackend)
    return structuredClone({
      stages: PROCESSING_STAGE_DEFINITIONS.map((definition) => {
        const stored = this.state.stages.find((candidate) => candidate.stageId === definition.id)
        const connectionId = connections.some((connection) => connection.id === stored?.connectionId)
          ? stored?.connectionId
          : undefined
        const connection = connections.find((candidate) => candidate.id === connectionId)
        const modelId = selectedModel(connection, stored?.modelId)?.id
          ?? selectedModel(connection, connection?.defaultModelId)?.id
        const reasoningEffort = stored?.reasoningEffort
          && selectedModel(connection, modelId)?.reasoningEfforts.includes(stored.reasoningEffort)
          ? stored.reasoningEffort
          : undefined
        return {
          id: definition.id,
          displayName: definition.displayName,
          description: definition.description,
          inputDescription: definition.inputDescription,
          outputDescription: definition.outputDescription,
          runtime: definition.runtime,
          capabilities: [...definition.capabilities],
          connectionId,
          modelId,
          reasoningEffort,
          defaultInstructions: definition.defaultInstructions,
          effectiveInstructions: stored?.instructionsOverride ?? definition.defaultInstructions,
          isCustomized: stored?.instructionsOverride !== undefined
        }
      }),
      connections,
      runningStageIds: [...this.activeRuns.keys()],
      debugTraces: [...this.debugTraces.values()],
      ...(this.preprocessingProgress
        ? { preprocessingProgress: { ...this.preprocessingProgress } }
        : {}),
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
      if (input.connectionId !== null && typeof input.connectionId !== 'string') {
        throw new Error('Model Connection 配置无效')
      }
      const connection = processingConnections(this.aiBackend).find((item) => item.id === input.connectionId)
      if (input.connectionId && !connection) {
        throw new Error('未找到可用于知识加工的 Connection')
      }
      if (input.modelId !== null && typeof input.modelId !== 'string') {
        throw new Error('Model 配置无效')
      }
      if (input.connectionId && !selectedModel(connection, input.modelId ?? undefined)) {
        throw new Error('所选 Model 不属于该 Connection')
      }
      if (!input.connectionId && input.modelId) {
        throw new Error('选择 Model 前必须先选择 Connection')
      }
      if (input.instructionsOverride !== null && typeof input.instructionsOverride !== 'string') {
        throw new Error('System Prompt 配置无效')
      }
      if (
        input.reasoningEffort !== undefined
        && input.reasoningEffort !== null
        && (
          typeof input.reasoningEffort !== 'string'
          || !REASONING_EFFORTS.includes(input.reasoningEffort)
        )
      ) {
        throw new Error('思考强度配置无效')
      }

      let instructionsOverride: string | undefined
      if (typeof input.instructionsOverride === 'string') {
        instructionsOverride = input.instructionsOverride.trim()
        if (!instructionsOverride) throw new Error('System Prompt 不能为空')
        if (instructionsOverride.length > MAX_INSTRUCTIONS_CHARACTERS) throw new Error('System Prompt 内容过长')
        if (instructionsOverride === stageDefinition(input.stageId).defaultInstructions) {
          instructionsOverride = undefined
        }
      }

      const currentStage = this.state.stages.find((candidate) => candidate.stageId === input.stageId)
      const reasoningEffort = input.reasoningEffort === undefined
        ? currentStage?.reasoningEffort
        : input.reasoningEffort ?? undefined
      if (reasoningEffort) {
        const model = selectedModel(connection, input.modelId ?? undefined)
        if (!model?.reasoningEfforts.includes(reasoningEffort)) {
          throw new Error('所选模型不支持该思考强度')
        }
      }

      const nextStage: StoredProcessingStage = {
        stageId: input.stageId,
        ...(input.connectionId ? { connectionId: input.connectionId } : {}),
        ...(input.modelId ? { modelId: input.modelId } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(instructionsOverride ? { instructionsOverride } : {})
      }
      const nextState: KnowledgeProcessingStateData = {
        stages: [
          ...this.state.stages.filter((candidate) => candidate.stageId !== input.stageId),
          nextStage
        ]
      }
      await this.repository.save(nextState)
      this.state = nextState
      this.emit()
      return this.snapshot()
    })
  }

  private configuredStage(
    stageId: ProcessingStageId,
    expectedConnectionId?: string
  ): ProcessingStageRunBinding {
    const stored = this.state.stages.find((candidate) => candidate.stageId === stageId)
    if (!stored?.connectionId) throw new Error('请先为该阶段选择并保存 Model Connection')
    if (expectedConnectionId && stored.connectionId !== expectedConnectionId) {
      throw new Error('确认后 Model Connection 已发生变化，请重新运行并确认数据目的地')
    }
    const connection = processingConnections(this.aiBackend).find((candidate) => candidate.id === stored.connectionId)
    const modelId = selectedModel(connection, stored.modelId)?.id
      ?? selectedModel(connection, connection?.defaultModelId)?.id
    if (!connection || !modelId) throw new Error('已配置的 Connection 或 Model 不再可用')
    const reasoningEffort = stored.reasoningEffort
      && selectedModel(connection, modelId)?.reasoningEfforts.includes(stored.reasoningEffort)
      ? stored.reasoningEffort
      : undefined
    return {
      connectionId: stored.connectionId,
      modelId,
      instructions: stored.instructionsOverride ?? stageDefinition(stageId).defaultInstructions,
      ...(reasoningEffort ? { reasoningEffort } : {})
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

  private updatePreprocessingProgress(progress?: ObservationPreprocessingProgress): void {
    this.preprocessingProgress = progress
    this.emit()
  }

  private beginPreprocessingDebugTrace(context: ProcessingDebugTraceContext): void {
    const current = this.debugTraces.get(context.origin)
    const trace: KnowledgeProcessingDebugTrace = context.origin === 'full_chain'
      && current?.id === context.id
      ? current
      : {
          id: context.id,
          origin: context.origin,
          status: 'running',
          currentStageId: 'observation_preprocessor',
          startedAt: new Date().toISOString()
        }
    trace.status = 'running'
    trace.currentStageId = 'observation_preprocessor'
    delete trace.completedAt
    delete trace.error
    delete trace.maintenance
    trace.preprocessing = {
      phase: 'preparing',
      completedSegments: 0,
      calls: []
    }
    this.debugTraces.set(context.origin, trace)
    this.emit()
  }

  beginFullChainDebugTrace(context: ProcessingDebugTraceContext): void {
    if (context.origin !== 'full_chain') throw new Error('完整链路调试轨迹来源无效')
    this.beginPreprocessingDebugTrace(context)
  }

  private beginMaintenanceDebugTrace(context: ProcessingDebugTraceContext): void {
    const current = this.debugTraces.get(context.origin)
    const trace: KnowledgeProcessingDebugTrace = current?.id === context.id
      ? current
      : {
          id: context.id,
          origin: context.origin,
          status: 'running',
          currentStageId: 'knowledge_maintenance_agent',
          startedAt: new Date().toISOString()
        }
    trace.status = 'running'
    trace.currentStageId = 'knowledge_maintenance_agent'
    delete trace.completedAt
    delete trace.error
    trace.maintenance = {
      modelCallCount: 0,
      toolCallCount: 0,
      events: []
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

  private completeDebugTrace(
    context: ProcessingDebugTraceContext,
    stageId: ProcessingStageId
  ): KnowledgeProcessingDebugTrace {
    this.updateDebugTrace(context, (trace) => {
      trace.status = 'completed'
      trace.currentStageId = stageId
      trace.completedAt = new Date().toISOString()
      delete trace.error
      if (stageId === 'observation_preprocessor' && trace.preprocessing) {
        trace.preprocessing.phase = 'completed'
      }
    })
    return this.debugTraceSnapshot(context)
  }

  private completeProcessingStageDebugTrace(
    context: ProcessingDebugTraceContext,
    stageId: ProcessingStageId
  ): KnowledgeProcessingDebugTrace {
    if (stageId === 'knowledge_maintenance_agent') {
      const toolTraceIds = this.maintenanceToolTraceIds.get(context.origin)
      if (toolTraceIds?.traceId === context.id) this.maintenanceToolTraceIds.delete(context.origin)
    }
    if (context.origin !== 'full_chain') return this.completeDebugTrace(context, stageId)
    this.updateDebugTrace(context, (trace) => {
      trace.status = 'running'
      trace.currentStageId = stageId
      delete trace.completedAt
      delete trace.error
      if (stageId === 'observation_preprocessor' && trace.preprocessing) {
        trace.preprocessing.phase = 'completed'
      }
    })
    return this.debugTraceSnapshot(context)
  }

  completeFullChainDebugTrace(
    context: ProcessingDebugTraceContext
  ): KnowledgeProcessingDebugTrace {
    if (context.origin !== 'full_chain') throw new Error('完整链路调试轨迹来源无效')
    const trace = this.debugTraces.get(context.origin)
    if (!trace || trace.id !== context.id) throw new Error('知识加工调试轨迹已失效')
    return this.completeDebugTrace(context, trace.currentStageId)
  }

  failFullChainDebugTrace(
    context: ProcessingDebugTraceContext,
    status: 'failed' | 'cancelled',
    error: unknown
  ): void {
    if (context.origin !== 'full_chain') return
    const trace = this.debugTraces.get(context.origin)
    if (!trace || trace.id !== context.id) return
    this.failDebugTrace(context, trace.currentStageId, status, error)
  }

  private failDebugTrace(
    context: ProcessingDebugTraceContext,
    stageId: ProcessingStageId,
    status: 'failed' | 'cancelled',
    error: unknown
  ): void {
    const completedAt = new Date().toISOString()
    this.updateDebugTrace(context, (trace) => {
      const hasFailedPreprocessingCall = trace.preprocessing?.calls.some(
        (call) => call.status === 'failed' || call.status === 'cancelled'
      )
      const hasFailedMaintenanceEvent = trace.maintenance?.events.some(
        (event) => event.status === 'failed' || event.status === 'cancelled'
      )
      const message = status === 'cancelled'
        ? '知识加工运行已取消'
        : stageId === 'observation_preprocessor' && hasFailedPreprocessingCall
          ? '观察预处理模型调用失败'
          : stageId === 'knowledge_maintenance_agent' && hasFailedMaintenanceEvent
            ? '知识维护 Agent 运行失败'
            : debugError(error)
      trace.status = status
      trace.currentStageId = stageId
      trace.completedAt = completedAt
      trace.error = message
      for (const call of trace.preprocessing?.calls ?? []) {
        if (call.status !== 'running') continue
        call.status = status
        call.completedAt = completedAt
        call.durationMs = Date.now() - new Date(call.startedAt).getTime()
        call.error = message
      }
      for (const event of trace.maintenance?.events ?? []) {
        if (event.status !== 'running') continue
        event.status = status
        event.completedAt = completedAt
        event.durationMs = Date.now() - new Date(event.startedAt).getTime()
        event.detail ??= message
      }
    })
    if (stageId === 'knowledge_maintenance_agent') {
      const toolTraceIds = this.maintenanceToolTraceIds.get(context.origin)
      if (toolTraceIds?.traceId === context.id) this.maintenanceToolTraceIds.delete(context.origin)
    }
  }

  private debugTraceSnapshot(context: ProcessingDebugTraceContext): KnowledgeProcessingDebugTrace {
    const trace = this.debugTraces.get(context.origin)
    if (!trace || trace.id !== context.id) throw new Error('知识加工调试轨迹已失效')
    return structuredClone(trace)
  }

  private updatePreprocessingDebug(
    context: ProcessingDebugTraceContext,
    update: (trace: NonNullable<KnowledgeProcessingDebugTrace['preprocessing']>) => void
  ): void {
    this.updateDebugTrace(context, (trace) => {
      if (trace.preprocessing) update(trace.preprocessing)
    })
  }

  private beginPreprocessingCall(
    context: ProcessingDebugTraceContext,
    kind: 'segment_map' | 'navigation_merge',
    selector: string,
    sectionIds: string[]
  ): string {
    let callId = ''
    this.updatePreprocessingDebug(context, (trace) => {
      const sequence = trace.calls.length + 1
      callId = `preprocessing-call-${sequence}`
      trace.calls.push({
        id: callId,
        sequence,
        kind,
        status: 'running',
        selector,
        sectionIds: [...sectionIds],
        startedAt: new Date().toISOString()
      })
    })
    return callId
  }

  private finishPreprocessingCall(
    context: ProcessingDebugTraceContext,
    callId: string,
    status: ProcessingDebugStatus,
    output?: string
  ): void {
    this.updatePreprocessingDebug(context, (trace) => {
      const call = trace.calls.find((candidate) => candidate.id === callId)
      if (!call || call.status !== 'running') return
      call.status = status
      call.completedAt = new Date().toISOString()
      call.durationMs = Date.now() - new Date(call.startedAt).getTime()
      if (output !== undefined) {
        call.output = boundedDebugText(output, MAX_DEBUG_TRACE_PREPROCESSOR_OUTPUT_CHARACTERS)
        if (output.length > MAX_DEBUG_TRACE_PREPROCESSOR_OUTPUT_CHARACTERS) {
          call.outputTruncated = true
        }
      }
      if (status === 'failed') call.error = '观察预处理模型调用失败'
      if (status === 'cancelled') call.error = '观察预处理模型调用已取消'
    })
  }

  private recordKnowledgeAgentTrace(
    context: ProcessingDebugTraceContext,
    event: KnowledgeAgentTraceEvent
  ): void {
    this.updateDebugTrace(context, (trace) => {
      const maintenance = trace.maintenance
      if (!maintenance) return
      if (event.type === 'model_started') {
        maintenance.modelCallCount = Math.max(maintenance.modelCallCount, event.callNumber)
        maintenance.events.push({
          id: `model-call-${event.callNumber}`,
          sequence: maintenance.events.length + 1,
          kind: 'model_call',
          label: `模型轮次 ${event.callNumber}`,
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
        if (event.detail) {
          modelEvent.detail = boundedDebugText(event.detail, MAX_DEBUG_TRACE_DETAIL_CHARACTERS)
        }
        return
      }

      const toolName = safeKnowledgeToolName(event.toolName)
      const traceToolName = toolName ?? 'unknown_tool'
      const toolLabel = knowledgeToolLabel(event.toolName)
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
          label: toolLabel,
          status: 'running',
          startedAt: new Date().toISOString(),
          detail: traceToolName
        })
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
      if (event.detail) {
        toolEvent.detail = boundedDebugText(event.detail, MAX_DEBUG_TRACE_DETAIL_CHARACTERS)
      }
    })
  }

  private rememberWorkspace(workspace: PreprocessingWorkspace): void {
    const newWeight = workspaceCharacters(workspace)
    if (newWeight > MAX_WORKSPACE_CHARACTERS) {
      throw new Error('预处理工作区超过内存上限；请缩小所选 Session 范围')
    }
    this.workspaces.set(workspace.runId, workspace)
    let totalWeight = [...this.workspaces.values()].reduce(
      (total, candidate) => total + workspaceCharacters(candidate),
      0
    )
    while (this.workspaces.size > MAX_WORKSPACES || totalWeight > MAX_WORKSPACE_CHARACTERS) {
      const oldest = this.workspaces.keys().next().value as string | undefined
      if (!oldest) break
      const removed = this.workspaces.get(oldest)
      this.workspaces.delete(oldest)
      if (removed) totalWeight -= workspaceCharacters(removed)
    }
  }

  private async generateEvidenceMapMaterial(
    stage: ProcessingStageRunBinding,
    prompt: string,
    signal: AbortSignal,
    modelCallCount: { value: number },
    traceContext: ProcessingDebugTraceContext,
    call: {
      kind: 'segment_map' | 'navigation_merge'
      selector: string
      sectionIds: string[]
    }
  ): Promise<string> {
    const traceCallId = this.beginPreprocessingCall(
      traceContext,
      call.kind,
      call.selector,
      call.sectionIds
    )
    try {
      if (!stage.instructions.trim()) throw new Error('Observation Preprocessor System Prompt 不能为空')
      if (stage.instructions.length > MAX_INSTRUCTIONS_CHARACTERS) {
        throw new Error('Observation Preprocessor System Prompt 内容过长')
      }
      if (stage.instructions.length + prompt.length > MAX_PREPROCESSOR_MODEL_INPUT_CHARACTERS) {
        throw new Error('观察预处理模型输入超过单次有界调用上限')
      }
      if (modelCallCount.value >= MAX_PREPROCESSOR_MODEL_CALLS) {
        throw new Error(`观察预处理超过 ${MAX_PREPROCESSOR_MODEL_CALLS} 次模型调用上限`)
      }
      const generated = await this.aiBackend.generateWithModel(stage.connectionId, stage.modelId, {
        systemPrompt: stage.instructions,
        prompt,
        maxOutputTokens: 4_096,
        timeoutMs: 5 * 60_000,
        maxResponseBytes: 8 * 1_024 * 1_024,
        reasoningEffort: stage.reasoningEffort,
        signal
      })
      signal.throwIfAborted()
      const content = generated.text.trim()
      if (!content) throw new Error('观察预处理器未返回 Evidence Map')
      if (content.length > MAX_EVIDENCE_MAP_SECTION_CHARACTERS) {
        throw new Error('局部 Evidence Map 内容过长')
      }
      modelCallCount.value++
      this.finishPreprocessingCall(traceContext, traceCallId, 'completed', content)
      return content
    } catch (error) {
      const terminalStatus = traceTerminalStatus(signal)
      this.finishPreprocessingCall(
        traceContext,
        traceCallId,
        terminalStatus
      )
      throw error
    }
  }

  private async assembleEvidenceMapNavigation(
    stage: ProcessingStageRunBinding,
    leafNodes: EvidenceMapNode[],
    attention: string | undefined,
    signal: AbortSignal,
    modelCallCount: { value: number },
    traceContext: ProcessingDebugTraceContext
  ): Promise<string> {
    let nodes = leafNodes
    while (nodes.length > 1) {
      const groups = groupEvidenceMapNodes(nodes, this.evidenceMapPlanner.mergeCharacters)
      const next: EvidenceMapNode[] = []
      let mergedAny = false
      for (const group of groups) {
        signal.throwIfAborted()
        if (group.length === 1) {
          next.push(group[0])
          continue
        }
        mergedAny = true
        const content = await this.generateEvidenceMapMaterial(
          stage,
          mergePrompt(group, attention),
          signal,
          modelCallCount,
          traceContext,
          {
            kind: 'navigation_merge',
            selector: observationSelector(group[0].startLine, group[group.length - 1].endLine),
            sectionIds: group.flatMap((node) => node.sectionIds)
          }
        )
        next.push({
          content,
          startLine: group[0].startLine,
          endLine: group[group.length - 1].endLine,
          sectionIds: group.flatMap((node) => node.sectionIds)
        })
      }
      if (!mergedAny) throw new Error('局部 Evidence Map 无法在当前输入预算内完成导航归并')
      nodes = next
    }
    return nodes[0].content
  }

  async runObservationPreprocessor(
    input: RunObservationPreprocessorInput,
    expectedConnectionId?: string,
    options: ObservationPreprocessorRunOptions = {}
  ): Promise<ObservationPreprocessingResult> {
    assertObservationInput(input, Boolean(options.allowSegmentedObservation))
    const stageId = 'observation_preprocessor' as const
    const stage = options.binding ?? this.configuredStage(stageId, expectedConnectionId)
    const connection = this.aiBackend.snapshot().connections.find((item) => item.id === stage.connectionId)
    if (!connection) throw new Error('已配置的 Connection 不再可用')

    const startedAt = Date.now()
    const runId = randomUUID()
    const debugTrace = options.debugTrace ?? {
      id: runId,
      origin: options.lease ? 'full_chain' : 'stage_debug'
    }
    const sourceRef = options.sourceRef ?? `workspace:${runId}:observation`
    if (!sourceRef.trim() || sourceRef.length > MAX_SOURCE_REF_CHARACTERS) {
      throw new Error('Observation sourceRef 无效')
    }
    const attention = normalizeAttention(input.attention)
    const observationLines = input.observation.split(/\r\n|\r|\n/)
    const controller = this.beginRun(stageId, options.lease)
    this.beginPreprocessingDebugTrace(debugTrace)
    const deadline = setTimeout(() => {
      controller.abort(new PreprocessingDeadlineExceededError('观察预处理运行超过 30 分钟上限'))
    }, MAX_PREPROCESSOR_RUN_MS)
    deadline.unref()

    try {
      this.updatePreprocessingProgress({
        phase: 'preparing',
        completedSegments: 0
      })
      const segments = planObservationSegments(observationLines, this.evidenceMapPlanner)
      this.updatePreprocessingDebug(debugTrace, (trace) => {
        trace.totalSegments = segments.length
      })
      if (segments.length > MAX_PREPROCESSOR_SEGMENTS) {
        throw new Error(
          `Observation 需要 ${segments.length} 个分段，超过单次运行 ${MAX_PREPROCESSOR_SEGMENTS} 个分段的上限`
        )
      }
      this.updatePreprocessingProgress({
        phase: 'mapping',
        completedSegments: 0,
        totalSegments: segments.length
      })
      this.updatePreprocessingDebug(debugTrace, (trace) => {
        trace.phase = 'mapping'
      })
      const modelCallCount = { value: 0 }
      const sections: EvidenceMapSection[] = []
      const leafNodes: EvidenceMapNode[] = []
      for (const segment of segments) {
        controller.signal.throwIfAborted()
        const content = await this.generateEvidenceMapMaterial(
          stage,
          segmentPrompt(segment, sourceRef, attention),
          controller.signal,
          modelCallCount,
          debugTrace,
          {
            kind: 'segment_map',
            selector: observationSelector(segment.startLine, segment.endLine),
            sectionIds: [segment.id]
          }
        )
        const selector = observationSelector(segment.startLine, segment.endLine)
        sections.push({ id: segment.id, selector, content })
        leafNodes.push({
          content,
          startLine: segment.startLine,
          endLine: segment.endLine,
          sectionIds: [segment.id]
        })
        this.updatePreprocessingProgress({
          phase: 'mapping',
          completedSegments: sections.length,
          totalSegments: segments.length
        })
        this.updatePreprocessingDebug(debugTrace, (trace) => {
          trace.completedSegments = sections.length
        })
      }

      let evidenceMap: string
      let workspaceSections: EvidenceMapSection[]
      if (segments.length === 1) {
        evidenceMap = sections[0].content
        workspaceSections = []
      } else {
        this.updatePreprocessingProgress({
          phase: 'assembling',
          completedSegments: segments.length,
          totalSegments: segments.length
        })
        this.updatePreprocessingDebug(debugTrace, (trace) => {
          trace.phase = 'assembling'
        })
        const navigation = await this.assembleEvidenceMapNavigation(
          stage,
          leafNodes,
          attention,
          controller.signal,
          modelCallCount,
          debugTrace
        )
        evidenceMap = completedEvidenceMap(
          navigation,
          sourceRef,
          sections,
          observationLines.length
        )
        workspaceSections = sections
      }
      if (evidenceMap.length > MAX_EVIDENCE_MAP_CHARACTERS) throw new Error('Evidence Map 内容过长')

      this.rememberWorkspace({
        runId,
        sourceRef,
        observationLines,
        evidenceMap,
        evidenceMapSections: workspaceSections,
        attention,
        createdAt: Date.now()
      })

      const completedDebugTrace = this.completeProcessingStageDebugTrace(debugTrace, stageId)
      return {
        stageId,
        runId,
        evidenceMap,
        sourceRef,
        segmentCount: segments.length,
        debugTrace: completedDebugTrace,
        durationMs: Date.now() - startedAt,
        completedAt: new Date().toISOString(),
        execution: executionSummary(
          connection,
          stage.modelId,
          'direct_model_call',
          modelCallCount.value,
          [],
          stage.reasoningEffort
        )
      }
    } catch (error) {
      this.failDebugTrace(
        debugTrace,
        stageId,
        traceTerminalStatus(controller.signal),
        error
      )
      throw error
    } finally {
      clearTimeout(deadline)
      this.updatePreprocessingProgress(undefined)
      this.finishRun(stageId, controller)
    }
  }

  async runKnowledgeMaintenance(
    input: RunKnowledgeMaintenanceInput,
    expectedConnectionId?: string,
    options: KnowledgeMaintenanceRunOptions = {}
  ): Promise<KnowledgeMaintenanceResult> {
    assertMaintenanceInput(input)
    const stageId = 'knowledge_maintenance_agent' as const
    const stage = options.binding ?? this.configuredStage(stageId, expectedConnectionId)
    const connectionView = this.aiBackend.snapshot().connections.find((item) => item.id === stage.connectionId)
    if (!connectionView) throw new Error('已配置的 Connection 不再可用')
    const workspace = this.workspaces.get(input.preprocessingRunId)
    if (!workspace) throw new Error('预处理工作区已不存在，请重新运行观察预处理')
    const attention = normalizeAttention(input.attention)
    const controller = this.beginRun(stageId, options.lease)
    const debugTrace = options.debugTrace ?? {
      id: input.preprocessingRunId,
      origin: options.lease ? 'full_chain' : 'stage_debug'
    }
    this.beginMaintenanceDebugTrace(debugTrace)
    const startedAt = Date.now()

    try {
      const result = await this.aiBackend.withModelRuntime(
        stage.connectionId,
        stage.modelId,
        (runtime) => (options.knowledgeAgent ?? this.knowledgeAgent).run({
          runtime,
          systemPrompt: stage.instructions,
          evidenceMap: workspace.evidenceMap,
          evidenceMapSections: workspace.evidenceMapSections.map((section) => ({ ...section })),
          observationLines: [...workspace.observationLines],
          sourceRef: workspace.sourceRef,
          contributionRunRef: options.contributionRunRef ?? `manual:${randomUUID()}`,
          attention,
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
        if (!trace.maintenance) return
        trace.maintenance.modelCallCount = result.modelCallCount
        trace.maintenance.toolCallCount = result.toolCalls.length
      })
      const completedDebugTrace = this.completeProcessingStageDebugTrace(debugTrace, stageId)
      return {
        stageId,
        preprocessingRunId: workspace.runId,
        contribution: result.contribution,
        debugTrace: completedDebugTrace,
        durationMs: Date.now() - startedAt,
        completedAt: new Date().toISOString(),
        execution: executionSummary(
          connectionView,
          stage.modelId,
          'pi_agent_core',
          result.modelCallCount,
          result.toolCalls,
          stage.reasoningEffort
        )
      }
    } catch (error) {
      this.failDebugTrace(
        debugTrace,
        stageId,
        traceTerminalStatus(controller.signal),
        error
      )
      throw error
    } finally {
      this.finishRun(stageId, controller)
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
    this.preprocessingProgress = undefined
    this.exclusiveLease = undefined
    this.workspaces.clear()
    this.debugTraces.clear()
    this.maintenanceToolTraceIds.clear()
    this.listeners.clear()
  }
}

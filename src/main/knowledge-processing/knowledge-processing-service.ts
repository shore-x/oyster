import { randomUUID } from 'node:crypto'
import {
  PROCESSING_STAGE_IDS,
  type KnowledgeMaintenanceResult,
  type KnowledgeProcessingSnapshot,
  type ObservationPreprocessingResult,
  type ProcessingConnectionView,
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
  KnowledgeAgentRuntime,
  KnowledgeProcessingRepository,
  KnowledgeProcessingStateData,
  PreprocessingWorkspace,
  ProcessingSnapshotListener,
  StoredProcessingStage
} from './model'
import { PROCESSING_STAGE_DEFINITIONS, stageDefinition } from './prompts'

const MAX_INSTRUCTIONS_CHARACTERS = 20_000
const MAX_OBSERVATION_CHARACTERS = 120_000
const MAX_ATTENTION_CHARACTERS = 10_000
const MAX_EVIDENCE_MAP_CHARACTERS = 128 * 1_024
const MAX_WORKSPACES = 20

export interface ProcessingStageRunBinding {
  connectionId: string
  modelId: string
  instructions: string
  reasoningEffort?: ReasoningEffort
}

export interface ProcessingRunLease {
  readonly id: string
}

export interface ObservationPreprocessorRunOptions {
  binding?: ProcessingStageRunBinding
  lease?: ProcessingRunLease
  sourceRef?: string
}

export interface KnowledgeMaintenanceRunOptions {
  binding?: ProcessingStageRunBinding
  lease?: ProcessingRunLease
  knowledgeAgent?: KnowledgeAgentRuntime
  contributionRunRef?: string
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

function lineNumber(index: number): string {
  return `L${String(index + 1).padStart(6, '0')}`
}

function numberedObservation(lines: string[]): string {
  return lines.map((line, index) => `${lineNumber(index)} | ${line}`).join('\n')
}

function normalizeAttention(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new Error('关注点格式无效')
  const normalized = value.trim()
  if (!normalized) return undefined
  if (normalized.length > MAX_ATTENTION_CHARACTERS) throw new Error('关注点内容过长')
  return normalized
}

function assertObservationInput(input: unknown): asserts input is RunObservationPreprocessorInput {
  if (!input || typeof input !== 'object') throw new Error('观察预处理输入无效')
  const observation = (input as Record<string, unknown>).observation
  if (typeof observation !== 'string' || !observation.trim()) throw new Error('请输入需要处理的 Observation')
  if (observation.length > MAX_OBSERVATION_CHARACTERS) {
    throw new Error(`Observation 不能超过 ${MAX_OBSERVATION_CHARACTERS} 个字符`)
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

export class KnowledgeProcessingService {
  private state: KnowledgeProcessingStateData = { stages: [] }
  private configurationError?: string
  private mutationQueue: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<ProcessingSnapshotListener>()
  private readonly workspaces = new Map<string, PreprocessingWorkspace>()
  private readonly activeRuns = new Map<ProcessingStageId, AbortController>()
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
    if (this.activeRuns.has(stageId)) throw new Error('该知识加工阶段正在运行')
    const controller = new AbortController()
    this.activeRuns.set(stageId, controller)
    this.emit()
    return controller
  }

  private finishRun(stageId: ProcessingStageId, controller: AbortController): void {
    if (this.activeRuns.get(stageId) === controller) this.activeRuns.delete(stageId)
    this.emit()
  }

  async runObservationPreprocessor(
    input: RunObservationPreprocessorInput,
    expectedConnectionId?: string,
    options: ObservationPreprocessorRunOptions = {}
  ): Promise<ObservationPreprocessingResult> {
    assertObservationInput(input)
    const stageId = 'observation_preprocessor' as const
    const stage = options.binding ?? this.configuredStage(stageId, expectedConnectionId)
    const connection = this.aiBackend.snapshot().connections.find((item) => item.id === stage.connectionId)
    if (!connection) throw new Error('已配置的 Connection 不再可用')

    const startedAt = Date.now()
    const runId = randomUUID()
    const sourceRef = options.sourceRef ?? `workspace:${runId}:observation`
    if (!sourceRef.trim() || sourceRef.length > 512) throw new Error('Observation sourceRef 无效')
    const attention = normalizeAttention(input.attention)
    const observationLines = input.observation.split(/\r\n|\r|\n/)
    const controller = this.beginRun(stageId, options.lease)
    const prompt = `Create an Evidence Map from the authorized observation material below. Follow the System Prompt's language policy and write in the primary language of the source material.\n\nOperator attention:\n${attention ?? 'No additional focus.'}\n\nSource reference: ${sourceRef}\nBEGIN_AUTHORIZED_OBSERVATION\n${numberedObservation(observationLines)}\nEND_AUTHORIZED_OBSERVATION`

    try {
      const generated = await this.aiBackend.generateWithModel(stage.connectionId, stage.modelId, {
        systemPrompt: stage.instructions,
        prompt,
        maxOutputTokens: 4_096,
        timeoutMs: 5 * 60_000,
        maxResponseBytes: 8 * 1_024 * 1_024,
        reasoningEffort: stage.reasoningEffort,
        signal: controller.signal
      })
      controller.signal.throwIfAborted()
      const evidenceMap = generated.text.trim()
      if (!evidenceMap) throw new Error('观察预处理器未返回 Evidence Map')
      if (evidenceMap.length > MAX_EVIDENCE_MAP_CHARACTERS) throw new Error('Evidence Map 内容过长')

      this.workspaces.set(runId, {
        runId,
        sourceRef,
        observationLines,
        evidenceMap,
        attention,
        createdAt: Date.now()
      })
      while (this.workspaces.size > MAX_WORKSPACES) {
        const oldest = this.workspaces.keys().next().value as string | undefined
        if (!oldest) break
        this.workspaces.delete(oldest)
      }

      return {
        stageId,
        runId,
        evidenceMap,
        sourceRef,
        durationMs: Date.now() - startedAt,
        completedAt: new Date().toISOString(),
        execution: executionSummary(connection, stage.modelId, 'direct_model_call', 1, [], stage.reasoningEffort)
      }
    } finally {
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
    const startedAt = Date.now()

    try {
      const result = await this.aiBackend.withModelRuntime(
        stage.connectionId,
        stage.modelId,
        (runtime) => (options.knowledgeAgent ?? this.knowledgeAgent).run({
          runtime,
          systemPrompt: stage.instructions,
          evidenceMap: workspace.evidenceMap,
          observationLines: [...workspace.observationLines],
          sourceRef: workspace.sourceRef,
          contributionRunRef: options.contributionRunRef ?? `manual:${randomUUID()}`,
          attention,
          reasoningEffort: stage.reasoningEffort,
          signal: controller.signal
        }),
        { trackHealth: true }
      )
      controller.signal.throwIfAborted()
      return {
        stageId,
        preprocessingRunId: workspace.runId,
        contribution: result.contribution,
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
    for (const listener of this.listeners) listener(snapshot)
  }

  dispose(): void {
    this.unsubscribeAiBackend()
    for (const controller of this.activeRuns.values()) controller.abort(new Error('Oyster 正在退出'))
    this.activeRuns.clear()
    this.exclusiveLease = undefined
    this.workspaces.clear()
    this.listeners.clear()
  }
}

import { For, Show, createEffect, createMemo, createSignal } from 'solid-js'
import type {
  KnowledgeFullChainResult,
  KnowledgeMaintenanceResult,
  ObservationPreprocessingResult,
  ProcessingConnectionView,
  ProcessingExecutionSummary,
  ProcessingStageView
} from '../../../shared/knowledge-processing'
import type { ReasoningEffort } from '../../../shared/ai-backends'
import type { KnowledgeContributionDraft } from '../../../shared/knowledge'
import { createKnowledgeProcessingController } from '../knowledge-processing-controller'
import {
  REASONING_LABELS,
  backendLabel,
  connectionCanAttemptRun,
  connectionStatusLabel,
  providerLabel,
  reasoningLabel,
  runtimeLabel,
  selectedStageModel
} from '../processing-configuration'
import { Button, Icon } from '../ui'
import { FullChainWorkspace, type FullChainResultView } from './FullChainWorkspace'
import { ProcessingDebugTracePanel } from './ProcessingDebugTracePanel'
import { SessionMetadata, sessionOptionLabel } from './SessionMetadata'

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs} ms`
  return `${(durationMs / 1_000).toFixed(1)} s`
}

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN')
}

function contributionText(contribution: KnowledgeContributionDraft): string {
  if (!contribution.statements.length) return '本次运行没有需要持久化的 Knowledge Statement。'
  return contribution.statements
    .map((statement) => `## ${statement.title}\n\n${statement.content}`)
    .join('\n\n---\n\n')
}

function fullChainResultView(result: KnowledgeFullChainResult): FullChainResultView {
  return {
    runId: result.runId,
    sandboxId: result.sandbox.id,
    session: result.session,
    baselineCreatedAt: result.sandbox.baselineCreatedAt,
    completedAt: result.completedAt,
    durationMs: result.durationMs,
    evidenceMap: result.preprocessing.evidenceMap,
    debugTrace: result.maintenance.debugTrace,
    steps: [
      {
        id: 'session',
        label: '读取 Session',
        detail: `${result.session.sourceDisplayName} · ${result.session.revision.slice(0, 12)}`,
        state: 'completed'
      },
      {
        id: 'preprocessing',
        label: '观察预处理',
        detail: `${result.preprocessing.segmentCount} 个分段 · ${result.preprocessing.execution.modelCallCount} 次模型调用 · ${formatDuration(result.preprocessing.durationMs)}`,
        state: 'completed'
      },
      {
        id: 'maintenance',
        label: '知识维护与写入',
        detail: `${result.maintenance.execution.modelCallCount} 次模型调用 · ${result.commit.statements.length} 条 Statement`,
        state: 'completed'
      }
    ],
    contributions: [{
      id: result.commit.contribution.id,
      content: contributionText(result.maintenance.contribution),
      createdAt: result.commit.contribution.createdAt
    }],
    statements: result.knowledge.statements.map((statement) => ({
      title: statement.title,
      content: statement.content
    }))
  }
}

function ExecutionDetails(props: {
  execution: ProcessingExecutionSummary
  segmentCount?: number
  durationMs: number
  completedAt: string
}) {
  return (
    <dl class="processing-run-details">
      <div><dt>Connection</dt><dd>{props.execution.connectionName}</dd></div>
      <div><dt>Backend</dt><dd>{backendLabel(props.execution.backendKind)}</dd></div>
      <div><dt>Provider</dt><dd>{providerLabel(props.execution.providerId)}</dd></div>
      <div><dt>Model</dt><dd>{props.execution.model}</dd></div>
      <div><dt>思考强度</dt><dd>{props.execution.reasoningEffort ? REASONING_LABELS[props.execution.reasoningEffort] : '模型默认'}</dd></div>
      <div><dt>Runtime</dt><dd>{runtimeLabel(props.execution.runtime)}</dd></div>
      <div><dt>模型调用</dt><dd>{props.execution.modelCallCount} 次</dd></div>
      <Show when={props.segmentCount !== undefined}>
        <div><dt>Observation 分段</dt><dd>{props.segmentCount} 个</dd></div>
      </Show>
      <div><dt>工具调用</dt><dd>{props.execution.toolCalls.length ? props.execution.toolCalls.join('、') : '无'}</dd></div>
      <div><dt>耗时</dt><dd>{formatDuration(props.durationMs)}</dd></div>
      <div><dt>完成时间</dt><dd>{formatTime(props.completedAt)}</dd></div>
    </dl>
  )
}

function ConnectionConfiguration(props: {
  stage: ProcessingStageView
  connections: ProcessingConnectionView[]
  selected?: ProcessingConnectionView
  saving: boolean
  locked: boolean
  onChange(connectionId: string | null): void
  onModelChange(modelId: string): void
  onReasoningEffortChange(reasoningEffort: ReasoningEffort | null): void
}) {
  const selectedModel = () => selectedStageModel(props.stage, props.selected)
  const unavailableConnectionId = () => (
    props.stage.connectionId && !props.selected ? props.stage.connectionId : undefined
  )
  const unavailableModelId = () => (
    props.stage.modelId && props.selected && !selectedModel() ? props.stage.modelId : undefined
  )
  const unsupportedReasoningEffort = () => {
    const effort = props.stage.reasoningEffort
    const model = selectedModel()
    return effort && model && !model.reasoningEfforts.includes(effort) ? effort : undefined
  }
  return (
    <div class="processing-connection">
      <div class="processing-connection__selectors">
        <label class="ai-field">
          <span>Connection</span>
          <select
            data-testid={`processing-connection-${props.stage.id}`}
            value={props.stage.connectionId || ''}
            disabled={props.saving || props.locked}
            onChange={(event) => props.onChange(event.currentTarget.value || null)}
          >
            <option value="">选择已配置的 Connection</option>
            <Show when={unavailableConnectionId()}>{(connectionId) => (
              <option value={connectionId()} disabled>
                已保存但当前不可用 · {connectionId()}
              </option>
            )}</Show>
            <For each={props.connections}>{(connection) => (
              <option value={connection.id}>
                {connection.displayName} · {backendLabel(connection.backendKind)} · {connectionStatusLabel(connection.status)}
              </option>
            )}</For>
          </select>
        </label>
        <label class="ai-field">
          <span>Model</span>
          <select
            data-testid={`processing-model-${props.stage.id}`}
            value={props.stage.modelId || ''}
            disabled={!props.selected || props.saving || props.locked}
            onChange={(event) => props.onModelChange(event.currentTarget.value)}
          >
            <option value="">选择 Model</option>
            <Show when={unavailableModelId()}>{(modelId) => (
              <option value={modelId()} disabled>
                已保存但当前不可用 · {modelId()}
              </option>
            )}</Show>
            <For each={props.selected?.models ?? []}>{(model) => (
              <option value={model.id}>
                {model.displayName === model.id ? model.id : `${model.displayName} · ${model.id}`}
              </option>
            )}</For>
          </select>
        </label>
        <label class="ai-field">
          <span>思考强度</span>
          <select
            data-testid={`processing-reasoning-${props.stage.id}`}
            value={props.stage.reasoningEffort || ''}
            disabled={!selectedModel()?.reasoningEfforts.length || props.saving || props.locked}
            onChange={(event) => props.onReasoningEffortChange(
              (event.currentTarget.value || null) as ReasoningEffort | null
            )}
          >
            <option value="">模型默认</option>
            <Show when={unsupportedReasoningEffort()}>{(effort) => (
              <option value={effort()} disabled>
                已保存但当前不受支持 · {REASONING_LABELS[effort()]}
              </option>
            )}</Show>
            <For each={selectedModel()?.reasoningEfforts ?? []}>{(effort) => (
              <option value={effort}>{REASONING_LABELS[effort]}</option>
            )}</For>
          </select>
        </label>
      </div>
      <Show
        when={props.selected}
        fallback={(
          <p class="processing-connection__empty">
            {props.stage.connectionId
              ? `已保存的 Connection 当前不可用：${props.stage.connectionId}；Model：${props.stage.modelId || '未选择'}。系统不会自动切换或回退。`
              : '请先选择执行此阶段的 Connection；系统不会自动切换或回退。'}
          </p>
        )}
      >
        {(connection) => (
          <dl
            class="processing-connection__details"
            data-testid={`processing-config-${props.stage.id}`}
          >
            <div><dt>Connection</dt><dd>{connection().displayName}</dd></div>
            <div><dt>Backend</dt><dd data-testid={`processing-config-backend-${props.stage.id}`}>{backendLabel(connection().backendKind)}</dd></div>
            <div><dt>Provider</dt><dd data-testid={`processing-config-provider-${props.stage.id}`}>{providerLabel(connection().providerId)}</dd></div>
            <Show when={connection().backendKind === 'api'}>
              <div><dt>Endpoint</dt><dd title={connection().destination}>{connection().destination}</dd></div>
            </Show>
            <Show when={connection().backendKind === 'coding_plan'}>
              <div><dt>Account</dt><dd>{connection().accountLabel || '—'}</dd></div>
              <div><dt>Plan</dt><dd>{connection().planType || '—'}</dd></div>
            </Show>
            <div><dt>Model</dt><dd data-testid={`processing-config-model-${props.stage.id}`}>
              {selectedModel()?.id || (props.stage.modelId ? `当前不可用 · ${props.stage.modelId}` : '未选择')}
            </dd></div>
            <div><dt>Reasoning</dt><dd data-testid={`processing-config-reasoning-${props.stage.id}`}>{reasoningLabel(props.stage.reasoningEffort)}</dd></div>
            <div><dt>Runtime</dt><dd data-testid={`processing-config-runtime-${props.stage.id}`}>{runtimeLabel(props.stage.runtime)}</dd></div>
            <div><dt>状态</dt><dd>{connectionStatusLabel(connection().status)}</dd></div>
          </dl>
        )}
      </Show>
    </div>
  )
}

function PromptConfiguration(props: {
  stage: ProcessingStageView
  draft: string
  saving: boolean
  locked: boolean
  onInput(value: string): void
  onSave(): void
  onRestore(): void
}) {
  const dirty = () => props.draft !== props.stage.effectiveInstructions
  const customized = () => props.draft !== props.stage.defaultInstructions
  return (
    <section class="processing-prompt" aria-label={`${props.stage.displayName}提示词`}>
      <div class="processing-prompt__heading">
        <div>
          <h3>处理指令</h3>
          <p>作为此阶段的 System Prompt 使用。</p>
        </div>
        <span
          class={`processing-mode-badge${customized() ? ' processing-mode-badge--custom' : ''}`}
          data-testid={`processing-prompt-badge-${props.stage.id}`}
        >{customized() ? 'Customized' : 'Default'}</span>
      </div>
      <textarea
        class="processing-prompt__editor"
        data-testid={`processing-instructions-${props.stage.id}`}
        value={props.draft}
        rows={10}
        spellcheck={false}
        disabled={props.locked || props.saving}
        onInput={(event) => props.onInput(event.currentTarget.value)}
      />
      <div class="processing-prompt__actions">
        <Button
          variant="ghost"
          icon="refresh"
          data-testid={`restore-processing-instructions-${props.stage.id}`}
          disabled={props.saving || props.locked || (!props.stage.isCustomized && props.draft === props.stage.defaultInstructions)}
          onClick={props.onRestore}
        >恢复默认</Button>
        <Button
          variant="secondary"
          icon="check"
          data-testid={`save-processing-instructions-${props.stage.id}`}
          disabled={props.saving || props.locked || !dirty() || !props.draft.trim()}
          onClick={props.onSave}
        >{props.saving ? '保存中…' : '保存提示词'}</Button>
      </div>
    </section>
  )
}

function PreprocessingResult(props: { result: ObservationPreprocessingResult }) {
  return (
    <section class="processing-result" data-testid="processing-result-observation_preprocessor">
      <div class="processing-result__heading">
        <div><Icon name="check" /><h3>Evidence Map</h3></div>
        <span>{props.result.segmentCount} 个分段 · 可丢弃工作材料</span>
      </div>
      <pre>{props.result.evidenceMap}</pre>
      <div class="processing-result__reference">
        <span>Run ID</span><code>{props.result.runId}</code>
        <span>来源</span><code>{props.result.sourceRef}</code>
      </div>
      <ExecutionDetails
        execution={props.result.execution}
        segmentCount={props.result.segmentCount}
        durationMs={props.result.durationMs}
        completedAt={props.result.completedAt}
      />
    </section>
  )
}

function MaintenanceResult(props: { result: KnowledgeMaintenanceResult }) {
  const [selectedTitle, setSelectedTitle] = createSignal<string>()
  const selectedStatement = createMemo(() => props.result.contribution.statements.find(
    (statement) => statement.title === selectedTitle()
  ) ?? props.result.contribution.statements[0])

  createEffect(() => {
    const contribution = props.result.contribution
    setSelectedTitle(contribution.statements[0]?.title)
  })

  return (
    <section class="processing-result" data-testid="processing-result-knowledge_maintenance_agent">
      <div class="processing-result__heading">
        <div><Icon name="check" /><h3>Knowledge Contribution</h3></div>
        <span>候选，尚未写入知识层</span>
      </div>
      <Show
        when={props.result.contribution.statements.length}
        fallback={<div class="sandbox-knowledge__empty processing-contribution__empty">Agent 判断本次没有需要写入的 Knowledge Statement。</div>}
      >
        <div class="sandbox-knowledge processing-contribution-knowledge">
          <aside class="sandbox-knowledge__list" aria-label="候选 Knowledge Statements">
            <div class="sandbox-knowledge__list-header">
              <span>候选 Statements</span>
              <strong>{props.result.contribution.statements.length}</strong>
            </div>
            <For each={props.result.contribution.statements}>{(statement) => (
              <button
                type="button"
                class="sandbox-statement"
                aria-selected={selectedStatement()?.title === statement.title}
                onClick={() => setSelectedTitle(statement.title)}
              >
                <strong>{statement.title}</strong>
                <span>canonical title</span>
              </button>
            )}</For>
          </aside>
          <Show when={selectedStatement()}>
            {(statement) => (
              <article class="sandbox-knowledge__detail">
                <h3>{statement().title}</h3>
                <div class="sandbox-knowledge__detail-meta">
                  <span>按 canonical title 创建或覆盖</span>
                </div>
                <div class="sandbox-knowledge__content">{statement().content}</div>
              </article>
            )}
          </Show>
        </div>
      </Show>
      <div class="processing-result__reference">
        <span>Evidence Map Run</span><code>{props.result.preprocessingRunId}</code>
      </div>
      <ExecutionDetails
        execution={props.result.execution}
        durationMs={props.result.durationMs}
        completedAt={props.result.completedAt}
      />
    </section>
  )
}

type DebugWorkspace = 'input' | 'configuration' | 'process' | 'output'

function DebugWorkspaceTabs(props: {
  stageId: string
  selected: DebugWorkspace
  onSelect(tab: DebugWorkspace): void
}) {
  const tabs: Array<{ id: DebugWorkspace; label: string }> = [
    { id: 'input', label: '运行输入' },
    { id: 'configuration', label: '模型与提示词' },
    { id: 'process', label: '调用过程' },
    { id: 'output', label: '输出结果' }
  ]
  return (
    <div class="processing-workspace-tabs" role="tablist" aria-label="阶段调试工作区">
      <For each={tabs}>{(tab) => (
        <button
          type="button"
          role="tab"
          aria-selected={props.selected === tab.id}
          aria-controls={`${props.stageId}-panel-${tab.id}`}
          data-testid={`${props.stageId}-tab-${tab.id}`}
          onClick={() => props.onSelect(tab.id)}
        >{tab.label}</button>
      )}</For>
    </div>
  )
}

export function KnowledgeProcessingPage() {
  const controller = createKnowledgeProcessingController()
  const [view, setView] = createSignal<'full_chain' | 'stage_debug'>('full_chain')
  const [debugStage, setDebugStage] = createSignal<'preprocessor' | 'maintainer'>('preprocessor')
  const [debugWorkspace, setDebugWorkspace] = createSignal<DebugWorkspace>('input')
  const [selectedSessionId, setSelectedSessionId] = createSignal<string>()
  const [fullChainAttention, setFullChainAttention] = createSignal('')
  const [preprocessorInputSource, setPreprocessorInputSource] = createSignal<'session' | 'manual'>('session')
  const [observation, setObservation] = createSignal('')
  const [attention, setAttention] = createSignal('')
  const [preprocessorPrompt, setPreprocessorPrompt] = createSignal('')
  const [maintenancePrompt, setMaintenancePrompt] = createSignal('')

  const preprocessor = createMemo(() => controller.snapshot().stages.find(
    (stage) => stage.id === 'observation_preprocessor'
  ))
  const maintainer = createMemo(() => controller.snapshot().stages.find(
    (stage) => stage.id === 'knowledge_maintenance_agent'
  ))
  const selectedConnection = (stage?: ProcessingStageView) => controller.snapshot().connections.find(
    (connection) => connection.id === stage?.connectionId
  )
  const stageModel = (stage?: ProcessingStageView) => selectedStageModel(stage, selectedConnection(stage))
  const stageConfigurationIssue = (stage?: ProcessingStageView): string | undefined => {
    if (!stage) return '正在读取阶段配置…'
    if (!stage.connectionId) return `请先为 ${stage.displayName} 选择 Connection。`
    const connection = selectedConnection(stage)
    if (!connection) return `${stage.displayName} 已保存的 Connection 当前不可用：${stage.connectionId}。`
    if (!stage.modelId) return `请先为 ${stage.displayName} 选择 Model。`
    const model = stageModel(stage)
    if (!model) return `${stage.displayName} 已保存的 Model 当前不可用：${stage.modelId}。`
    if (stage.reasoningEffort && !model.reasoningEfforts.includes(stage.reasoningEffort)) {
      return `${stage.displayName} 已保存的思考强度不再受当前 Model 支持。`
    }
    if (!connectionCanAttemptRun(connection)) {
      return `${stage.displayName} 的 Connection 状态为“${connectionStatusLabel(connection.status)}”，需要先完成认证或配置。`
    }
    return undefined
  }
  const stageConfigured = (stage?: ProcessingStageView) => !stageConfigurationIssue(stage)
  const preprocessorPromptDirty = createMemo(() => {
    const stage = preprocessor()
    return stage ? preprocessorPrompt() !== stage.effectiveInstructions : false
  })
  const maintenancePromptDirty = createMemo(() => {
    const stage = maintainer()
    return stage ? maintenancePrompt() !== stage.effectiveInstructions : false
  })
  const fullChainResult = createMemo(() => {
    const result = controller.fullChainResult()
    return result ? fullChainResultView(result) : undefined
  })
  const stageDebugTrace = createMemo(() => controller.debugTrace('stage_debug'))
  const fullChainDebugTrace = createMemo(() => {
    const liveTrace = controller.debugTrace('full_chain')
    const resultTrace = controller.fullChainResult()?.maintenance.debugTrace
    if (
      !controller.isFullChainRunning()
      && resultTrace
      && (!liveTrace || liveTrace.id === resultTrace.id)
    ) {
      return resultTrace
    }
    return liveTrace ?? resultTrace
  })
  const currentPreprocessingResult = createMemo(() => {
    const result = controller.preprocessingResult()
    const trace = stageDebugTrace()
    return result && (!trace || trace.id === result.debugTrace.id) ? result : undefined
  })
  const currentMaintenanceResult = createMemo(() => {
    const result = controller.maintenanceResult()
    const trace = stageDebugTrace()
    if (!result) return undefined
    if (!trace) return result
    return trace.id === result.debugTrace.id
      && trace.status === 'completed'
      && trace.currentStageId === 'knowledge_maintenance_agent'
      && trace.completedAt === result.debugTrace.completedAt
      ? result
      : undefined
  })
  const selectedSession = createMemo(() => controller.availableSessions().find(
    (session) => session.artifactId === selectedSessionId()
  ))
  const anyStageRunning = createMemo(
    () => controller.isFullChainRunning()
      || controller.isRunning('observation_preprocessor')
      || controller.isRunning('knowledge_maintenance_agent')
  )
  const preprocessorDisabledReason = createMemo(() => {
    const stage = preprocessor()
    if (!stage) return '正在读取 Observation Preprocessor 配置…'
    if (anyStageRunning()) return '已有知识加工任务正在运行。'
    if (controller.isSaving(stage.id)) return '正在保存 Observation Preprocessor 配置…'
    const configurationIssue = stageConfigurationIssue(stage)
    if (configurationIssue) return configurationIssue
    if (preprocessorPromptDirty()) return '处理指令有未保存修改，请先保存。'
    if (preprocessorInputSource() === 'manual') {
      return observation().trim() ? undefined : '请输入用于调试的 Observation。'
    }
    if (controller.sessionsLoading()) return '正在读取可用 Session…'
    if (!controller.availableSessions().length) return '暂无可用 Session，请先在“数据来源”中完成扫描。'
    const session = selectedSession()
    if (!session) return '请先选择一个 Session。'
    if (controller.sessionInspectionError(session.artifactId)) {
      return '所选 Session 无法读取，请重新扫描或选择其他 Session。'
    }
    return undefined
  })

  let previousPreprocessorInstructions: string | undefined
  let previousMaintenanceInstructions: string | undefined
  createEffect(() => {
    const instructions = preprocessor()?.effectiveInstructions
    if (instructions !== undefined && instructions !== previousPreprocessorInstructions) {
      previousPreprocessorInstructions = instructions
      setPreprocessorPrompt(instructions)
    }
  })
  createEffect(() => {
    const instructions = maintainer()?.effectiveInstructions
    if (instructions !== undefined && instructions !== previousMaintenanceInstructions) {
      previousMaintenanceInstructions = instructions
      setMaintenancePrompt(instructions)
    }
  })

  let previousDebugStage: string | undefined
  createEffect(() => {
    const stageId = stageDebugTrace()?.currentStageId
    if (!stageId || stageId === previousDebugStage) return
    previousDebugStage = stageId
    setDebugStage(stageId === 'knowledge_maintenance_agent' ? 'maintainer' : 'preprocessor')
    setDebugWorkspace('process')
  })

  function storedInstructions(stage: ProcessingStageView): string | null {
    return stage.isCustomized ? stage.effectiveInstructions : null
  }

  function saveConnection(stage: ProcessingStageView, connectionId: string | null): void {
    const connection = controller.snapshot().connections.find((candidate) => candidate.id === connectionId)
    const modelId = connection
      ? connection.models.find((model) => model.id === connection.defaultModelId)?.id
        ?? connection.models[0]?.id
        ?? null
      : null
    const model = connection?.models.find((candidate) => candidate.id === modelId)
    const reasoningEffort = stage.reasoningEffort
      && model?.reasoningEfforts.includes(stage.reasoningEffort)
      ? stage.reasoningEffort
      : null
    void controller.saveStage({
      stageId: stage.id,
      connectionId,
      modelId,
      instructionsOverride: storedInstructions(stage),
      reasoningEffort
    })
  }

  function saveModel(stage: ProcessingStageView, modelId: string): void {
    const connection = selectedConnection(stage)
    const model = connection?.models.find((candidate) => candidate.id === modelId)
    const reasoningEffort = stage.reasoningEffort
      && model?.reasoningEfforts.includes(stage.reasoningEffort)
      ? stage.reasoningEffort
      : null
    void controller.saveStage({
      stageId: stage.id,
      connectionId: stage.connectionId || null,
      modelId: model?.id || null,
      instructionsOverride: storedInstructions(stage),
      reasoningEffort
    })
  }

  function saveReasoningEffort(
    stage: ProcessingStageView,
    reasoningEffort: ReasoningEffort | null
  ): void {
    void controller.saveStage({
      stageId: stage.id,
      connectionId: stage.connectionId || null,
      modelId: stage.modelId || null,
      instructionsOverride: storedInstructions(stage),
      reasoningEffort
    })
  }

  function savePrompt(stage: ProcessingStageView, draft: string): void {
    void controller.saveStage({
      stageId: stage.id,
      connectionId: stage.connectionId || null,
      modelId: stage.modelId || null,
      instructionsOverride: draft === stage.defaultInstructions ? null : draft,
      reasoningEffort: stage.reasoningEffort ?? null
    })
  }

  async function restorePrompt(
    stage: ProcessingStageView,
    setDraft: (value: string) => void
  ): Promise<void> {
    const saved = await controller.saveStage({
      stageId: stage.id,
      connectionId: stage.connectionId || null,
      modelId: stage.modelId || null,
      instructionsOverride: null,
      reasoningEffort: stage.reasoningEffort ?? null
    })
    if (saved) setDraft(stage.defaultInstructions)
  }

  const runAttention = () => attention().trim() || undefined

  function updateObservation(value: string): void {
    setObservation(value)
    controller.invalidateInputResults()
  }

  function updatePreprocessorInputSource(source: 'session' | 'manual'): void {
    if (source === preprocessorInputSource()) return
    setPreprocessorInputSource(source)
    controller.invalidateInputResults()
  }

  function updateSelectedSession(value: string): void {
    const artifactId = value || undefined
    setSelectedSessionId(artifactId)
    controller.invalidateInputResults()
    const session = controller.availableSessions().find(
      (candidate) => candidate.artifactId === artifactId
    )
    if (session) void controller.inspectAvailableSession(session)
  }

  function updateAttention(value: string): void {
    setAttention(value)
    controller.invalidateInputResults()
  }

  return (
    <>
      <header class="page-header">
        <div>
          <h1>知识加工</h1>
          <div class="page-summary">
            <Show
              when={view() === 'full_chain'}
              fallback={<span><strong>2</strong> 个固定阶段</span>}
            >
              <span>在隔离的 <strong>Knowledge Sandbox</strong> 中验证完整链路</span>
            </Show>
            <span class="page-summary__separator">·</span>
            <span>{view() === 'full_chain' ? '不影响正式知识库' : '每个阶段仅在显式点击后运行'}</span>
          </div>
        </div>
      </header>

      <Show when={controller.error()}>
        <div class="page-error"><Icon name="warning" />{controller.error()}</div>
      </Show>
      <Show when={controller.snapshot().configurationError}>
        <div class="page-error"><Icon name="warning" />{controller.snapshot().configurationError}</div>
      </Show>

      <div class="processing-view-switch" role="tablist" aria-label="知识加工模式">
        <button
          type="button"
          role="tab"
          data-testid="processing-view-full-chain"
          aria-selected={view() === 'full_chain'}
          onClick={() => setView('full_chain')}
        >完整链路</button>
        <button
          type="button"
          role="tab"
          data-testid="processing-view-stage-debug"
          aria-selected={view() === 'stage_debug'}
          onClick={() => setView('stage_debug')}
        >阶段调试</button>
      </div>

      <div
        class="processing-page-panel processing-tab-panel"
        role="tabpanel"
        hidden={view() !== 'full_chain'}
      >
        <FullChainWorkspace
          sessions={controller.availableSessions()}
          sessionsLoading={controller.sessionsLoading()}
          selectedSessionId={selectedSessionId()}
          selectedSessionInspecting={controller.isInspectingSession(
            selectedSession()?.artifactId || ''
          )}
          selectedSessionInspectionError={controller.sessionInspectionError(
            selectedSession()?.artifactId || ''
          )}
          attention={fullChainAttention()}
          preprocessor={preprocessor()}
          preprocessorConnection={selectedConnection(preprocessor())}
          maintainer={maintainer()}
          maintainerConnection={selectedConnection(maintainer())}
          running={controller.isFullChainRunning()}
          preprocessingProgress={controller.isFullChainRunning()
            ? controller.snapshot().preprocessingProgress
            : undefined}
          maintenanceRunning={controller.isFullChainRunning()
            && controller.snapshot().runningStageIds.includes('knowledge_maintenance_agent')}
          debugTrace={fullChainDebugTrace()}
          locked={anyStageRunning()}
          discarding={Boolean(
            fullChainResult()
            && controller.isDiscardingSandbox(fullChainResult()!.sandboxId)
          )}
          result={fullChainResult()}
          onSelectSession={updateSelectedSession}
          onAttentionInput={setFullChainAttention}
          onRun={() => {
            const session = controller.availableSessions().find(
              (candidate) => candidate.artifactId === selectedSessionId()
            )
            if (!session) return
            void controller.runFullChain({
              artifactId: session.artifactId,
              expectedRevision: session.revision,
              attention: fullChainAttention().trim() || undefined
            })
          }}
          onCancel={() => void controller.cancelFullChain()}
          onDiscardSandbox={() => {
            const result = controller.fullChainResult()
            if (result) void controller.discardSandbox(result.sandbox.id)
          }}
        />
      </div>

      <div
        class="processing-page-panel processing-tab-panel"
        role="tabpanel"
        hidden={view() !== 'stage_debug'}
      >
        <div class="processing-notice">
          <Icon name="warning" />
          <span>这是显式阶段调试工作面。运行时会把当前材料发送到所选 Connection；两个阶段不会自动串联。</span>
        </div>

        <div class="processing-stage-switch" role="tablist" aria-label="调试阶段">
          <button
            type="button"
            role="tab"
            aria-selected={debugStage() === 'preprocessor'}
            aria-controls="processing-stage-observation_preprocessor"
            data-testid="processing-stage-tab-observation_preprocessor"
            onClick={() => setDebugStage('preprocessor')}
          >
            <span>1</span>
            <div><strong>观察预处理</strong><small>{currentPreprocessingResult() ? '已有输出' : '生成 Evidence Map'}</small></div>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={debugStage() === 'maintainer'}
            aria-controls="processing-stage-knowledge_maintenance_agent"
            data-testid="processing-stage-tab-knowledge_maintenance_agent"
            onClick={() => setDebugStage('maintainer')}
          >
            <span>2</span>
            <div><strong>知识维护</strong><small>{currentPreprocessingResult() ? '输入已准备' : '等待 Evidence Map'}</small></div>
          </button>
        </div>

        <section class="processing-list" aria-label="知识加工阶段">
        <Show when={preprocessor()}>
          {(stage) => (
            <article
              id="processing-stage-observation_preprocessor"
              class="processing-stage"
              data-testid="processing-stage-observation_preprocessor"
              hidden={debugStage() !== 'preprocessor'}
            >
              <div class="processing-stage__header">
                <span class="processing-stage__index">1</span>
                <div>
                  <h2>{stage().displayName}</h2>
                  <p>{stage().description}</p>
                </div>
                <span class="processing-runtime">{runtimeLabel(stage().runtime)}</span>
              </div>
              <div class="processing-capabilities">
                <For each={stage().capabilities}>{(capability) => <span>{capability}</span>}</For>
              </div>

              <DebugWorkspaceTabs
                stageId="observation-preprocessor"
                selected={debugWorkspace()}
                onSelect={setDebugWorkspace}
              />

              <div
                id="observation-preprocessor-panel-configuration"
                class="processing-workspace-panel processing-tab-panel"
                role="tabpanel"
                hidden={debugWorkspace() !== 'configuration'}
              >
                <ConnectionConfiguration
                  stage={stage()}
                  connections={controller.snapshot().connections}
                  selected={selectedConnection(stage())}
                  saving={controller.isSaving(stage().id)}
                  locked={anyStageRunning()}
                  onChange={(connectionId) => saveConnection(stage(), connectionId)}
                  onModelChange={(modelId) => saveModel(stage(), modelId)}
                  onReasoningEffortChange={(effort) => saveReasoningEffort(stage(), effort)}
                />
                <PromptConfiguration
                  stage={stage()}
                  draft={preprocessorPrompt()}
                  saving={controller.isSaving(stage().id)}
                  locked={anyStageRunning()}
                  onInput={setPreprocessorPrompt}
                  onSave={() => savePrompt(stage(), preprocessorPrompt())}
                  onRestore={() => void restorePrompt(stage(), setPreprocessorPrompt)}
                />
              </div>

              <div
                id="observation-preprocessor-panel-input"
                class="processing-workspace-panel processing-tab-panel"
                role="tabpanel"
                hidden={debugWorkspace() !== 'input'}
              >
              <section class="processing-input" aria-label="观察预处理输入">
                <div class="processing-input__heading">
                  <h3>{stage().inputDescription}</h3>
                  <span>不会自动运行</span>
                </div>
                <div class="processing-input-source">
                  <span>输入来源</span>
                  <div role="group" aria-label="预处理输入来源">
                    <button
                      type="button"
                      data-testid="preprocessor-source-session"
                      aria-pressed={preprocessorInputSource() === 'session'}
                      disabled={anyStageRunning()}
                      onClick={() => updatePreprocessorInputSource('session')}
                    >本地 Session</button>
                    <button
                      type="button"
                      data-testid="preprocessor-source-manual"
                      aria-pressed={preprocessorInputSource() === 'manual'}
                      disabled={anyStageRunning()}
                      onClick={() => updatePreprocessorInputSource('manual')}
                    >手工输入</button>
                  </div>
                </div>
                <Show
                  when={preprocessorInputSource() === 'session'}
                  fallback={(
                    <label class="ai-field ai-field--wide">
                      <span>Observation（调试 fallback）</span>
                      <textarea
                        data-testid="processing-observation-input"
                        value={observation()}
                        rows={8}
                        placeholder="粘贴一段用于排查特定预处理问题的观察材料…"
                        disabled={anyStageRunning()}
                        onInput={(event) => updateObservation(event.currentTarget.value)}
                      />
                    </label>
                  )}
                >
                  <label class="ai-field ai-field--wide">
                    <span>可用 Session</span>
                    <select
                      data-testid="processing-preprocessor-session"
                      value={selectedSessionId() || ''}
                      disabled={
                        anyStageRunning()
                        || controller.sessionsLoading()
                        || controller.availableSessions().length === 0
                      }
                      onChange={(event) => updateSelectedSession(event.currentTarget.value)}
                    >
                      <option value="">
                        {controller.sessionsLoading()
                          ? '正在读取可用 Session…'
                          : controller.availableSessions().length
                            ? '选择一个 Session'
                            : '暂无可用 Session'}
                      </option>
                      <For each={controller.availableSessions()}>{(session) => (
                        <option value={session.artifactId}>{sessionOptionLabel(session)}</option>
                      )}</For>
                    </select>
                  </label>
                  <Show
                    when={selectedSession()}
                    fallback={(
                      <p class="processing-input__hint">
                        {controller.availableSessions().length
                          ? '选择后将在运行时从 Agent 的原始位置读取；原记录发生变化或消失时需要重新扫描。'
                          : '请先在“数据来源”中扫描 Agent 对话；手工输入仅用于特殊调试。'}
                      </p>
                    )}
                  >
                    {(session) => (
                      <SessionMetadata
                        session={session()}
                        class="processing-session-summary"
                        testId="preprocessor-session-meta"
                        loading={controller.isInspectingSession(session().artifactId)}
                        error={controller.sessionInspectionError(session().artifactId)}
                      />
                    )}
                  </Show>
                </Show>
                <label class="ai-field ai-field--wide">
                  <span>Attention（可选，两个阶段共用）</span>
                  <input
                    data-testid="processing-attention-input"
                    value={attention()}
                    placeholder="例如：重点关注用户明确否定过的设计选择"
                    disabled={anyStageRunning()}
                    onInput={(event) => updateAttention(event.currentTarget.value)}
                  />
                </label>
                <p
                  class={`processing-stage__run-status${preprocessorDisabledReason() ? ' processing-stage__run-status--blocked' : ''}`}
                  data-testid="preprocessor-disabled-reason"
                >
                  {preprocessorDisabledReason() || '配置和输入已准备，可以运行预处理。'}
                </p>
                <div class="processing-stage__actions">
                  <Show
                    when={controller.isRunning(stage().id)}
                    fallback={(
                      <Button
                        variant="primary"
                        icon="play"
                        data-testid="run-preprocessor"
                        disabled={Boolean(preprocessorDisabledReason())}
                        onClick={() => {
                          const session = selectedSession()
                          if (preprocessorInputSource() === 'session') {
                            if (!session) return
                            setDebugWorkspace('process')
                            void controller.runSessionPreprocessor({
                              artifactId: session.artifactId,
                              expectedRevision: session.revision,
                              attention: runAttention()
                            })
                            return
                          }
                          setDebugWorkspace('process')
                          void controller.runObservationPreprocessor({
                            observation: observation(),
                            attention: runAttention()
                          })
                        }}
                      >运行预处理</Button>
                    )}
                  >
                    <Button
                      variant="danger"
                      icon="stop"
                      data-testid="cancel-preprocessor"
                      onClick={() => void controller.cancelRun(stage().id)}
                    >停止预处理</Button>
                  </Show>
                </div>
              </section>
              </div>

              <div
                id="observation-preprocessor-panel-process"
                class="processing-workspace-panel processing-tab-panel"
                role="tabpanel"
                hidden={debugWorkspace() !== 'process'}
              >
                <Show
                  when={stageDebugTrace()?.preprocessing ? stageDebugTrace() : undefined}
                  fallback={<div class="processing-workspace-empty">运行预处理后，这里会逐段展示模型调用、进度和局部 Evidence Map 输出。</div>}
                >
                  {(trace) => (
                    <ProcessingDebugTracePanel
                      trace={trace()}
                      showMaintenance={false}
                      title="预处理调用调试"
                    />
                  )}
                </Show>
                <Show when={controller.isRunning(stage().id)}>
                  <div class="processing-workspace-running-actions">
                    <span>预处理正在运行，可以继续查看逐段输出。</span>
                    <Button
                      variant="danger"
                      icon="stop"
                      data-testid="cancel-preprocessor-process"
                      onClick={() => void controller.cancelRun(stage().id)}
                    >停止预处理</Button>
                  </div>
                </Show>
              </div>

              <div
                id="observation-preprocessor-panel-output"
                class="processing-workspace-panel processing-tab-panel"
                role="tabpanel"
                hidden={debugWorkspace() !== 'output'}
              >
                <Show
                  when={!controller.isRunning(stage().id) ? currentPreprocessingResult() : undefined}
                  fallback={<div class="processing-workspace-empty">完成预处理后，这里会展示完整 Evidence Map 与本次执行配置。</div>}
                >
                  {(result) => <PreprocessingResult result={result()} />}
                </Show>
              </div>
            </article>
          )}
        </Show>

        <Show when={maintainer()}>
          {(stage) => (
            <article
              id="processing-stage-knowledge_maintenance_agent"
              class="processing-stage"
              data-testid="processing-stage-knowledge_maintenance_agent"
              hidden={debugStage() !== 'maintainer'}
            >
              <div class="processing-stage__header">
                <span class="processing-stage__index">2</span>
                <div>
                  <h2>{stage().displayName}</h2>
                  <p>{stage().description}</p>
                </div>
                <span class="processing-runtime">{runtimeLabel(stage().runtime)}</span>
              </div>
              <div class="processing-capabilities">
                <For each={stage().capabilities}>{(capability) => <span>{capability}</span>}</For>
              </div>

              <DebugWorkspaceTabs
                stageId="knowledge-maintainer"
                selected={debugWorkspace()}
                onSelect={setDebugWorkspace}
              />

              <div
                id="knowledge-maintainer-panel-configuration"
                class="processing-workspace-panel processing-tab-panel"
                role="tabpanel"
                hidden={debugWorkspace() !== 'configuration'}
              >
                <ConnectionConfiguration
                  stage={stage()}
                  connections={controller.snapshot().connections}
                  selected={selectedConnection(stage())}
                  saving={controller.isSaving(stage().id)}
                  locked={anyStageRunning()}
                  onChange={(connectionId) => saveConnection(stage(), connectionId)}
                  onModelChange={(modelId) => saveModel(stage(), modelId)}
                  onReasoningEffortChange={(effort) => saveReasoningEffort(stage(), effort)}
                />
                <PromptConfiguration
                  stage={stage()}
                  draft={maintenancePrompt()}
                  saving={controller.isSaving(stage().id)}
                  locked={anyStageRunning()}
                  onInput={setMaintenancePrompt}
                  onSave={() => savePrompt(stage(), maintenancePrompt())}
                  onRestore={() => void restorePrompt(stage(), setMaintenancePrompt)}
                />
              </div>

              <div
                id="knowledge-maintainer-panel-input"
                class="processing-workspace-panel processing-tab-panel"
                role="tabpanel"
                hidden={debugWorkspace() !== 'input'}
              >
              <section class="processing-dependency" aria-label="知识维护输入">
                <div>
                  <h3>{stage().inputDescription}</h3>
                  <Show
                    when={currentPreprocessingResult()}
                    fallback={<p>等待一次成功的观察预处理运行。</p>}
                  >
                    {(result) => (
                      <p>将使用 Evidence Map Run <code>{result().runId}</code>，并按需回溯其观察材料。</p>
                    )}
                  </Show>
                </div>
                <span class={`processing-dependency__state${currentPreprocessingResult() ? ' processing-dependency__state--ready' : ''}`}>
                  {currentPreprocessingResult() ? '已准备' : '未准备'}
                </span>
              </section>

              <Show when={maintenancePromptDirty()}>
                <p class="processing-stage__action-note">请先保存处理指令，再运行知识维护。</p>
              </Show>
              <Show when={stageConfigurationIssue(stage())}>
                {(issue) => <p class="processing-stage__action-note">{issue()}</p>}
              </Show>
              <div class="processing-stage__actions">
                <Show
                  when={controller.isRunning(stage().id)}
                  fallback={(
                    <Button
                      variant="primary"
                      icon="play"
                      data-testid="run-maintainer"
                      disabled={
                        !stageConfigured(stage())
                        || !currentPreprocessingResult()
                        || maintenancePromptDirty()
                        || controller.isSaving(stage().id)
                        || anyStageRunning()
                      }
                      onClick={() => {
                        const result = currentPreprocessingResult()
                        if (!result) return
                        setDebugWorkspace('process')
                        void controller.runKnowledgeMaintenance({
                          preprocessingRunId: result.runId,
                          attention: runAttention()
                        })
                      }}
                    >运行知识维护</Button>
                  )}
                >
                  <Button
                    variant="danger"
                    icon="stop"
                    data-testid="cancel-maintainer"
                    onClick={() => void controller.cancelRun(stage().id)}
                  >停止知识维护</Button>
                  </Show>
                </div>
              </div>

              <div
                id="knowledge-maintainer-panel-process"
                class="processing-workspace-panel processing-tab-panel"
                role="tabpanel"
                hidden={debugWorkspace() !== 'process'}
              >
                <Show
                  when={stageDebugTrace()?.maintenance ? stageDebugTrace() : undefined}
                  fallback={<div class="processing-workspace-empty">运行知识维护后，这里会展示模型轮次和 Agent 的工具活动。</div>}
                >
                  {(trace) => (
                    <ProcessingDebugTracePanel
                      trace={trace()}
                      showPreprocessing={false}
                      title="知识维护 Agent 调试"
                    />
                  )}
                </Show>
                <Show when={controller.isRunning(stage().id)}>
                  <div class="processing-workspace-running-actions">
                    <span>知识维护正在运行，可以继续查看模型与工具活动。</span>
                    <Button
                      variant="danger"
                      icon="stop"
                      data-testid="cancel-maintainer-process"
                      onClick={() => void controller.cancelRun(stage().id)}
                    >停止知识维护</Button>
                  </div>
                </Show>
                <p class="processing-workspace-disclosure">
                  调试记录不会展示完整模型上下文；模型输出可能复述原始材料，请按原始证据的敏感级别查看。
                </p>
              </div>

              <div
                id="knowledge-maintainer-panel-output"
                class="processing-workspace-panel processing-tab-panel"
                role="tabpanel"
                hidden={debugWorkspace() !== 'output'}
              >
                <Show
                  when={
                    !controller.isRunning(stage().id) && !controller.isRunning('observation_preprocessor')
                      ? currentMaintenanceResult()
                      : undefined
                  }
                  fallback={<div class="processing-workspace-empty">完成知识维护后，这里会以 Statement 列表和详情展示候选 Knowledge Contribution。</div>}
                >
                  {(result) => <MaintenanceResult result={result()} />}
                </Show>
              </div>
            </article>
          )}
        </Show>
        </section>
      </div>
    </>
  )
}

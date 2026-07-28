import { For, Show, createEffect, createMemo, createSignal } from 'solid-js'
import type { AvailableSessionSummary } from '../../../shared/discovery'
import type {
  KnowledgeProcessingDebugTrace,
  ObservationPreprocessingProgress,
  ProcessingConnectionView,
  ProcessingStageView,
  StatementCandidateView
} from '../../../shared/knowledge-processing'
import {
  backendLabel,
  connectionCanAttemptRun,
  connectionStatusLabel,
  providerLabel,
  reasoningLabel,
  runtimeLabel,
  selectedStageModel
} from '../processing-configuration'
import { Button, Icon } from '../ui'
import { ProcessingDebugTracePanel } from './ProcessingDebugTracePanel'
import { SessionMetadata, sessionOptionLabel, sessionTitle } from './SessionMetadata'
import { StatementCandidateList } from './StatementCandidateList'

export type FullChainStepState = 'pending' | 'running' | 'completed' | 'failed'

export interface FullChainStepView {
  id: string
  label: string
  detail: string
  state: FullChainStepState
}

export interface SandboxStatementView {
  title: string
  content: string
}

export interface SandboxContributionView {
  id: string
  content: string
  createdAt: string
}

export interface FullChainResultView {
  runId: string
  sandboxId: string
  session: AvailableSessionSummary
  baselineCreatedAt?: string
  completedAt?: string
  durationMs?: number
  statementCandidates: StatementCandidateView[]
  debugTrace: KnowledgeProcessingDebugTrace
  steps: FullChainStepView[]
  contributions: SandboxContributionView[]
  statements: SandboxStatementView[]
}

export interface FullChainWorkspaceProps {
  sessions: AvailableSessionSummary[]
  sessionsLoading: boolean
  selectedSessionId?: string
  attention: string
  preprocessor?: ProcessingStageView
  preprocessorConnection?: ProcessingConnectionView
  maintainer?: ProcessingStageView
  maintainerConnection?: ProcessingConnectionView
  running: boolean
  preprocessingProgress?: ObservationPreprocessingProgress
  maintenanceRunning: boolean
  debugTrace?: KnowledgeProcessingDebugTrace
  locked: boolean
  discarding: boolean
  result?: FullChainResultView
  onSelectSession(id: string): void
  onAttentionInput(value: string): void
  onRun(): void
  onCancel(): void
  onDiscardSandbox(): void
}

function formatTime(value?: string): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN')
}

function stageConfiguration(
  stage?: ProcessingStageView,
  connection?: ProcessingConnectionView
): {
  connection: string
  backend: string
  provider: string
  destinationLabel: string
  destination: string
  model: string
  prompt: string
  reasoning: string
  runtime: string
  status: string
  runnable: boolean
} {
  if (!stage) return {
    connection: '正在读取配置…', backend: '—', provider: '—', destinationLabel: 'Endpoint',
    destination: '—', model: '—', prompt: '—', reasoning: '—', runtime: '—', status: '正在读取', runnable: false
  }
  const model = selectedStageModel(stage, connection)
  const reasoningSupported = !stage.reasoningEffort
    || Boolean(model?.reasoningEfforts.includes(stage.reasoningEffort))
  const codingPlanContext = [connection?.accountLabel, connection?.planType].filter(Boolean).join(' · ')
  return {
    connection: connection?.displayName || (stage.connectionId ? '连接配置不可用' : '尚未选择 Model Connection'),
    backend: connection ? backendLabel(connection.backendKind) : '—',
    provider: connection ? providerLabel(connection.providerId) : '—',
    destinationLabel: connection?.backendKind === 'coding_plan' ? 'Account / Plan' : 'Endpoint',
    destination: connection?.backendKind === 'coding_plan' ? codingPlanContext || '—' : connection?.destination || '—',
    model: model?.id || (stage.modelId ? `当前不可用 · ${stage.modelId}` : '未选择'),
    prompt: stage.isCustomized ? 'Customized Prompt' : 'Default Prompt',
    reasoning: reasoningLabel(stage.reasoningEffort),
    runtime: runtimeLabel(stage.runtime),
    status: connection ? connectionStatusLabel(connection.status) : '未配置',
    runnable: Boolean(
      connection
      && model
      && reasoningSupported
      && connectionCanAttemptRun(connection)
    )
  }
}

function stepClass(state: FullChainStepState): string {
  return `full-chain-step full-chain-step--${state}`
}

function stepMarker(step: FullChainStepView, index: number): string {
  if (step.state === 'completed') return '✓'
  if (step.state === 'failed') return '!'
  if (step.state === 'running') return '…'
  return String(index + 1)
}

function preprocessingProgressText(progress: ObservationPreprocessingProgress): string {
  if (progress.phase === 'preparing') return '正在准备 Observation 分段…'
  return progress.totalSegments
    ? `正在发现 Statement 候选 · ${progress.completedSegments} / ${progress.totalSegments} 个分段`
    : '正在发现 Statement 候选…'
}

export function FullChainWorkspace(props: FullChainWorkspaceProps) {
  const [workspace, setWorkspace] = createSignal<'input' | 'process' | 'result'>('input')
  const [output, setOutput] = createSignal<'knowledge' | 'candidates' | 'contributions'>('knowledge')
  const [selectedStatementTitle, setSelectedStatementTitle] = createSignal<string>()
  const selectedSession = createMemo(() => props.sessions.find(
    (session) => session.artifactId === props.selectedSessionId
  ))
  const selectedStatement = createMemo(() => props.result?.statements.find(
    (statement) => statement.title === selectedStatementTitle()
  ) || props.result?.statements[0])
  const preprocessorConfig = createMemo(() => stageConfiguration(
    props.preprocessor,
    props.preprocessorConnection
  ))
  const maintainerConfig = createMemo(() => stageConfiguration(
    props.maintainer,
    props.maintainerConnection
  ))
  const disabledReason = createMemo(() => {
    if (props.locked) return '已有知识加工任务正在运行。'
    if (!selectedSession()) return '请先选择一个 Session。'
    if (!props.preprocessor?.connectionId) return '请先为 Observation Preprocessor 选择 Connection。'
    if (!props.preprocessorConnection) return `Observation Preprocessor 已保存的 Connection 当前不可用：${props.preprocessor.connectionId}。`
    if (!props.preprocessor?.modelId) return '请先为 Observation Preprocessor 选择 Model。'
    const preprocessorModel = selectedStageModel(props.preprocessor, props.preprocessorConnection)
    if (!preprocessorModel) return `Observation Preprocessor 已保存的 Model 当前不可用：${props.preprocessor.modelId}。`
    if (
      props.preprocessor.reasoningEffort
      && !preprocessorModel.reasoningEfforts.includes(props.preprocessor.reasoningEffort)
    ) return 'Observation Preprocessor 已保存的思考强度不再受当前 Model 支持。'
    if (!preprocessorConfig().runnable) return 'Observation Preprocessor 的 Connection 需要先完成认证或配置。'
    if (!props.maintainer?.connectionId) return '请先为 Knowledge Maintenance Agent 选择 Connection。'
    if (!props.maintainerConnection) return `Knowledge Maintenance Agent 已保存的 Connection 当前不可用：${props.maintainer.connectionId}。`
    if (!props.maintainer?.modelId) return '请先为 Knowledge Maintenance Agent 选择 Model。'
    const maintainerModel = selectedStageModel(props.maintainer, props.maintainerConnection)
    if (!maintainerModel) return `Knowledge Maintenance Agent 已保存的 Model 当前不可用：${props.maintainer.modelId}。`
    if (
      props.maintainer.reasoningEffort
      && !maintainerModel.reasoningEfforts.includes(props.maintainer.reasoningEffort)
    ) return 'Knowledge Maintenance Agent 已保存的思考强度不再受当前 Model 支持。'
    if (!maintainerConfig().runnable) return 'Knowledge Maintenance Agent 的 Connection 需要先完成认证或配置。'
    return undefined
  })
  const canRun = createMemo(() => !disabledReason())
  const visibleDebugTrace = createMemo(() => props.debugTrace ?? props.result?.debugTrace)
  const resultMatchesTrace = createMemo(() => {
    const trace = visibleDebugTrace()
    return !trace || !props.result || trace.id === props.result.debugTrace.id
  })

  let previousRunId: string | undefined
  createEffect(() => {
    const runId = props.result?.runId
    if (runId && runId !== previousRunId) {
      previousRunId = runId
      setWorkspace('result')
      setOutput('knowledge')
      setSelectedStatementTitle(props.result?.statements[0]?.title)
    }
  })

  return (
    <div class="full-chain" data-testid="full-chain-workspace">
      <div class="processing-workspace-tabs" role="tablist" aria-label="完整链路工作区">
        <button
          type="button"
          role="tab"
          aria-selected={workspace() === 'input'}
          aria-controls="full-chain-panel-input"
          data-testid="full-chain-tab-input"
          onClick={() => setWorkspace('input')}
        >输入与运行</button>
        <button
          type="button"
          role="tab"
          aria-selected={workspace() === 'process'}
          aria-controls="full-chain-panel-process"
          data-testid="full-chain-tab-process"
          onClick={() => setWorkspace('process')}
        >调用过程</button>
        <button
          type="button"
          role="tab"
          aria-selected={workspace() === 'result'}
          aria-controls="full-chain-panel-result"
          data-testid="full-chain-tab-result"
          onClick={() => setWorkspace('result')}
        >结果</button>
      </div>

      <section
        id="full-chain-panel-input"
        class="full-chain-card processing-tab-panel"
        role="tabpanel"
        hidden={workspace() !== 'input'}
        aria-label="完整链路配置"
      >
        <div class="full-chain-card__heading">
          <div>
            <h2>从 Session 生成知识</h2>
            <p>选择一条已发现的本机会话，在隔离知识库中运行与正式流程相同的预处理、知识维护与写入。</p>
          </div>
          <span class="sandbox-badge">Knowledge Sandbox</span>
        </div>

        <div class="full-chain-form">
          <label class="ai-field ai-field--wide">
            <span>可用 Session</span>
            <select
              data-testid="full-chain-session-select"
              value={props.selectedSessionId || ''}
              disabled={props.sessionsLoading || props.locked || props.sessions.length === 0}
              onChange={(event) => props.onSelectSession(event.currentTarget.value)}
            >
              <option value="">
                {props.sessionsLoading ? '正在读取可用 Session…' : props.sessions.length ? '选择一个 Session' : '暂无可测试的 Session'}
              </option>
              <For each={props.sessions}>{(session) => (
                <option value={session.artifactId}>
                  {sessionOptionLabel(session)}
                </option>
              )}</For>
            </select>
          </label>

          <Show
            when={selectedSession()}
            fallback={(
              <div class="full-chain-empty">
                {props.sessionsLoading
                  ? '正在读取可用的会话…'
                  : props.sessions.length
                    ? '选择 Session 后会固定扫描到的版本；运行时从 Agent 的原始位置读取内容。'
                    : '请先在“数据来源”中扫描至少一个会话。'}
              </div>
            )}
          >
            {(session) => (
              <SessionMetadata
                session={session()}
                class="full-chain-session-meta"
                testId="full-chain-session-meta"
              />
            )}
          </Show>

          <label class="ai-field ai-field--wide">
            <span>Attention（可选）</span>
            <input
              data-testid="full-chain-attention-input"
              value={props.attention}
              disabled={props.locked}
              placeholder="例如：重点关注用户明确否定过的设计选择"
              onInput={(event) => props.onAttentionInput(event.currentTarget.value)}
            />
          </label>

          <div class="full-chain-stage-configs" aria-label="链路阶段配置">
            <div class="full-chain-stage-config" data-testid="full-chain-config-observation_preprocessor">
              <div class="full-chain-stage-config__heading">
                <strong>Observation Preprocessor</strong><span>{preprocessorConfig().runtime}</span>
              </div>
              <dl>
                <div><dt>Connection</dt><dd>{preprocessorConfig().connection}</dd></div>
                <div><dt>Backend / Provider</dt><dd>{preprocessorConfig().backend} · {preprocessorConfig().provider}</dd></div>
                <div><dt>{preprocessorConfig().destinationLabel}</dt><dd>{preprocessorConfig().destination}</dd></div>
                <div><dt>Model / Reasoning</dt><dd>{preprocessorConfig().model} · {preprocessorConfig().reasoning}</dd></div>
                <div><dt>Prompt / 状态</dt><dd>{preprocessorConfig().prompt} · {preprocessorConfig().status}</dd></div>
              </dl>
            </div>
            <div class="full-chain-stage-config" data-testid="full-chain-config-knowledge_maintenance_agent">
              <div class="full-chain-stage-config__heading">
                <strong>Knowledge Maintenance Agent</strong><span>{maintainerConfig().runtime}</span>
              </div>
              <dl>
                <div><dt>Connection</dt><dd>{maintainerConfig().connection}</dd></div>
                <div><dt>Backend / Provider</dt><dd>{maintainerConfig().backend} · {maintainerConfig().provider}</dd></div>
                <div><dt>{maintainerConfig().destinationLabel}</dt><dd>{maintainerConfig().destination}</dd></div>
                <div><dt>Model / Reasoning</dt><dd>{maintainerConfig().model} · {maintainerConfig().reasoning}</dd></div>
                <div><dt>Prompt / 状态</dt><dd>{maintainerConfig().prompt} · {maintainerConfig().status}</dd></div>
              </dl>
            </div>
          </div>

          <div class="full-chain-form__actions">
            <p data-testid="full-chain-disabled-reason">
              {props.preprocessingProgress
                ? preprocessingProgressText(props.preprocessingProgress)
                : props.maintenanceRunning
                  ? '观察预处理已完成，Knowledge Maintenance Agent 正在运行…'
                : disabledReason() || 'Session 与两个阶段配置完整，可以运行隔离测试。'}
            </p>
            <Show
              when={props.running}
              fallback={(
                <Button
                  variant="primary"
                  size="wide"
                  icon="play"
                  data-testid="run-full-chain"
                  disabled={!canRun()}
                  onClick={() => {
                    setWorkspace('process')
                    props.onRun()
                  }}
                >运行完整链路</Button>
              )}
            >
              <Button
                variant="danger"
                size="wide"
                icon="stop"
                data-testid="cancel-full-chain"
                onClick={props.onCancel}
              >停止运行</Button>
            </Show>
          </div>
        </div>
      </section>

      <section
        id="full-chain-panel-process"
        class="full-chain-workspace-panel processing-tab-panel"
        role="tabpanel"
        hidden={workspace() !== 'process'}
        aria-label="完整链路调用过程"
      >
        <Show when={props.running}>
          <div class="processing-notice" data-testid="full-chain-running-impact">
            <Icon name="warning" />
            <span>链路已直接开始：所选 Session 的处理材料正在发送到页面中显示的两个 Connection，模型调用可能消耗额度；本页会持续展示分段、Agent 工具活动、错误和最终结果。</span>
          </div>
        </Show>
        <Show
          when={visibleDebugTrace()}
          fallback={(
            <div class="processing-workspace-empty">
              运行开始后，这里会展示预处理分段、每次模型调用和知识维护 Agent 的工具活动。
            </div>
          )}
        >
          {(trace) => (
            <ProcessingDebugTracePanel
              trace={trace()}
              title="完整链路运行调试"
            />
          )}
        </Show>
        <Show when={props.running}>
          <div class="processing-workspace-running-actions">
            <span>链路正在运行，可以继续查看上方进度。</span>
            <Button
              variant="danger"
              icon="stop"
              data-testid="cancel-full-chain-process"
              onClick={props.onCancel}
            >停止运行</Button>
          </div>
        </Show>
      </section>

      <section
        id="full-chain-panel-result"
        class="full-chain-workspace-panel processing-tab-panel"
        role="tabpanel"
        hidden={workspace() !== 'result'}
        aria-label="完整链路结果"
      >
        <Show
          when={!props.running && props.result ? props.result : undefined}
          fallback={(
            <div class="processing-workspace-empty">
              {props.running ? '链路正在运行；可以在“调用过程”中查看当前进度。' : '完成一次隔离运行后，这里会展示 Statement 候选、Contribution 和 Knowledge Statements。'}
            </div>
          )}
        >
          {(result) => (
            <>
            <section class="full-chain-card" data-testid="full-chain-run-result" aria-label="完整链路运行结果">
              <div class="full-chain-card__heading">
                <div>
                  <h2>{resultMatchesTrace() ? '运行结果' : '上一次成功结果'}</h2>
                  <p>
                    {resultMatchesTrace()
                      ? '本次隔离运行会展示各阶段结果；失败不会影响正式知识库。'
                      : '当前调试运行没有产出完整结果；以下内容来自上一次成功的隔离运行。'}
                  </p>
                </div>
                <div class="full-chain-card__heading-actions">
                  <span class="sandbox-badge">隔离运行</span>
                  <Button
                    variant="ghost"
                    icon="trash"
                    data-testid="discard-full-chain-sandbox"
                    disabled={props.running || props.discarding}
                    onClick={props.onDiscardSandbox}
                  >{props.discarding ? '正在丢弃…' : '丢弃 Sandbox'}</Button>
                </div>
              </div>
              <div class="full-chain-progress">
                <For each={result().steps}>{(step, index) => (
                  <div class={stepClass(step.state)}>
                    <span class="full-chain-step__marker">{stepMarker(step, index())}</span>
                    <strong>{step.label}</strong>
                    <p title={step.detail}>{step.detail}</p>
                  </div>
                )}</For>
              </div>
              <div class="full-chain-run-meta">
                <span>Run <code>{result().runId}</code></span>
                <span>Sandbox <code>{result().sandboxId}</code></span>
                <span>输入 {result().session.sourceDisplayName} · {sessionTitle(result().session)}</span>
                <span>扫描版本 <code>{result().session.revision.slice(0, 12)}</code></span>
                <Show when={result().baselineCreatedAt}><span>基线 {formatTime(result().baselineCreatedAt)}</span></Show>
                <Show when={result().completedAt}><span>完成 {formatTime(result().completedAt)}</span></Show>
                <Show when={result().durationMs !== undefined}><span>耗时 {((result().durationMs || 0) / 1_000).toFixed(1)} s</span></Show>
              </div>
            </section>

            <section class="full-chain-card" aria-label="Sandbox 输出">
              <div class="full-chain-card__heading">
                <div>
                  <h2>Sandbox 输出</h2>
                  <p>查看候选议程的最终裁决、Agent 的写入提交，以及本次隔离知识库的最终状态。</p>
                </div>
              </div>
              <div class="full-chain-output-switch" role="tablist" aria-label="输出类型">
                <button type="button" role="tab" aria-selected={output() === 'knowledge'} onClick={() => setOutput('knowledge')}>知识 Statements</button>
                <button type="button" role="tab" aria-selected={output() === 'candidates'} onClick={() => setOutput('candidates')}>Statement 候选</button>
                <button type="button" role="tab" aria-selected={output() === 'contributions'} onClick={() => setOutput('contributions')}>Agent Contributions</button>
              </div>

              <div
                class="full-chain-output-panel processing-tab-panel"
                role="tabpanel"
                hidden={output() !== 'candidates'}
              >
                <StatementCandidateList
                  candidates={result().statementCandidates}
                  emptyText="本次链路没有发现需要裁决的 Statement 候选。"
                />
              </div>

              <div
                class="full-chain-output-panel processing-tab-panel"
                role="tabpanel"
                hidden={output() !== 'contributions'}
              >
                <Show when={result().contributions.length} fallback={<div class="sandbox-knowledge__empty">Agent 尚未提交知识写入。</div>}>
                  <div class="full-chain-contributions">
                    <For each={result().contributions}>{(contribution, index) => (
                      <article class="full-chain-contribution">
                        <div><strong>Contribution {index() + 1}</strong><span>{formatTime(contribution.createdAt)}</span></div>
                        <pre>{contribution.content}</pre>
                      </article>
                    )}</For>
                  </div>
                </Show>
              </div>

              <div
                class="full-chain-output-panel processing-tab-panel"
                role="tabpanel"
                hidden={output() !== 'knowledge'}
              >
                <Show when={result().statements.length} fallback={<div class="sandbox-knowledge__empty">Sandbox 中尚未产生 Knowledge Statement。</div>}>
                  <div class="sandbox-knowledge">
                    <aside class="sandbox-knowledge__list" aria-label="Knowledge Statements">
                      <div class="sandbox-knowledge__list-header"><span>本次知识</span><strong>{result().statements.length}</strong></div>
                      <For each={result().statements}>{(statement) => (
                        <button
                          type="button"
                          class="sandbox-statement"
                          aria-selected={selectedStatement()?.title === statement.title}
                          onClick={() => setSelectedStatementTitle(statement.title)}
                        >
                          <strong>{statement.title}</strong>
                          <span>canonical title</span>
                        </button>
                      )}</For>
                    </aside>
                    <Show when={selectedStatement()} fallback={<div class="sandbox-knowledge__empty">选择一条 Statement 查看内容。</div>}>
                      {(statement) => (
                        <article class="sandbox-knowledge__detail">
                          <h3>{statement().title}</h3>
                          <div class="sandbox-knowledge__detail-meta">
                            <span>当前 Sandbox 正文</span>
                          </div>
                          <div class="sandbox-knowledge__content">{statement().content}</div>
                        </article>
                      )}
                    </Show>
                  </div>
                </Show>
              </div>
            </section>
            </>
          )}
        </Show>
      </section>
    </div>
  )
}

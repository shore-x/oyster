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
  providerLabel,
  reasoningLabel,
  selectedStageModel
} from '../processing-configuration'
import { Button, Icon } from '../ui'
import { ProcessingDebugTracePanel } from './ProcessingDebugTracePanel'
import { SessionMetadata, sessionOptionLabel } from './SessionMetadata'
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

export interface FullChainResultView {
  completedAt?: string
  durationMs?: number
  statementCandidates: StatementCandidateView[]
  debugTrace: KnowledgeProcessingDebugTrace
  steps: FullChainStepView[]
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

function stageSummary(stage?: ProcessingStageView, connection?: ProcessingConnectionView): {
  name: string
  detail: string
  runnable: boolean
} {
  if (!stage) return { name: '正在读取配置…', detail: '—', runnable: false }
  const model = selectedStageModel(stage, connection)
  const modelLabel = model && (model.displayName === model.id
    ? model.id
    : `${model.displayName} · ${model.id}`)
  const reasoningSupported = !stage.reasoningEffort
    || Boolean(model?.reasoningEfforts.includes(stage.reasoningEffort))
  return {
    name: stage.displayName,
    detail: connection && model
      ? `${connection.displayName} · ${backendLabel(connection.backendKind)} / ${providerLabel(connection.providerId)} · ${modelLabel} · ${reasoningLabel(stage.reasoningEffort)}`
      : '尚未完成模型配置',
    runnable: Boolean(connection && model && reasoningSupported && connectionCanAttemptRun(connection))
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

function progressText(
  progress: ObservationPreprocessingProgress | undefined,
  maintenanceRunning: boolean
): string {
  if (progress?.phase === 'preparing') return '正在准备对话材料…'
  if (progress?.phase === 'discovering') {
    return progress.totalSegments
      ? `正在发现知识候选 · ${progress.completedSegments} / ${progress.totalSegments}`
      : '正在发现知识候选…'
  }
  if (maintenanceRunning) return 'Knowledge Maintenance Agent 正在调查和维护知识…'
  return '正在启动链路测试…'
}

export function FullChainWorkspace(props: FullChainWorkspaceProps) {
  const [selectedStatementTitle, setSelectedStatementTitle] = createSignal<string>()
  const selectedSession = createMemo(() => props.sessions.find(
    (session) => session.artifactId === props.selectedSessionId
  ))
  const selectedStatement = createMemo(() => props.result?.statements.find(
    (statement) => statement.title === selectedStatementTitle()
  ) || props.result?.statements[0])
  const preprocessor = createMemo(() => stageSummary(props.preprocessor, props.preprocessorConnection))
  const maintainer = createMemo(() => stageSummary(props.maintainer, props.maintainerConnection))
  const disabledReason = createMemo(() => {
    if (props.locked) return '已有知识加工任务正在运行。'
    if (!selectedSession()) return '请选择一个 Session。'
    if (!preprocessor().runnable) return `${preprocessor().name} 尚未完成可用的模型配置。`
    if (!maintainer().runnable) return `${maintainer().name} 尚未完成可用的模型配置。`
    return undefined
  })
  const visibleDebugTrace = createMemo(() => props.debugTrace ?? props.result?.debugTrace)

  createEffect(() => {
    setSelectedStatementTitle(props.result?.statements[0]?.title)
  })

  return (
    <div class="chain-test" data-testid="full-chain-workspace">
      <div class="chain-test__boundary" data-testid="sandbox-boundary">
        <span class="sandbox-badge">Sandbox 链路测试</span>
        <p>使用当前知识库的隔离副本运行；测试产生的 Statement 不会写回知识库。</p>
      </div>

      <div class="chain-test__workspace">
        <section class="chain-test__setup" aria-label="链路测试输入">
          <div class="chain-test__section-heading">
            <div>
              <h2>运行设置</h2>
              <p>选择输入和关注点，然后启动两阶段测试。</p>
            </div>
          </div>

          <label class="ai-field ai-field--wide">
            <span>Session</span>
            <select
              data-testid="full-chain-session-select"
              value={props.selectedSessionId || ''}
              disabled={props.sessionsLoading || props.locked || props.sessions.length === 0}
              onChange={(event) => props.onSelectSession(event.currentTarget.value)}
            >
              <option value="">
                {props.sessionsLoading ? '正在读取 Session…' : props.sessions.length ? '选择一个 Session' : '暂无可用 Session'}
              </option>
              <For each={props.sessions}>{(session) => (
                <option value={session.artifactId}>{sessionOptionLabel(session)}</option>
              )}</For>
            </select>
          </label>

          <Show when={selectedSession()}>
            {(session) => (
              <SessionMetadata
                session={session()}
                class="chain-test__session"
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

          <div class="chain-test__models" aria-label="链路模型配置">
            <div><span>预处理</span><strong>{preprocessor().detail}</strong></div>
            <div><span>知识维护</span><strong>{maintainer().detail}</strong></div>
            <p>模型与提示词可在“高级调试”中查看和修改。</p>
          </div>

          <div class="chain-test__actions">
            <p data-testid="full-chain-disabled-reason">
              {props.running
                ? progressText(props.preprocessingProgress, props.maintenanceRunning)
                : disabledReason() || '输入和模型已经准备完成。'}
            </p>
            <Show
              when={props.running}
              fallback={(
                <Button
                  variant="primary"
                  size="wide"
                  icon="play"
                  data-testid="run-full-chain"
                  disabled={Boolean(disabledReason())}
                  onClick={props.onRun}
                >运行链路测试</Button>
              )}
            >
              <Button variant="danger" size="wide" icon="stop" onClick={props.onCancel}>停止测试</Button>
            </Show>
          </div>
        </section>

        <section class="chain-test__activity" aria-label="链路测试过程">
          <div class="chain-test__section-heading">
            <div>
              <h2>运行过程</h2>
              <p>查看阶段进度、模型调用和 Agent 工具活动。</p>
            </div>
            <Show when={visibleDebugTrace()}>
              {(trace) => <span class={`chain-test__status chain-test__status--${trace().status}`}>{trace().status === 'running' ? '运行中' : trace().status === 'completed' ? '已完成' : trace().status === 'cancelled' ? '已取消' : '失败'}</span>}
            </Show>
          </div>
          <Show
            when={visibleDebugTrace()}
            fallback={<div class="chain-test__empty">运行开始后，这里会显示两个阶段的实时进度。</div>}
          >
            {(trace) => <ProcessingDebugTracePanel trace={trace()} title="链路活动" />}
          </Show>
        </section>
      </div>

      <Show when={!props.running && props.result ? props.result : undefined}>
        {(result) => (
          <section class="chain-test__result" data-testid="full-chain-run-result" aria-label="Sandbox 测试结果">
            <div class="chain-test__result-heading">
              <div>
                <h2>Sandbox 结果</h2>
                <p>这是本次测试生成的隔离知识，不代表当前知识库。</p>
              </div>
              <div>
                <span>{result().completedAt ? `完成于 ${formatTime(result().completedAt)}` : ''}</span>
                <Button
                  variant="ghost"
                  icon="trash"
                  data-testid="discard-full-chain-sandbox"
                  disabled={props.discarding}
                  onClick={props.onDiscardSandbox}
                >{props.discarding ? '正在丢弃…' : '丢弃结果'}</Button>
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

            <div class="chain-test__knowledge">
              <aside aria-label="Sandbox Knowledge Statements">
                <div><span>生成的 Statements</span><strong>{result().statements.length}</strong></div>
                <Show
                  when={result().statements.length}
                  fallback={<p>本次测试没有生成 Knowledge Statement。</p>}
                >
                  <For each={result().statements}>{(statement) => (
                    <button
                      type="button"
                      aria-selected={selectedStatement()?.title === statement.title}
                      onClick={() => setSelectedStatementTitle(statement.title)}
                    >{statement.title}</button>
                  )}</For>
                </Show>
              </aside>
              <div>
                <Show
                  when={selectedStatement()}
                  fallback={<div class="chain-test__empty">选择一条 Statement 查看内容。</div>}
                >
                  {(statement) => (
                    <article>
                      <h3>{statement().title}</h3>
                      <div>{statement().content}</div>
                    </article>
                  )}
                </Show>
              </div>
            </div>

            <details class="chain-test__candidates">
              <summary>查看候选裁决（{result().statementCandidates.length}）</summary>
              <StatementCandidateList
                candidates={result().statementCandidates}
                emptyText="本次测试没有发现需要裁决的 Statement 候选。"
              />
            </details>
          </section>
        )}
      </Show>
    </div>
  )
}

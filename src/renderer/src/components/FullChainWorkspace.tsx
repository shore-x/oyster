import { For, Show, createEffect, createMemo, createSignal } from 'solid-js'
import type { AvailableSessionSummary } from '../../../shared/discovery'
import type { LlmBinding } from '../../../shared/ai-backends'
import type { KnowledgeStatement } from '../../../shared/knowledge'
import type {
  ProcessingRunView,
  KnowledgeProcessingDebugTrace,
  ProcessingConnectionView,
  ProcessingStageView
} from '../../../shared/knowledge-processing'
import {
  backendLabel,
  connectionCanAttemptRun,
  providerLabel,
  reasoningLabel,
  selectedLlmModel
} from '../processing-configuration'
import { processingAgentDisplayName } from '../processing-agent-presentation'
import { Button } from '../ui'
import { FullChainActivityDetail, FullChainResultDetail } from './FullChainRunDetails'
import { SessionMetadata } from './SessionMetadata'
import { SessionPicker } from './SessionPicker'

export type FullChainStepState = 'pending' | 'running' | 'completed' | 'failed'

export interface FullChainStepView {
  id: string
  label: string
  detail: string
  state: FullChainStepState
}

export interface FullChainResultView {
  runId: string
  completedAt?: string
  durationMs?: number
  run: ProcessingRunView
  approvedRevision: string
  changedPaths: string[]
  artifactPaths: string[]
  maintenanceRunCount: number
  reviewRunCount: number
  steps: FullChainStepView[]
  statements: KnowledgeStatement[]
}

export interface FullChainWorkspaceProps {
  sessions: AvailableSessionSummary[]
  sessionsLoading: boolean
  sessionCatalogError?: string
  selectedSession?: AvailableSessionSummary
  attention: string
  maintainer?: ProcessingStageView
  reviewer?: ProcessingStageView
  defaultLlm?: LlmBinding
  maintainerConnection?: ProcessingConnectionView
  reviewerConnection?: ProcessingConnectionView
  running: boolean
  debugTraces: KnowledgeProcessingDebugTrace[]
  locked: boolean
  result?: FullChainResultView
  onSelectSession(session?: AvailableSessionSummary): void
  onRefreshSessions(): void
  onAttentionInput(value: string): void
  onRun(): void
  onCancel(): void
}

function formatTime(value?: string): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN')
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs} ms`
  return `${(durationMs / 1_000).toFixed(1)} s`
}

function stageSummary(
  stage?: ProcessingStageView,
  binding?: LlmBinding,
  connection?: ProcessingConnectionView
): {
  name: string
  detail: string
  runnable: boolean
} {
  if (!stage) return { name: '正在读取配置…', detail: '—', runnable: false }
  const model = selectedLlmModel(binding, connection)
  const modelLabel = model && (model.displayName === model.id
    ? model.id
    : `${model.displayName} · ${model.id}`)
  const reasoningSupported = !binding?.reasoningEffort
    || Boolean(model?.reasoningEfforts.includes(binding.reasoningEffort))
  return {
    name: stage.displayName,
    detail: connection && model
      ? `${connection.displayName} · ${backendLabel(connection.backendKind)} / ${providerLabel(connection.providerId)} · ${modelLabel} · ${reasoningLabel(binding?.reasoningEffort)}`
      : '尚未配置默认 LLM',
    runnable: Boolean(connection && model && reasoningSupported && connectionCanAttemptRun(connection))
  }
}

export function FullChainWorkspace(props: FullChainWorkspaceProps) {
  const [page, setPage] = createSignal<'overview' | 'activity' | 'result'>('overview')
  const selectedSession = () => props.selectedSession
  const maintainer = createMemo(() => stageSummary(
    props.maintainer,
    props.defaultLlm,
    props.maintainerConnection
  ))
  const reviewer = createMemo(() => stageSummary(
    props.reviewer,
    props.defaultLlm,
    props.reviewerConnection
  ))
  const disabledReason = createMemo(() => {
    if (props.locked) return '已有知识加工任务正在运行。'
    if (props.sessionsLoading) return '正在刷新本机 Session。'
    if (!selectedSession()) return '请选择一个 Session。'
    if (!maintainer().runnable) return `${maintainer().name} 尚未完成可用的模型配置。`
    if (!reviewer().runnable) return `${reviewer().name} 尚未完成可用的模型配置。`
    return undefined
  })
  const visibleDebugTraces = createMemo(() => props.debugTraces)
  const visibleRuns = createMemo(() => visibleDebugTraces().map((trace) => trace.run))
  const currentDebugTrace = createMemo(() => {
    const traces = visibleDebugTraces()
    return [...traces].reverse().find((trace) => trace.run.status === 'running')
      ?? traces[traces.length - 1]
  })
  const traceStatus = createMemo(() => props.running ? 'running' : currentDebugTrace()?.run.status)
  const modelCallCount = createMemo(() => visibleRuns().reduce(
    (total, run) => total + run.modelCalls.length,
    0
  ))
  const toolCallCount = createMemo(() => visibleRuns().reduce(
    (total, run) => total + run.toolCalls.length,
    0
  ))

  createEffect(() => {
    if (page() === 'result' && !props.result) setPage('overview')
  })

  return (
    <div class="chain-test" data-testid="full-chain-workspace">
      <div class="chain-test__boundary" data-testid="git-collaboration-boundary">
        <span class="git-collaboration-badge">Git 协作测试</span>
        <p>Harness 在统一 Repository 中创建 Run 与真实处理分支；Maintainer 和 Reviewer 共用 WORK.md，最终结果不会合并到目标分支。</p>
      </div>

      <Show when={page() === 'overview'}>
        <div class="chain-test__workspace">
          <section class="chain-test__setup" aria-label="链路测试输入">
            <div class="chain-test__section-heading">
              <div>
                <h2>运行设置</h2>
                <p>选择输入和关注点，然后启动知识维护测试。</p>
              </div>
            </div>

            <SessionPicker
              sessions={props.sessions}
              selected={props.selectedSession}
              loading={props.sessionsLoading}
              disabled={props.locked}
              label="Session"
              selectTestId="full-chain-session-select"
              refreshTestId="refresh-full-chain-sessions"
              error={props.sessionCatalogError}
              onSelect={props.onSelectSession}
              onRefresh={props.onRefreshSessions}
            />

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
              <div><span>Maintainer</span><strong>{maintainer().detail}</strong></div>
              <div><span>Reviewer</span><strong>{reviewer().detail}</strong></div>
              <p>模型在“AI 后端”中统一配置；提示词可在“高级调试”中修改。</p>
            </div>

            <div class="chain-test__actions">
              <p data-testid="full-chain-disabled-reason">
                {props.running
                  ? 'Maintainer 与 Reviewer 正在当前 Run 中工作…'
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
                <h2>运行概览</h2>
                <p>主页面只保留阶段状态；逐次调用在运行详情中查看。</p>
              </div>
              <Show when={traceStatus()}>
                {(status) => <span class={`chain-test__status chain-test__status--${status()}`}>{status() === 'running' ? '运行中' : status() === 'completed' ? '已完成' : status() === 'cancelled' ? '已取消' : '失败'}</span>}
              </Show>
            </div>
            <Show
              when={currentDebugTrace()}
              fallback={<div class="chain-test__empty">运行开始后，这里会显示当前 Agent 的实时进度。</div>}
            >
              {(trace) => (
                <>
                  <div class="chain-test__activity-summary" data-testid="full-chain-activity-summary">
                    <div>
                      <span class="processing-debug__marker" aria-hidden="true" />
                      <div>
                        <strong>{processingAgentDisplayName(trace().run.agentId)}</strong>
                        <p>{`${visibleRuns().length} Agent Runs · ${modelCallCount()} 次模型 · ${toolCallCount()} 次工具`}</p>
                      </div>
                    </div>
                  </div>
                  <Show when={trace().run.error}>{(error) => <p class="processing-debug__error">{error()}</p>}</Show>
                  <div class="chain-test__activity-actions">
                    <Button
                      variant="secondary"
                      icon="link"
                      data-testid="open-full-chain-activity"
                      onClick={() => setPage('activity')}
                    >查看运行详情</Button>
                  </div>
                </>
              )}
            </Show>
          </section>
        </div>

        <Show when={!props.running && props.result ? props.result : undefined}>
          {(result) => (
            <section class="chain-test__result-summary" data-testid="full-chain-run-result" aria-label="Git 协作测试结果概览">
              <div class="chain-test__result-heading">
                <div>
                  <h2>Reviewer 已批准</h2>
                  <p>结果保留在协作分支中，工作清单已删除，目标分支未被修改。</p>
                </div>
                <span>{result().completedAt ? `完成于 ${formatTime(result().completedAt)}` : ''}</span>
              </div>
              <div class="chain-test__result-metrics">
                <div><strong data-testid="full-chain-result-statement-count">{result().statements.length}</strong><span>Statements</span></div>
                <div><strong>{result().maintenanceRunCount} / {result().reviewRunCount}</strong><span>Maintainer / Reviewer</span></div>
                <div><strong>{result().changedPaths.length}</strong><span>变更文件</span></div>
                <div><strong>{result().durationMs === undefined ? '—' : formatDuration(result().durationMs!)}</strong><span>耗时</span></div>
              </div>
              <Show when={result().statements.length}>
                <div class="chain-test__result-titles">
                  <For each={result().statements.slice(0, 5)}>{(statement) => <span>{statement.title}</span>}</For>
                  <Show when={result().statements.length > 5}><span>+{result().statements.length - 5}</span></Show>
                </div>
              </Show>
              <div class="chain-test__result-actions">
                <Button
                  variant="primary"
                  icon="layers"
                  data-testid="open-full-chain-result"
                  onClick={() => setPage('result')}
                >查看结果详情</Button>
              </div>
            </section>
          )}
        </Show>
      </Show>

      <Show when={page() === 'activity'}>
        <FullChainActivityDetail
          runs={visibleRuns()}
          followLatestRun
          backLabel="返回概览"
          detailTestId="full-chain-activity-detail"
          backTestId="full-chain-detail-back"
          onBack={() => setPage('overview')}
        />
      </Show>

      <Show when={page() === 'result' && props.result ? props.result : undefined}>
        {(result) => <FullChainResultDetail
          result={result()}
          backLabel="返回概览"
          detailTestId="full-chain-result-detail"
          backTestId="full-chain-result-back"
          onBack={() => setPage('overview')}
        />}
      </Show>
    </div>
  )
}

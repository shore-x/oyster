import { For, Show, createEffect, createMemo, createSignal } from 'solid-js'
import type { AvailableSessionSummary } from '../../../shared/discovery'
import type { LlmBinding } from '../../../shared/ai-backends'
import type { KnowledgeStatement } from '../../../shared/knowledge'
import type {
  CollaborationWorkspaceView,
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
import { Button } from '../ui'
import { FullChainActivityDetail, FullChainResultDetail } from './FullChainRunDetails'
import { SessionMetadata, sessionOptionLabel } from './SessionMetadata'

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
  workspace: CollaborationWorkspaceView
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
  selectedSessionId?: string
  attention: string
  maintainer?: ProcessingStageView
  reviewer?: ProcessingStageView
  defaultLlm?: LlmBinding
  maintainerConnection?: ProcessingConnectionView
  reviewerConnection?: ProcessingConnectionView
  running: boolean
  debugTrace?: KnowledgeProcessingDebugTrace
  locked: boolean
  result?: FullChainResultView
  onSelectSession(id: string): void
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
  const selectedSession = createMemo(() => props.sessions.find(
    (session) => session.sourceRecordId === props.selectedSessionId
  ))
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
    if (!selectedSession()) return '请选择一个 Session。'
    if (!maintainer().runnable) return `${maintainer().name} 尚未完成可用的模型配置。`
    if (!reviewer().runnable) return `${reviewer().name} 尚未完成可用的模型配置。`
    return undefined
  })
  const visibleDebugTrace = createMemo(() => props.debugTrace)

  createEffect(() => {
    if (page() === 'result' && !props.result) setPage('overview')
  })

  return (
    <div class="chain-test" data-testid="full-chain-workspace">
      <div class="chain-test__boundary" data-testid="git-collaboration-boundary">
        <span class="git-collaboration-badge">Git 协作测试</span>
        <p>Harness 创建真实分支与 worktree；Maintainer 和 Reviewer 交替提交，最终结果不会合并到目标分支。</p>
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
                  <option value={session.sourceRecordId}>{sessionOptionLabel(session)}</option>
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
              <div><span>Maintainer</span><strong>{maintainer().detail}</strong></div>
              <div><span>Reviewer</span><strong>{reviewer().detail}</strong></div>
              <p>模型在“AI 后端”中统一配置；提示词可在“高级调试”中修改。</p>
            </div>

            <div class="chain-test__actions">
              <p data-testid="full-chain-disabled-reason">
                {props.running
                  ? 'Maintainer 与 Reviewer 正在协作分支中工作…'
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
              <Show when={visibleDebugTrace()}>
                {(trace) => <span class={`chain-test__status chain-test__status--${trace().run.status}`}>{trace().run.status === 'running' ? '运行中' : trace().run.status === 'completed' ? '已完成' : trace().run.status === 'cancelled' ? '已取消' : '失败'}</span>}
              </Show>
            </div>
            <Show
              when={visibleDebugTrace()}
              fallback={<div class="chain-test__empty">运行开始后，这里会显示当前 Agent 的实时进度。</div>}
            >
              {(trace) => (
                <>
                  <div class="chain-test__activity-summary" data-testid="full-chain-activity-summary">
                    <div>
                      <span class="processing-debug__marker" aria-hidden="true" />
                      <div><strong>Git 协作</strong><p>{`${trace().run.modelCalls.length} 次模型 · ${trace().run.toolCalls.length} 次工具`}</p></div>
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
          trace={visibleDebugTrace()}
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

import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js'
import type { SourceConversationSummary } from '../../../shared/discovery'
import type { LlmBinding } from '../../../shared/ai-backends'
import type { KnowledgeStatement } from '../../../shared/knowledge'
import type {
  KnowledgeTaskWorkspaceView,
  LiveAgentInvocationView,
  AiConnectionView,
  KnowledgeAgentDefinitionView
} from '../../../shared/knowledge-processing'
import {
  backendLabel,
  connectionCanInvokeAgent,
  providerLabel,
  reasoningLabel,
  selectedLlmModel
} from '../processing-configuration'
import { processingAgentDisplayName } from '../processing-agent-presentation'
import { Button, Icon } from '../ui'
import {
  KnowledgeTaskActivityDetail,
  KnowledgeTaskResultDetail
} from './KnowledgeTaskDetails'
import { SourceConversationMetadata } from './SourceConversationMetadata'
import { SourceConversationPicker } from './SourceConversationPicker'

export type UiMilestoneState = 'pending' | 'in_progress' | 'completed' | 'failed'

export interface UiMilestoneView {
  id: string
  label: string
  detail: string
  state: UiMilestoneState
}

export interface KnowledgeTaskResultView {
  taskId: string
  completedAt?: string
  durationMs?: number
  workspace: KnowledgeTaskWorkspaceView
  approvedRepositoryRevision: string
  changedPaths: string[]
  artifactPaths: string[]
  roundCount: number
  milestones: UiMilestoneView[]
  statements: KnowledgeStatement[]
}

export interface KnowledgeTaskWorkspaceProps {
  sourceConversations: SourceConversationSummary[]
  sourceConversationsLoading: boolean
  sourceConversationCatalogError?: string
  selectedSourceConversation?: SourceConversationSummary
  attention: string
  maintainer?: KnowledgeAgentDefinitionView
  reviewer?: KnowledgeAgentDefinitionView
  defaultLlm?: LlmBinding
  maintainerConnection?: AiConnectionView
  reviewerConnection?: AiConnectionView
  active: boolean
  liveInvocations: LiveAgentInvocationView[]
  locked: boolean
  result?: KnowledgeTaskResultView
  onSelectSourceConversation(conversation?: SourceConversationSummary): void
  onRefreshSourceConversations(): void
  onAttentionInput(value: string): void
  onStart(): void
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

function agentSummary(
  agent?: KnowledgeAgentDefinitionView,
  binding?: LlmBinding,
  connection?: AiConnectionView
): {
  name: string
  detail: string
  runnable: boolean
} {
  if (!agent) return { name: '正在读取配置…', detail: '—', runnable: false }
  const model = selectedLlmModel(binding, connection)
  const modelLabel = model && (model.displayName === model.id
    ? model.id
    : `${model.displayName} · ${model.id}`)
  const reasoningSupported = !binding?.reasoningEffort
    || Boolean(model?.reasoningEfforts.includes(binding.reasoningEffort))
  return {
    name: agent.displayName,
    detail: connection && model
      ? `${connection.displayName} · ${backendLabel(connection.backendKind)} / ${providerLabel(connection.providerId)} · ${modelLabel} · ${reasoningLabel(binding?.reasoningEffort)}`
      : '尚未配置默认 LLM',
    runnable: Boolean(connection && model && reasoningSupported && connectionCanInvokeAgent(connection))
  }
}

export function KnowledgeTaskWorkspace(props: KnowledgeTaskWorkspaceProps) {
  const [detail, setDetail] = createSignal<'activity' | 'result'>()
  const selectedSourceConversation = () => props.selectedSourceConversation
  const maintainer = createMemo(() => agentSummary(
    props.maintainer,
    props.defaultLlm,
    props.maintainerConnection
  ))
  const reviewer = createMemo(() => agentSummary(
    props.reviewer,
    props.defaultLlm,
    props.reviewerConnection
  ))
  const disabledReason = createMemo(() => {
    if (props.locked) return '已有 Knowledge Processing Task 处于进行中。'
    if (props.sourceConversationsLoading) return '正在刷新 Source Conversations。'
    if (!selectedSourceConversation()) return '请选择一个 Source Conversation。'
    if (!maintainer().runnable) return `${maintainer().name} 尚未完成可用的模型配置。`
    if (!reviewer().runnable) return `${reviewer().name} 尚未完成可用的模型配置。`
    return undefined
  })
  const visibleInvocationViews = createMemo(() => props.liveInvocations)
  const visibleInvocations = createMemo(() => visibleInvocationViews().map(
    (view) => view.invocation
  ))
  const currentInvocationView = createMemo(() => {
    const views = visibleInvocationViews()
    return [...views].reverse().find((view) => view.invocation.status === 'in_progress')
      ?? views[views.length - 1]
  })
  const invocationStatus = createMemo(() => (
    props.active ? 'in_progress' : currentInvocationView()?.invocation.status
  ))
  const modelCallCount = createMemo(() => visibleInvocations().reduce(
    (total, invocation) => total + invocation.modelCalls.length,
    0
  ))
  const toolCallCount = createMemo(() => visibleInvocations().reduce(
    (total, invocation) => total + invocation.toolCalls.length,
    0
  ))

  createEffect(() => {
    if (detail() === 'result' && !props.result) setDetail(undefined)
  })

  createEffect(() => {
    if (!detail()) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setDetail(undefined)
    }
    document.addEventListener('keydown', closeOnEscape)
    onCleanup(() => document.removeEventListener('keydown', closeOnEscape))
  })

  return (
    <div class="knowledge-task" data-testid="knowledge-task-workspace">
      <div class="knowledge-task__boundary" data-testid="git-collaboration-boundary">
        <span class="git-collaboration-badge">Git 协作测试</span>
        <p>Host 在统一 Repository 中创建 Knowledge Processing Task 与真实 Task branch；Maintainer 和 Reviewer 共用 PROGRESS.md，最终结果不会合并到目标分支。</p>
      </div>

        <div class="knowledge-task__workspace">
          <section class="knowledge-task__setup" aria-label="Knowledge Processing Task 输入">
            <div class="knowledge-task__section-heading">
              <div>
                <h2>Task 设置</h2>
                <p>选择 Source Snapshot 和关注点，然后启动 Knowledge Processing Task。</p>
              </div>
            </div>

            <SourceConversationPicker
              conversations={props.sourceConversations}
              selected={props.selectedSourceConversation}
              loading={props.sourceConversationsLoading}
              disabled={props.locked}
              label="Source Conversation"
              selectTestId="knowledge-task-source-conversation-select"
              refreshTestId="refresh-knowledge-task-source-conversations"
              error={props.sourceConversationCatalogError}
              onSelect={props.onSelectSourceConversation}
              onRefresh={props.onRefreshSourceConversations}
            />

            <Show when={selectedSourceConversation()}>
              {(conversation) => (
                <SourceConversationMetadata
                  conversation={conversation()}
                  class="knowledge-task__source-snapshot"
                  testId="knowledge-task-source-conversation-meta"
                />
              )}
            </Show>

            <label class="ai-field ai-field--wide">
              <span>Attention（可选）</span>
              <input
                data-testid="knowledge-task-attention-input"
                value={props.attention}
                disabled={props.locked}
                placeholder="例如：重点关注用户明确否定过的设计选择"
                onInput={(event) => props.onAttentionInput(event.currentTarget.value)}
              />
            </label>

            <div class="knowledge-task__models" aria-label="Knowledge Agent 配置">
              <div><span>Maintainer</span><strong>{maintainer().detail}</strong></div>
              <div><span>Reviewer</span><strong>{reviewer().detail}</strong></div>
              <p>模型在“设置 / AI 后端”中统一配置；提示词可在“高级调试”中修改。</p>
            </div>

            <div class="knowledge-task__actions">
              <p data-testid="knowledge-task-disabled-reason">
                {props.active
                  ? 'Maintainer 与 Reviewer 正在当前 Knowledge Processing Task 中工作…'
                  : disabledReason() || '输入和模型已经准备完成。'}
              </p>
              <Show
                when={props.active}
                fallback={(
                  <Button
                    variant="primary"
                    size="wide"
                    icon="play"
                    data-testid="start-knowledge-task"
                    disabled={Boolean(disabledReason())}
                    onClick={props.onStart}
                  >启动 Knowledge Task</Button>
                )}
              >
                <Button variant="danger" size="wide" icon="stop" onClick={props.onCancel}>停止测试</Button>
              </Show>
            </div>
          </section>

          <section class="knowledge-task__activity" aria-label="Knowledge Processing Task 进度">
            <div class="knowledge-task__section-heading">
              <div>
                <h2>Task 概览</h2>
                <p>主页面只保留当前 Invocation 状态；完整活动在 Agent Invocation 详情中查看。</p>
              </div>
              <Show when={invocationStatus()}>
                {(status) => <span class={`knowledge-task__status knowledge-task__status--${status()}`}>{status() === 'in_progress' ? '进行中' : status() === 'completed' ? '已完成' : status() === 'cancelled' ? '已取消' : '失败'}</span>}
              </Show>
            </div>
            <Show
              when={currentInvocationView()}
              fallback={<div class="knowledge-task__empty">Task 启动后，这里会显示当前 Agent Invocation 的实时进度。</div>}
            >
              {(view) => (
                <>
                  <div class="knowledge-task__activity-summary" data-testid="knowledge-task-activity-summary">
                    <div>
                      <span class="agent-activity__marker" aria-hidden="true" />
                      <div>
                        <strong>{processingAgentDisplayName(view().invocation.agentId)}</strong>
                        <p>{`${visibleInvocations().length} Agent Invocations · ${modelCallCount()} 次模型 · ${toolCallCount()} 次工具`}</p>
                      </div>
                    </div>
                  </div>
                  <Show when={view().invocation.error}>{(error) => <p class="agent-invocation-panel__error">{error()}</p>}</Show>
                  <div class="knowledge-task__activity-actions">
                    <Button
                      variant="secondary"
                      icon="link"
                      data-testid="open-knowledge-task-activity"
                      onClick={() => setDetail('activity')}
                    >查看 Agent Invocation</Button>
                  </div>
                </>
              )}
            </Show>
          </section>
        </div>

        <Show when={!props.active && props.result ? props.result : undefined}>
          {(result) => (
            <section class="knowledge-task__result-summary" data-testid="knowledge-task-result" aria-label="Git 协作测试结果概览">
              <div class="knowledge-task__result-heading">
                <div>
                  <h2>Reviewer 已批准</h2>
                  <p>结果保留在 Task branch 中，PROGRESS.md 与 handoff 已保留，目标分支未被修改。</p>
                </div>
                <span>{result().completedAt ? `完成于 ${formatTime(result().completedAt)}` : ''}</span>
              </div>
              <div class="knowledge-task__result-metrics">
                <div><strong data-testid="knowledge-task-result-statement-count">{result().statements.length}</strong><span>Statements</span></div>
                <div><strong>{result().roundCount}</strong><span>Collaboration Rounds</span></div>
                <div><strong>{result().changedPaths.length}</strong><span>变更文件</span></div>
                <div><strong>{result().durationMs === undefined ? '—' : formatDuration(result().durationMs!)}</strong><span>耗时</span></div>
              </div>
              <Show when={result().statements.length}>
                <div class="knowledge-task__result-titles">
                  <For each={result().statements.slice(0, 5)}>{(statement) => <span>{statement.title}</span>}</For>
                  <Show when={result().statements.length > 5}><span>+{result().statements.length - 5}</span></Show>
                </div>
              </Show>
              <div class="knowledge-task__result-actions">
                <Button
                  variant="primary"
                  icon="layers"
                  data-testid="open-knowledge-task-result"
                  onClick={() => setDetail('result')}
                >查看结果详情</Button>
              </div>
            </section>
          )}
        </Show>

      <Show when={detail()}>{(currentDetail) => (
        <aside class="knowledge-task__inspector" role="complementary" aria-label="Knowledge Task 详情">
          <div class="processing-history__inspector-toolbar">
            <strong>{currentDetail() === 'activity' ? 'Agent Invocation 详情' : 'Task 结果'}</strong>
            <button
              type="button"
              data-testid={currentDetail() === 'activity' ? 'knowledge-task-detail-back' : 'knowledge-task-result-back'}
              aria-label="关闭 Knowledge Task 详情"
              onClick={() => setDetail(undefined)}
            ><Icon name="close" /><span>关闭</span></button>
          </div>
          <div class="knowledge-task__inspector-content">
            <Show when={currentDetail() === 'activity'}>
              <KnowledgeTaskActivityDetail
                invocations={visibleInvocations()}
                followLatestInvocation
                detailTestId="knowledge-task-activity-detail"
              />
            </Show>
            <Show when={currentDetail() === 'result' && props.result ? props.result : undefined}>
              {(result) => <KnowledgeTaskResultDetail
                result={result()}
                detailTestId="knowledge-task-result-detail"
              />}
            </Show>
          </div>
        </aside>
      )}
      </Show>
    </div>
  )
}

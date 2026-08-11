import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js'
import type { SourceConversationSummary } from '../../../shared/discovery'
import type { LlmBinding } from '../../../shared/ai-backends'
import type { KnowledgeStatement } from '../../../shared/knowledge'
import type {
  KnowledgeTaskWorktreeView,
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
import { appLanguage, uiText } from '../i18n'

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
  worktree: KnowledgeTaskWorktreeView
  approvedRepositoryRevision: string
  changedPaths: string[]
  artifactPaths: string[]
  roundCount: number
  milestones: UiMilestoneView[]
  statements: KnowledgeStatement[]
}

export interface KnowledgeTaskWorktreeProps {
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
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(appLanguage())
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
  if (!agent) return { name: uiText('正在读取配置…', 'Reading configuration…'), detail: '—', runnable: false }
  const model = selectedLlmModel(binding, connection)
  const modelLabel = model && (model.displayName === model.id
    ? model.id
    : `${model.displayName} · ${model.id}`)
  const reasoningSupported = !binding?.reasoningEffort
    || Boolean(model?.reasoningEfforts.includes(binding.reasoningEffort))
  return {
    name: agent.id === 'knowledge_maintainer'
      ? uiText('知识维护 Agent', 'Knowledge Maintainer')
      : uiText('知识审阅 Agent', 'Knowledge Reviewer'),
    detail: connection && model
      ? `${connection.displayName} · ${backendLabel(connection.backendKind)} / ${providerLabel(connection.providerId)} · ${modelLabel} · ${reasoningLabel(binding?.reasoningEffort)}`
      : uiText('尚未配置默认 LLM', 'Default LLM not configured'),
    runnable: Boolean(connection && model && reasoningSupported && connectionCanInvokeAgent(connection))
  }
}

export function KnowledgeTaskWorktree(props: KnowledgeTaskWorktreeProps) {
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
    if (props.locked) return uiText('已有 Knowledge Processing Task 处于进行中。', 'A Knowledge Processing Task is already in progress.')
    if (props.sourceConversationsLoading) return uiText('正在刷新 Source Conversations。', 'Refreshing Source Conversations.')
    if (!selectedSourceConversation()) return uiText('请选择一个 Source Conversation。', 'Select a Source Conversation.')
    if (!maintainer().runnable) return `${maintainer().name} ${uiText('尚未完成可用的模型配置。', 'does not have a usable model configuration.')}`
    if (!reviewer().runnable) return `${reviewer().name} ${uiText('尚未完成可用的模型配置。', 'does not have a usable model configuration.')}`
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
    <div class="knowledge-task" data-testid="knowledge-task-worktree">
      <div class="knowledge-task__boundary" data-testid="git-collaboration-boundary">
        <span class="git-collaboration-badge">{uiText('Git 协作测试', 'Git Collaboration Test')}</span>
        <p>{uiText(
          'Host 在统一 Repository 中创建 Knowledge Processing Task 与真实 Task branch；Maintainer 和 Reviewer 共用 PROGRESS.md，最终结果不会合并到目标分支。',
          'The Host creates a Knowledge Processing Task and real Task branch in the unified Repository. Maintainer and Reviewer share PROGRESS.md, and the final result is not merged into the target branch.'
        )}</p>
      </div>

        <div class="knowledge-task__worktree">
          <section class="knowledge-task__setup" aria-label={uiText('Knowledge Processing Task 输入', 'Knowledge Processing Task input')}>
            <div class="knowledge-task__section-heading">
              <div>
                <h2>{uiText('Task 设置', 'Task Setup')}</h2>
                <p>{uiText('选择 Source Snapshot 和关注点，然后启动 Knowledge Processing Task。', 'Select a Source Snapshot and focus, then start the Knowledge Processing Task.')}</p>
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
              <span>{uiText('Attention（可选）', 'Attention (Optional)')}</span>
              <input
                data-testid="knowledge-task-attention-input"
                value={props.attention}
                disabled={props.locked}
                placeholder={uiText('例如：重点关注用户明确否定过的设计选择', 'For example: focus on design choices the user explicitly rejected')}
                onInput={(event) => props.onAttentionInput(event.currentTarget.value)}
              />
            </label>

            <div class="knowledge-task__models" aria-label={uiText('Knowledge Agent 配置', 'Knowledge Agent configuration')}>
              <div><span>Maintainer</span><strong>{maintainer().detail}</strong></div>
              <div><span>Reviewer</span><strong>{reviewer().detail}</strong></div>
              <p>{uiText('模型在“设置 / AI 后端”中统一配置；提示词可在“高级调试”中修改。', 'Models are configured under Settings / AI Backends; Prompts can be changed under Advanced Debugging.')}</p>
            </div>

            <div class="knowledge-task__actions">
              <p data-testid="knowledge-task-disabled-reason">
                {props.active
                  ? uiText('Maintainer 与 Reviewer 正在当前 Knowledge Processing Task 中工作…', 'Maintainer and Reviewer are working in the current Knowledge Processing Task…')
                  : disabledReason() || uiText('输入和模型已经准备完成。', 'Input and models are ready.')}
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
                  >{uiText('启动 Knowledge Task', 'Start Knowledge Task')}</Button>
                )}
              >
                <Button variant="danger" size="wide" icon="stop" onClick={props.onCancel}>{uiText('停止测试', 'Stop Test')}</Button>
              </Show>
            </div>
          </section>

          <section class="knowledge-task__activity" aria-label={uiText('Knowledge Processing Task 进度', 'Knowledge Processing Task progress')}>
            <div class="knowledge-task__section-heading">
              <div>
                <h2>{uiText('Task 概览', 'Task Overview')}</h2>
                <p>{uiText('主页面只保留当前 Invocation 状态；完整活动在 Agent Invocation 详情中查看。', 'The main page keeps only the current Invocation status; view complete activity in Agent Invocation details.')}</p>
              </div>
              <Show when={invocationStatus()}>
                {(status) => <span class={`knowledge-task__status knowledge-task__status--${status()}`}>{status() === 'in_progress' ? uiText('进行中', 'In progress') : status() === 'completed' ? uiText('已完成', 'Completed') : status() === 'cancelled' ? uiText('已取消', 'Cancelled') : uiText('失败', 'Failed')}</span>}
              </Show>
            </div>
            <Show
              when={currentInvocationView()}
              fallback={<div class="knowledge-task__empty">{uiText('Task 启动后，这里会显示当前 Agent Invocation 的实时进度。', 'Live progress for the current Agent Invocation appears here after the Task starts.')}</div>}
            >
              {(view) => (
                <>
                  <div class="knowledge-task__activity-summary" data-testid="knowledge-task-activity-summary">
                    <div>
                      <span class="agent-activity__marker" aria-hidden="true" />
                      <div>
                        <strong>{processingAgentDisplayName(view().invocation.agentId)}</strong>
                        <p>{`${visibleInvocations().length} Agent Invocations · ${modelCallCount()} ${uiText('次模型', 'model calls')} · ${toolCallCount()} ${uiText('次工具', 'tool calls')}`}</p>
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
                    >{uiText('查看 Agent Invocation', 'View Agent Invocation')}</Button>
                  </div>
                </>
              )}
            </Show>
          </section>
        </div>

        <Show when={!props.active && props.result ? props.result : undefined}>
          {(result) => (
            <section class="knowledge-task__result-summary" data-testid="knowledge-task-result" aria-label={uiText('Git 协作测试结果概览', 'Git collaboration test result overview')}>
              <div class="knowledge-task__result-heading">
                <div>
                  <h2>{uiText('Reviewer 已批准', 'Approved by Reviewer')}</h2>
                  <p>{uiText(
                    '结果保留在 Task branch 中，PROGRESS.md 与 handoff 已保留，目标分支未被修改。',
                    'The result remains on the Task branch, PROGRESS.md and the handoff are preserved, and the target branch is unchanged.'
                  )}</p>
                </div>
                <span>{result().completedAt ? `${uiText('完成于', 'Completed at')} ${formatTime(result().completedAt)}` : ''}</span>
              </div>
              <div class="knowledge-task__result-metrics">
                <div><strong data-testid="knowledge-task-result-statement-count">{result().statements.length}</strong><span>Statements</span></div>
                <div><strong>{result().roundCount}</strong><span>Collaboration Rounds</span></div>
                <div><strong>{result().changedPaths.length}</strong><span>{uiText('变更文件', 'Changed Files')}</span></div>
                <div><strong>{result().durationMs === undefined ? '—' : formatDuration(result().durationMs!)}</strong><span>{uiText('耗时', 'Duration')}</span></div>
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
                >{uiText('查看结果详情', 'View Result Details')}</Button>
              </div>
            </section>
          )}
        </Show>

      <Show when={detail()}>{(currentDetail) => (
        <aside class="knowledge-task__inspector" role="complementary" aria-label={uiText('Knowledge Task 详情', 'Knowledge Task details')}>
          <div class="processing-history__inspector-toolbar">
            <strong>{currentDetail() === 'activity' ? uiText('Agent Invocation 详情', 'Agent Invocation Details') : uiText('Task 结果', 'Task Result')}</strong>
            <button
              type="button"
              data-testid={currentDetail() === 'activity' ? 'knowledge-task-detail-back' : 'knowledge-task-result-back'}
              aria-label={uiText('关闭 Knowledge Task 详情', 'Close Knowledge Task details')}
              onClick={() => setDetail(undefined)}
            ><Icon name="close" /><span>{uiText('关闭', 'Close')}</span></button>
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

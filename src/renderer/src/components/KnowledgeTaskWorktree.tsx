import { Show, createEffect, createMemo, createSignal } from 'solid-js'
import type { SourceConversationSummary } from '../../../shared/discovery'
import type { LlmBinding } from '../../../shared/ai-backends'
import type {
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
import { Button, Inspector } from '../ui'
import {
  KnowledgeTaskActivityDetail,
  KnowledgeTaskResultDetail
} from './KnowledgeTaskDetails'
import { SourceConversationMetadata } from './SourceConversationMetadata'
import { SourceConversationPicker } from './SourceConversationPicker'
import { appLanguage, uiText } from '../i18n'

export interface KnowledgeTaskResultView {
  completedAt?: string
  durationMs?: number
  integratedRepositoryRevision: string
  changedPaths: string[]
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
    name: agent.agentId === 'knowledge_maintainer'
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

  return (
    <div class="knowledge-task" data-testid="knowledge-task-worktree">
      <div class="knowledge-task__boundary" data-testid="git-collaboration-boundary">
        <span class="git-collaboration-badge">{uiText('Git 协作测试', 'Git Collaboration Test')}</span>
        <p>{uiText(
          'Knowledge Processing Task 使用独立 Task 分支；Maintainer 与 Reviewer 通过 PROGRESS.md 协作，Reviewer 将批准的修改合并到 main 后 Task 才会完成。',
          'A Knowledge Processing Task uses an independent Task branch. The Maintainer and Reviewer collaborate through PROGRESS.md, and the Task completes only after the Reviewer integrates approved changes into main.'
        )}</p>
      </div>

        <div class="knowledge-task__worktree">
          <section class="knowledge-task__setup" aria-label={uiText('Knowledge Processing Task 输入', 'Knowledge Processing Task input')}>
            <div class="knowledge-task__section-heading">
              <div>
                <h2>{uiText('Task 设置', 'Task Setup')}</h2>
                <p>{uiText('选择来源对话并补充关注内容，然后启动 Knowledge Processing Task。', 'Select a Source Conversation, add any focus, then start the Knowledge Processing Task.')}</p>
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
              <span>{uiText('补充关注内容（可选）', 'Additional Focus (Optional)')}</span>
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
                  <h2>{uiText('已合并到 main', 'Integrated into main')}</h2>
                  <p>{uiText(
                    '当前知识与产物请分别前往知识库与工作台浏览。',
                    'Browse current Knowledge and Artifacts in Knowledge and Workbench respectively.'
                  )}</p>
                </div>
                <span>{result().completedAt ? `${uiText('完成于', 'Completed at')} ${formatTime(result().completedAt)}` : ''}</span>
              </div>
              <div class="knowledge-task__result-metrics">
                <div><strong title={result().integratedRepositoryRevision}>{result().integratedRepositoryRevision.slice(0, 12)}</strong><span>{uiText('合并 revision', 'Integrated Revision')}</span></div>
                <div><strong data-testid="knowledge-task-result-changed-path-count">{result().changedPaths.length}</strong><span>{uiText('变更文件', 'Changed Files')}</span></div>
                <div><strong>{result().durationMs === undefined ? '—' : formatDuration(result().durationMs!)}</strong><span>{uiText('耗时', 'Duration')}</span></div>
              </div>
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
        <Inspector
          class="knowledge-task__inspector"
          size="wide"
          ariaLabel={uiText('Knowledge Task 详情', 'Knowledge Task details')}
          title={currentDetail() === 'activity' ? uiText('Agent Invocation 详情', 'Agent Invocation Details') : uiText('Task 结果', 'Task Result')}
          closeLabel={uiText('关闭', 'Close')}
          closeTestId={currentDetail() === 'activity' ? 'knowledge-task-detail-back' : 'knowledge-task-result-back'}
          onClose={() => setDetail(undefined)}
          contentClass="knowledge-task__inspector-content"
        >
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
        </Inspector>
      )}
      </Show>
    </div>
  )
}

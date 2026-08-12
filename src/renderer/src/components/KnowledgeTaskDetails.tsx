import { For, Show, createEffect, createMemo, createSignal } from 'solid-js'
import { Button } from '../ui'
import {
  AgentInvocationCollectionExplorer,
  AgentModelCallInspector
} from './AgentInvocationView'
import type { KnowledgeTaskResultView } from './KnowledgeTaskWorktree'
import type {
  KnowledgeTaskResult,
  LiveAgentInvocationView
} from '../../../shared/knowledge-processing'
import type { AgentInvocationDebugRecord } from '../../../shared/agent-runtime'
import { processingAgentDisplayName } from '../processing-agent-presentation'
import { appLanguage, uiText } from '../i18n'

function formatTime(value?: string): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(appLanguage())
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs} ms`
  return `${(durationMs / 1_000).toFixed(1)} s`
}

export function knowledgeTaskResultView(result: KnowledgeTaskResult): KnowledgeTaskResultView {
  return {
    completedAt: result.completedAt,
    durationMs: result.durationMs,
    integratedRepositoryRevision: result.integratedRepositoryRevision,
    changedPaths: result.changedPaths
  }
}

export function KnowledgeTaskActivityDetail(props: {
  view?: LiveAgentInvocationView
  invocations?: AgentInvocationDebugRecord[]
  followLatestInvocation?: boolean
  title?: string
  description?: string
  backLabel?: string
  detailTestId: string
  backTestId?: string
  onBack?(): void
}) {
  const [modelCallSelection, setModelCallSelection] = createSignal<{
    invocationId: string
    callId: string
  }>()
  const invocations = () => props.invocations
    ?? (props.view ? [props.view.invocation] : [])
  const hasIntro = () => Boolean(props.title || props.description || props.onBack)
  const selectedModelCall = createMemo(() => {
    const selection = modelCallSelection()
    if (!selection) return undefined
    const invocation = invocations().find((item) => item.invocationId === selection.invocationId)
    if (!invocation) return undefined
    const index = invocation.modelCalls.findIndex((call) => call.id === selection.callId)
    const call = invocation.modelCalls[index]
    return call ? { call, index } : undefined
  })

  createEffect(() => {
    if (modelCallSelection() && !selectedModelCall()) setModelCallSelection(undefined)
  })

  return (
    <section class="knowledge-task__detail-page" data-testid={props.detailTestId}>
      <Show
        when={selectedModelCall()}
        fallback={(
          <>
            <Show when={hasIntro()}>
              <div class="knowledge-task__detail-header">
                <Show when={props.onBack}>{(onBack) => (
                  <Button variant="ghost" icon="back" data-testid={props.backTestId} onClick={onBack()}>
                    {props.backLabel || uiText('返回', 'Back')}
                  </Button>
                )}</Show>
                <div>
                  <h2>{props.title || uiText('Agent Invocation 详情', 'Agent Invocation Details')}</h2>
                  <p>{props.description || uiText('选择一次 Model Call 或 Tool Call，检查其输入和结果。', 'Select a Model Call or Tool Call to inspect its input and result.')}</p>
                </div>
              </div>
            </Show>
            <p class={`knowledge-task__detail-disclosure${hasIntro() ? '' : ' knowledge-task__detail-disclosure--first'}`}>{uiText(
              'Debug Record 可能包含原始观察材料、完整 Pi Context 和最终 Provider Payload；数据仅保存在本地，并对常见凭据 Header 做脱敏。',
              'Debug Records may contain raw observation material, complete Pi Context, and the final Provider Payload. Data stays local, and common credential-bearing headers are redacted.'
            )}</p>
            <Show
              when={invocations().length}
              fallback={<div class="knowledge-task__empty">{uiText('这个 Task 没有实际启动 Agent Invocation。', 'This Task did not actually start an Agent Invocation.')}</div>}
            >
              <AgentInvocationCollectionExplorer
                invocations={invocations()}
                agentDisplayName={(invocation) => processingAgentDisplayName(invocation.agentId)}
                followLatestInvocation={props.followLatestInvocation}
                onInspectModelCall={(invocation, call) => setModelCallSelection({
                  invocationId: invocation.invocationId,
                  callId: call.id
                })}
              />
            </Show>
          </>
        )}
      >
        {(selection) => (
          <div class="knowledge-task__model-call-detail" data-testid="knowledge-task-model-call-detail">
            <div class="knowledge-task__detail-header knowledge-task__detail-header--back">
              <Button
                variant="ghost"
                icon="back"
                data-testid="knowledge-task-model-call-back"
                onClick={() => setModelCallSelection(undefined)}
              >{uiText('返回 Invocation', 'Back to Invocation')}</Button>
              <div>
                <h2>{uiText('模型调用详情', 'Model Call Details')}</h2>
                <p>{uiText('检查这一次请求使用的完整 Context、Provider Payload 与模型输出。', 'Inspect the complete Context, Provider Payload, and model output used by this request.')}</p>
              </div>
            </div>
            <AgentModelCallInspector call={selection().call} index={selection().index} />
          </div>
        )}
      </Show>
    </section>
  )
}

export function KnowledgeTaskResultDetail(props: {
  result: KnowledgeTaskResultView
  title?: string
  description?: string
  backLabel?: string
  detailTestId: string
  backTestId?: string
  onBack?(): void
}) {
  return (
    <section class="knowledge-task__detail-page knowledge-task__result" data-testid={props.detailTestId} aria-label={uiText('Knowledge Processing Task 结果详情', 'Knowledge Processing Task result details')}>
      <div class="knowledge-task__detail-header">
        <Show when={props.onBack}>{(onBack) => (
          <Button variant="ghost" icon="back" data-testid={props.backTestId} onClick={onBack()}>
            {props.backLabel || uiText('返回', 'Back')}
          </Button>
        )}</Show>
        <div>
          <h2>{props.title || uiText('已合并结果', 'Integrated Result')}</h2>
          <p>{props.description || uiText(
            'Reviewer 已将批准的修改合并到 main；请前往知识库或工作台浏览当前内容。',
            'The Reviewer integrated the approved changes into main. Browse the current content in Knowledge or Workbench.'
          )}</p>
        </div>
        <div class="knowledge-task__detail-actions">
          <span>{props.result.completedAt ? `${uiText('完成于', 'Completed at')} ${formatTime(props.result.completedAt)}` : ''}</span>
        </div>
      </div>

      <dl class="knowledge-task-details" data-testid="knowledge-task-git-result">
        <div><dt>{uiText('合并 revision', 'Integrated Revision')}</dt><dd>{props.result.integratedRepositoryRevision}</dd></div>
        <div><dt>{uiText('变更文件', 'Changed Files')}</dt><dd>{props.result.changedPaths.length}</dd></div>
        <div><dt>{uiText('耗时', 'Duration')}</dt><dd>{props.result.durationMs === undefined ? '—' : formatDuration(props.result.durationMs)}</dd></div>
      </dl>

      <details class="knowledge-task__candidates ui-disclosure">
        <summary>{uiText('变更文件', 'Changed Files')} ({props.result.changedPaths.length})</summary>
        <ul>
          <For each={props.result.changedPaths}>{(path) => <li><code>{path}</code></li>}</For>
        </ul>
      </details>
    </section>
  )
}

import { For, Show, createEffect, createMemo, createSignal } from 'solid-js'
import { Button } from '../ui'
import { KnowledgeStatementBrowser, statementPreview } from './KnowledgeStatementBrowser'
import {
  AgentInvocationCollectionExplorer,
  AgentModelCallInspector
} from './AgentInvocationView'
import type {
  KnowledgeTaskResultView,
  UiMilestoneView
} from './KnowledgeTaskWorktree'
import type {
  KnowledgeTaskRecord,
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

function milestoneClass(state: UiMilestoneView['state']): string {
  return `ui-milestone ui-milestone--${state}`
}

function milestoneMarker(milestone: UiMilestoneView, index: number): string {
  if (milestone.state === 'completed') return '✓'
  if (milestone.state === 'failed') return '!'
  if (milestone.state === 'in_progress') return '…'
  return String(index + 1)
}

export function knowledgeTaskResultView(result: KnowledgeTaskResult): KnowledgeTaskResultView {
  return {
    taskId: result.taskId,
    completedAt: result.completedAt,
    durationMs: result.durationMs,
    worktree: result.worktree,
    approvedRepositoryRevision: result.approvedRepositoryRevision,
    changedPaths: result.changedPaths,
    artifactPaths: result.artifactPaths,
    roundCount: result.rounds.length,
    milestones: [
      {
        id: 'source_snapshot',
        label: uiText('固定 Source Snapshot', 'Freeze Source Snapshot'),
        detail: `${result.sourceConversation.sourceDisplayName} · ${result.sourceSnapshot.sourceRevision.slice(0, 12)}`,
        state: 'completed'
      },
      {
        id: 'task_worktree',
        label: uiText('创建 Task worktree', 'Create Task Worktree'),
        detail: `${result.worktree.branchName} · ${result.worktree.taskPath}`,
        state: 'completed'
      },
      {
        id: 'collaboration_rounds',
        label: uiText('Maintainer / Reviewer 协作', 'Maintainer / Reviewer Collaboration'),
        detail: `${result.rounds.length} Collaboration Rounds`,
        state: 'completed'
      },
      {
        id: 'reviewer_approval',
        label: uiText('Reviewer 批准', 'Reviewer Approval'),
        detail: `${result.approvedRepositoryRevision.slice(0, 12)} · ${uiText('未合并到', 'not merged into')} ${result.worktree.targetBranch}`,
        state: 'completed'
      }
    ],
    statements: result.knowledge.map((statement) => ({
      title: statement.title,
      content: statement.content
    }))
  }
}

function terminalStatusLabel(status: KnowledgeTaskRecord['status']): string {
  if (status === 'completed') return uiText('已完成', 'Completed')
  if (status === 'abandoned') return uiText('已放弃', 'Abandoned')
  return uiText('Task 可继续', 'Task Can Continue')
}

export function KnowledgeTaskActivityDetail(props: {
  view?: LiveAgentInvocationView
  invocations?: AgentInvocationDebugRecord[]
  followLatestInvocation?: boolean
  status?: KnowledgeTaskRecord['status']
  error?: string
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
    const invocation = invocations().find((item) => item.id === selection.invocationId)
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
              'Debug Record 可能包含原始观察材料、完整 Pi Context 和最终 Provider Payload；数据仅保存在本地，不保存凭据，敏感请求 Header 会被脱敏。',
              'Debug Records may contain raw observation material, complete Pi Context, and the final Provider Payload. Data stays local, credentials are not stored, and sensitive request headers are redacted.'
            )}</p>
            <Show when={props.status}>{(status) => (
              <div
                class={`processing-history-detail-status processing-history-detail-status--${status()}`}
                data-testid="history-task-status"
              >
                <strong>{terminalStatusLabel(status())}</strong>
                <Show when={props.error}>{(error) => <p>{error()}</p>}</Show>
              </div>
            )}</Show>
            <Show
              when={invocations().length}
              fallback={<div class="knowledge-task__empty">{uiText('这个 Task 没有实际启动 Agent Invocation。', 'This Task did not actually start an Agent Invocation.')}</div>}
            >
              <AgentInvocationCollectionExplorer
                invocations={invocations()}
                agentDisplayName={(invocation) => processingAgentDisplayName(invocation.agentId)}
                followLatestInvocation={props.followLatestInvocation}
                onInspectModelCall={(invocation, call) => setModelCallSelection({
                  invocationId: invocation.id,
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
  listLabel?: string
  backLabel?: string
  detailTestId: string
  backTestId?: string
  onBack?(): void
}) {
  const [selectedTitle, setSelectedTitle] = createSignal<string>()
  const selectedStatement = createMemo(() => props.result.statements.find(
    (statement) => statement.title === selectedTitle()
  ) || props.result.statements[0])
  const statementSummaries = createMemo(() => props.result.statements.map((statement) => ({
    title: statement.title,
    preview: statementPreview(statement.content, 150)
  })))

  createEffect(() => {
    props.result.taskId
    setSelectedTitle(props.result.statements[0]?.title)
  })

  return (
    <section class="knowledge-task__detail-page knowledge-task__result" data-testid={props.detailTestId} aria-label={uiText('Knowledge Processing Task 结果详情', 'Knowledge Processing Task result details')}>
      <div class="knowledge-task__detail-header">
        <Show when={props.onBack}>{(onBack) => (
          <Button variant="ghost" icon="back" data-testid={props.backTestId} onClick={onBack()}>
            {props.backLabel || uiText('返回', 'Back')}
          </Button>
        )}</Show>
        <div>
          <h2>{props.title || uiText('协作分支结果', 'Collaboration Branch Result')}</h2>
          <p>{props.description || uiText('Reviewer 已批准这个 revision；Task 不会把它合并到目标分支。', 'The Reviewer approved this revision; the Task does not merge it into the target branch.')}</p>
        </div>
        <div class="knowledge-task__detail-actions">
          <span>{props.result.completedAt ? `${uiText('完成于', 'Completed at')} ${formatTime(props.result.completedAt)}` : ''}</span>
        </div>
      </div>

      <div class="ui-milestone-list" aria-label="Task UI Milestones">
        <For each={props.result.milestones}>{(milestone, index) => (
          <div class={milestoneClass(milestone.state)}>
            <span class="ui-milestone__marker">{milestoneMarker(milestone, index())}</span>
            <strong>{milestone.label}</strong>
            <p title={milestone.detail}>{milestone.detail}</p>
          </div>
        )}</For>
      </div>

      <dl class="knowledge-task-details" data-testid="knowledge-task-git-result">
        <div><dt>Repository</dt><dd>{props.result.worktree.repositoryPath}</dd></div>
        <div><dt>Task record</dt><dd>{props.result.worktree.taskPath}</dd></div>
        <div><dt>BRIEF.md</dt><dd>{props.result.worktree.briefPath}</dd></div>
        <div><dt>PROGRESS.md</dt><dd>{props.result.worktree.progressPath}</dd></div>
        <div><dt>Inputs</dt><dd>{props.result.worktree.inputPath}</dd></div>
        <div><dt>Task branch</dt><dd>{props.result.worktree.branchName}</dd></div>
        <div><dt>{uiText('目标分支', 'Target Branch')}</dt><dd>{uiText(
          `${props.result.worktree.targetBranch}（未合并）`,
          `${props.result.worktree.targetBranch} (not merged)`
        )}</dd></div>
        <div><dt>Base revision</dt><dd>{props.result.worktree.baseRepositoryRevision}</dd></div>
        <div><dt>{uiText('批准 revision', 'Approved Revision')}</dt><dd>{props.result.approvedRepositoryRevision}</dd></div>
        <div><dt>Collaboration Rounds</dt><dd>{props.result.roundCount}</dd></div>
        <div><dt>{uiText('变更文件', 'Changed Files')}</dt><dd>{props.result.changedPaths.length}</dd></div>
      </dl>

      <div class="knowledge-browser knowledge-browser--collaboration">
        <KnowledgeStatementBrowser
          items={statementSummaries()}
          total={props.result.statements.length}
          selectedTitle={selectedStatement()?.title}
          selectedStatement={selectedStatement()}
          listLabel={props.listLabel || uiText('协作分支 Statements', 'Collaboration Branch Statements')}
          emptyListText={uiText('本次 Task 没有生成 Knowledge Statement。', 'This Task did not generate any Knowledge Statements.')}
          navigationKey={props.result.taskId}
          onSelect={setSelectedTitle}
          onRead={async (title) => props.result.statements.find(
            (statement) => statement.title === title
          )}
        />
      </div>

      <details class="knowledge-task__candidates ui-disclosure">
        <summary>{uiText('变更文件', 'Changed Files')} ({props.result.changedPaths.length})</summary>
        <ul>
          <For each={props.result.changedPaths}>{(path) => <li><code>{path}</code></li>}</For>
        </ul>
      </details>
      <Show when={props.result.artifactPaths.length}>
        <details class="knowledge-task__candidates ui-disclosure">
          <summary>Artifacts（{props.result.artifactPaths.length}）</summary>
          <ul>
            <For each={props.result.artifactPaths}>{(path) => <li><code>{path}</code></li>}</For>
          </ul>
        </details>
      </Show>
    </section>
  )
}

import { For, Show, createEffect, createMemo, createSignal } from 'solid-js'
import { Button } from '../ui'
import { KnowledgeStatementBrowser, statementPreview } from './KnowledgeStatementBrowser'
import { AgentInvocationCollectionExplorer } from './AgentInvocationView'
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

function formatTime(value?: string): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN')
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
        label: '固定 Source Snapshot',
        detail: `${result.sourceConversation.sourceDisplayName} · ${result.sourceSnapshot.sourceRevision.slice(0, 12)}`,
        state: 'completed'
      },
      {
        id: 'task_worktree',
        label: '创建 Task worktree',
        detail: `${result.worktree.branchName} · ${result.worktree.taskPath}`,
        state: 'completed'
      },
      {
        id: 'collaboration_rounds',
        label: 'Maintainer / Reviewer 协作',
        detail: `${result.rounds.length} 个 Collaboration Rounds`,
        state: 'completed'
      },
      {
        id: 'reviewer_approval',
        label: 'Reviewer 批准',
        detail: `${result.approvedRepositoryRevision.slice(0, 12)} · 未合并到 ${result.worktree.targetBranch}`,
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
  if (status === 'completed') return '已完成'
  if (status === 'abandoned') return '已放弃'
  return 'Task 可继续'
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
  const invocations = () => props.invocations
    ?? (props.view ? [props.view.invocation] : [])
  return (
    <section class="knowledge-task__detail-page" data-testid={props.detailTestId}>
      <div class="knowledge-task__detail-header">
        <Show when={props.onBack}>{(onBack) => (
          <Button variant="ghost" icon="back" data-testid={props.backTestId} onClick={onBack()}>
            {props.backLabel || '返回'}
          </Button>
        )}</Show>
        <div>
          <h2>{props.title || 'Agent Invocation 详情'}</h2>
          <p>{props.description || '选择一次 Model Call 或 Tool Call，检查其输入和结果。'}</p>
        </div>
      </div>
      <p class="knowledge-task__detail-disclosure">Debug Record 可能包含原始观察材料、完整 Pi Context 和最终 Provider Payload；数据仅保存在本地，不保存凭据，敏感请求 Header 会被脱敏。</p>
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
        fallback={<div class="knowledge-task__empty">这个 Task 没有实际启动 Agent Invocation。</div>}
      >
        <AgentInvocationCollectionExplorer
          invocations={invocations()}
          agentDisplayName={(invocation) => processingAgentDisplayName(invocation.agentId)}
          followLatestInvocation={props.followLatestInvocation}
        />
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
    <section class="knowledge-task__detail-page knowledge-task__result" data-testid={props.detailTestId} aria-label="Knowledge Processing Task 结果详情">
      <div class="knowledge-task__detail-header">
        <Show when={props.onBack}>{(onBack) => (
          <Button variant="ghost" icon="back" data-testid={props.backTestId} onClick={onBack()}>
            {props.backLabel || '返回'}
          </Button>
        )}</Show>
        <div>
          <h2>{props.title || '协作分支结果'}</h2>
          <p>{props.description || 'Reviewer 已批准这个 revision；Task 不会把它合并到目标分支。'}</p>
        </div>
        <div class="knowledge-task__detail-actions">
          <span>{props.result.completedAt ? `完成于 ${formatTime(props.result.completedAt)}` : ''}</span>
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
        <div><dt>目标分支</dt><dd>{props.result.worktree.targetBranch}（未合并）</dd></div>
        <div><dt>Base revision</dt><dd>{props.result.worktree.baseRepositoryRevision}</dd></div>
        <div><dt>批准 revision</dt><dd>{props.result.approvedRepositoryRevision}</dd></div>
        <div><dt>Collaboration Rounds</dt><dd>{props.result.roundCount}</dd></div>
        <div><dt>变更文件</dt><dd>{props.result.changedPaths.length}</dd></div>
      </dl>

      <div class="knowledge-browser knowledge-browser--collaboration">
        <KnowledgeStatementBrowser
          items={statementSummaries()}
          total={props.result.statements.length}
          selectedTitle={selectedStatement()?.title}
          selectedStatement={selectedStatement()}
          listLabel={props.listLabel || '协作分支 Statements'}
          emptyListText="本次 Task 没有生成 Knowledge Statement。"
          navigationKey={props.result.taskId}
          onSelect={setSelectedTitle}
          onRead={async (title) => props.result.statements.find(
            (statement) => statement.title === title
          )}
        />
      </div>

      <details class="knowledge-task__candidates ui-disclosure">
        <summary>变更文件（{props.result.changedPaths.length}）</summary>
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

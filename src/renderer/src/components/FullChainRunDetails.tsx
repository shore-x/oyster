import { For, Show, createEffect, createMemo, createSignal } from 'solid-js'
import { Button } from '../ui'
import { KnowledgeStatementBrowser, statementPreview } from './KnowledgeStatementBrowser'
import { AgentRunCollectionExplorer } from './AgentRunView'
import type { FullChainResultView, FullChainStepView } from './FullChainWorkspace'
import type {
  KnowledgeFullChainRunRecord,
  KnowledgeFullChainResult,
  KnowledgeProcessingDebugTrace
} from '../../../shared/knowledge-processing'
import type { AgentRunRecord } from '../../../shared/agent-runtime'
import { processingAgentDisplayName } from '../processing-agent-presentation'

function formatTime(value?: string): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN')
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs} ms`
  return `${(durationMs / 1_000).toFixed(1)} s`
}

export function fullChainResultView(result: KnowledgeFullChainResult): FullChainResultView {
  return {
    runId: result.runId,
    completedAt: result.completedAt,
    durationMs: result.durationMs,
    run: result.run,
    approvedRevision: result.approvedRevision,
    changedPaths: result.changedPaths,
    artifactPaths: result.artifactPaths,
    maintenanceRunCount: result.maintenanceRuns.length,
    reviewRunCount: result.reviewRuns.length,
    steps: [
      {
        id: 'session',
        label: '读取 Session',
        detail: result.session.sourceDisplayName,
        state: 'completed'
      },
      {
        id: 'work_order',
        label: '创建 Run',
        detail: `${result.run.branchName} · ${result.run.runPath}`,
        state: 'completed'
      },
      {
        id: 'collaboration',
        label: '维护与审查',
        detail: `${result.maintenanceRuns.length} 次 Maintainer · ${result.reviewRuns.length} 次 Reviewer`,
        state: 'completed'
      },
      {
        id: 'approved',
        label: 'Reviewer 批准',
        detail: `${result.approvedRevision.slice(0, 12)} · 未合并到 ${result.run.targetBranch}`,
        state: 'completed'
      }
    ],
    statements: result.knowledge.map((statement) => ({
      title: statement.title,
      content: statement.content
    }))
  }
}

function stepClass(state: FullChainStepView['state']): string {
  return `full-chain-step full-chain-step--${state}`
}

function stepMarker(step: FullChainStepView, index: number): string {
  if (step.state === 'completed') return '✓'
  if (step.state === 'failed') return '!'
  if (step.state === 'running') return '…'
  return String(index + 1)
}

function terminalStatusLabel(status: KnowledgeFullChainRunRecord['status']): string {
  if (status === 'completed') return '已完成'
  if (status === 'cancelled') return '已取消'
  return '失败'
}

export function FullChainActivityDetail(props: {
  trace?: KnowledgeProcessingDebugTrace
  runs?: AgentRunRecord[]
  followLatestRun?: boolean
  status?: KnowledgeFullChainRunRecord['status']
  error?: string
  title?: string
  description?: string
  backLabel: string
  detailTestId: string
  backTestId: string
  onBack(): void
}) {
  const runs = () => props.runs ?? (props.trace ? [props.trace.run] : [])
  return (
    <section class="chain-test__detail-page" data-testid={props.detailTestId}>
      <div class="chain-test__detail-header">
        <Button variant="ghost" icon="back" data-testid={props.backTestId} onClick={props.onBack}>{props.backLabel}</Button>
        <div>
          <h2>{props.title || '运行详情'}</h2>
          <p>{props.description || '选择一次模型或工具调用，检查该事件的输出与结果。'}</p>
        </div>
      </div>
      <p class="chain-test__detail-disclosure">运行记录可能包含原始观察材料和完整 Pi Context；数据仅保存在本地，不包含 Provider Payload 或鉴权信息。</p>
      <Show when={props.status}>{(status) => (
        <div
          class={`processing-history-detail-status processing-history-detail-status--${status()}`}
          data-testid="history-run-status"
        >
          <strong>{terminalStatusLabel(status())}</strong>
          <Show when={props.error}>{(error) => <p>{error()}</p>}</Show>
        </div>
      )}</Show>
      <Show when={runs().length} fallback={<div class="chain-test__empty">这次测试没有实际启动 Agent。</div>}>
        <AgentRunCollectionExplorer
          runs={runs()}
          agentDisplayName={(run) => processingAgentDisplayName(run.agentId)}
          followLatestRun={props.followLatestRun}
        />
      </Show>
    </section>
  )
}

export function FullChainResultDetail(props: {
  result: FullChainResultView
  title?: string
  description?: string
  listLabel?: string
  backLabel: string
  detailTestId: string
  backTestId: string
  onBack(): void
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
    props.result.runId
    setSelectedTitle(props.result.statements[0]?.title)
  })

  return (
    <section class="chain-test__detail-page chain-test__result" data-testid={props.detailTestId} aria-label="Git 协作测试结果详情">
      <div class="chain-test__detail-header">
        <Button variant="ghost" icon="back" data-testid={props.backTestId} onClick={props.onBack}>{props.backLabel}</Button>
        <div>
          <h2>{props.title || '协作分支结果'}</h2>
          <p>{props.description || 'Reviewer 已批准这个 revision；测试运行不会把它合并到目标分支。'}</p>
        </div>
        <div class="chain-test__detail-actions">
          <span>{props.result.completedAt ? `完成于 ${formatTime(props.result.completedAt)}` : ''}</span>
        </div>
      </div>

      <div class="full-chain-progress">
        <For each={props.result.steps}>{(step, index) => (
          <div class={stepClass(step.state)}>
            <span class="full-chain-step__marker">{stepMarker(step, index())}</span>
            <strong>{step.label}</strong>
            <p title={step.detail}>{step.detail}</p>
          </div>
        )}</For>
      </div>

      <dl class="processing-run-details" data-testid="full-chain-git-result">
        <div><dt>Repository</dt><dd>{props.result.run.repositoryPath}</dd></div>
        <div><dt>Run</dt><dd>{props.result.run.runPath}</dd></div>
        <div><dt>WORK.md</dt><dd>{props.result.run.workPath}</dd></div>
        <div><dt>处理分支</dt><dd>{props.result.run.branchName}</dd></div>
        <div><dt>目标分支</dt><dd>{props.result.run.targetBranch}（未合并）</dd></div>
        <div><dt>Base revision</dt><dd>{props.result.run.baseRevision}</dd></div>
        <div><dt>批准 revision</dt><dd>{props.result.approvedRevision}</dd></div>
        <div><dt>Maintainer / Reviewer</dt><dd>{props.result.maintenanceRunCount} / {props.result.reviewRunCount}</dd></div>
        <div><dt>变更文件</dt><dd>{props.result.changedPaths.length}</dd></div>
      </dl>

      <div class="knowledge-browser knowledge-browser--collaboration">
        <KnowledgeStatementBrowser
          items={statementSummaries()}
          total={props.result.statements.length}
          selectedTitle={selectedStatement()?.title}
          selectedStatement={selectedStatement()}
          listLabel={props.listLabel || '协作分支 Statements'}
          emptyListText="本次测试没有生成 Knowledge Statement。"
          navigationKey={props.result.runId}
          onSelect={setSelectedTitle}
          onRead={async (title) => props.result.statements.find((statement) => statement.title === title)}
        />
      </div>

      <details class="chain-test__candidates ui-disclosure">
        <summary>变更文件（{props.result.changedPaths.length}）</summary>
        <ul>
          <For each={props.result.changedPaths}>{(path) => <li><code>{path}</code></li>}</For>
        </ul>
      </details>
      <Show when={props.result.artifactPaths.length}>
        <details class="chain-test__candidates ui-disclosure">
          <summary>Artifacts（{props.result.artifactPaths.length}）</summary>
          <ul>
            <For each={props.result.artifactPaths}>{(path) => <li><code>{path}</code></li>}</For>
          </ul>
        </details>
      </Show>
    </section>
  )
}

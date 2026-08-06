import { For, Show, createEffect, createMemo, createSignal } from 'solid-js'
import { Button } from '../ui'
import type { KnowledgeCommitResult } from '../../../shared/knowledge'
import { KnowledgeStatementBrowser, statementPreview } from './KnowledgeStatementBrowser'
import { AgentRunCollectionExplorer } from './AgentRunView'
import { AgentTodoList } from './AgentTodoList'
import type { FullChainResultView, FullChainStepView } from './FullChainWorkspace'
import type {
  KnowledgeFullChainRunRecord,
  KnowledgeFullChainResult,
  KnowledgeProcessingDebugTrace
} from '../../../shared/knowledge-processing'
import type { AgentRunRecord } from '../../../shared/agent-runtime'

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
    todos: result.maintenance.todos,
    steps: [
      {
        id: 'session',
        label: '读取 Session',
        detail: result.session.sourceDisplayName,
        state: 'completed'
      },
      {
        id: 'maintenance',
        label: '知识维护与写入',
        detail: `${result.maintenance.evidenceSegmentCount} 个证据段 · ${result.maintenance.execution.modelCallCount} 次模型调用 · ${result.commit.statements.length} 条 Statement`,
        state: 'completed'
      }
    ],
    statements: result.knowledge.statements.map((statement) => ({
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
        <AgentRunCollectionExplorer runs={runs()} />
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
  importTestId?: string
  importing?: boolean
  importResult?: KnowledgeCommitResult
  onBack(): void
  onImport?(): void
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
    <section class="chain-test__detail-page chain-test__result" data-testid={props.detailTestId} aria-label="Sandbox 测试结果详情">
      <div class="chain-test__detail-header">
        <Button variant="ghost" icon="back" data-testid={props.backTestId} onClick={props.onBack}>{props.backLabel}</Button>
        <div>
          <h2>{props.title || 'Sandbox 结果详情'}</h2>
          <p>{props.description || '这是测试产生的隔离知识，不代表当前知识库。'}</p>
        </div>
        <div class="chain-test__detail-actions">
          <span>{props.result.completedAt ? `完成于 ${formatTime(props.result.completedAt)}` : ''}</span>
          <Show when={props.onImport}>
            <Button
              variant="primary"
              icon="download"
              data-testid={props.importTestId}
              disabled={props.importing || props.result.statements.length === 0}
              onClick={props.onImport}
            >{props.importing ? '正在导入…' : '导入正式知识库'}</Button>
          </Show>
        </div>
      </div>

      <Show when={props.importResult}>
        {(commit) => (
          <div class="knowledge-browser__notice" role="status" data-testid="full-chain-import-result">
            已导入 {commit().statements.length} 条知识：新增 {commit().createdTitles.length} 条，覆盖 {commit().updatedTitles.length} 条。
          </div>
        )}
      </Show>

      <div class="full-chain-progress">
        <For each={props.result.steps}>{(step, index) => (
          <div class={stepClass(step.state)}>
            <span class="full-chain-step__marker">{stepMarker(step, index())}</span>
            <strong>{step.label}</strong>
            <p title={step.detail}>{step.detail}</p>
          </div>
        )}</For>
      </div>

      <div class="knowledge-browser knowledge-browser--sandbox">
        <KnowledgeStatementBrowser
          items={statementSummaries()}
          total={props.result.statements.length}
          selectedTitle={selectedStatement()?.title}
          selectedStatement={selectedStatement()}
          listLabel={props.listLabel || 'Sandbox Statements'}
          emptyListText="本次测试没有生成 Knowledge Statement。"
          navigationKey={props.result.runId}
          onSelect={setSelectedTitle}
          onRead={async (title) => props.result.statements.find((statement) => statement.title === title)}
        />
      </div>

      <details class="chain-test__candidates ui-disclosure">
        <summary>Maintainer Todos（{props.result.todos.length}）</summary>
        <AgentTodoList todos={props.result.todos} emptyText="本次 Maintainer 运行没有 Todo。" />
      </details>
    </section>
  )
}

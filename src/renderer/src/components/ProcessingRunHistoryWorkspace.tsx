import { For, Show, createEffect, createSignal } from 'solid-js'
import type {
  KnowledgeFullChainRunRecord,
  KnowledgeFullChainRunSummary
} from '../../../shared/knowledge-processing'
import type { KnowledgeCommitResult } from '../../../shared/knowledge'
import { Button } from '../ui'
import {
  FullChainActivityDetail,
  FullChainResultDetail,
  fullChainResultView
} from './FullChainRunDetails'

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN')
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs} ms`
  return `${(durationMs / 1_000).toFixed(1)} s`
}

function statusLabel(status: KnowledgeFullChainRunSummary['status']): string {
  if (status === 'completed') return '已完成'
  if (status === 'cancelled') return '已取消'
  return '失败'
}

export function ProcessingRunHistoryWorkspace(props: {
  runs: KnowledgeFullChainRunSummary[]
  loading: boolean
  selected?: KnowledgeFullChainRunRecord
  loadingRunId?: string
  importingRunId?: string
  importResult?: { runId: string; commit: KnowledgeCommitResult }
  onOpen(runId: string): Promise<KnowledgeFullChainRunRecord | undefined>
  onImport(runId: string): Promise<KnowledgeCommitResult | undefined>
}) {
  const [page, setPage] = createSignal<'list' | 'activity' | 'result'>('list')

  createEffect(() => {
    if (page() !== 'list' && !props.selected) setPage('list')
  })

  async function open(runId: string, target: 'activity' | 'result'): Promise<void> {
    if (await props.onOpen(runId)) setPage(target)
  }

  return (
    <div class="processing-history" data-testid="processing-run-history">
      <Show when={page() === 'list'}>
        <section class="processing-history__overview">
          <div class="processing-history__heading">
            <div>
              <h2>测试历史</h2>
              <p>成功、失败和取消都会保存为本地终态快照；详情和调用轨迹按需读取。</p>
            </div>
            <strong>{props.runs.length}</strong>
          </div>
          <Show
            when={!props.loading}
            fallback={<div class="processing-history__empty">正在读取测试历史…</div>}
          >
            <Show
              when={props.runs.length}
              fallback={<div class="processing-history__empty">还没有终态链路测试。</div>}
            >
              <div class="processing-history__list">
                <For each={props.runs}>{(run) => (
                  <article class={`processing-history-run processing-history-run--${run.status}`} data-testid={`history-run-${run.runId}`}>
                    <div class="processing-history-run__heading">
                      <div>
                        <h3>{run.sessionTitle || '未命名 Session'}</h3>
                        <p>{run.sourceDisplayName || 'Session 尚未解析'}{run.projectPath ? ` · ${run.projectPath}` : ''}</p>
                      </div>
                      <time>{statusLabel(run.status)} · {formatTime(run.completedAt)}</time>
                    </div>
                    <div class="processing-history-run__metrics">
                      <span><strong>{run.statementCount}</strong> Statements</span>
                      <span><strong>{formatDuration(run.durationMs)}</strong> 耗时</span>
                      <span><strong>{run.agentRunCount}</strong> Agent Runs</span>
                      <span><strong>{run.modelCallCount}</strong> Model Calls</span>
                    </div>
                    <div class="processing-history-run__models">
                      <span>知识维护 · {run.maintainerModel}</span>
                    </div>
                    <Show when={run.error}><p class="agent-trace-error">{run.error}</p></Show>
                    <div class="processing-history-run__actions">
                      <Button
                        variant="secondary"
                        icon="link"
                        disabled={props.loadingRunId === run.runId}
                        data-testid={`open-history-activity-${run.runId}`}
                        onClick={() => void open(run.runId, 'activity')}
                      >运行详情</Button>
                      <Button
                        variant="primary"
                        icon="layers"
                        disabled={run.status !== 'completed' || props.loadingRunId === run.runId}
                        data-testid={`open-history-result-${run.runId}`}
                        onClick={() => void open(run.runId, 'result')}
                      >{props.loadingRunId === run.runId ? '正在读取…' : '查看结果'}</Button>
                    </div>
                  </article>
                )}</For>
              </div>
            </Show>
          </Show>
        </section>
      </Show>

      <Show when={page() === 'activity' && props.selected ? props.selected : undefined}>
        {(record) => <FullChainActivityDetail
          runs={record().agentRuns}
          status={record().status}
          error={record().error}
          title="历史运行详情"
          description="这是该次测试结束时保存的模型与工具调用快照。"
          backLabel="返回历史"
          detailTestId="history-run-activity-detail"
          backTestId="history-run-activity-back"
          onBack={() => setPage('list')}
        />}
      </Show>

      <Show when={page() === 'result' && props.selected?.status === 'completed' && props.selected.result
        ? props.selected
        : undefined}>
        {(record) => <FullChainResultDetail
          result={fullChainResultView(record().result!)}
          title="历史结果快照"
          description="这是该次测试完成时保存的隔离结果，不会随当前知识库变化。"
          listLabel="历史 Statements"
          backLabel="返回历史"
          detailTestId="history-run-result-detail"
          backTestId="history-run-result-back"
          importTestId="import-history-run"
          importing={props.importingRunId === record().runId}
          importResult={props.importResult?.runId === record().runId
            ? props.importResult.commit
            : undefined}
          onBack={() => setPage('list')}
          onImport={() => void props.onImport(record().runId)}
        />}
      </Show>
    </div>
  )
}

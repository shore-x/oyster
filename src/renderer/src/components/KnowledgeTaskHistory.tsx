import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js'
import type {
  KnowledgeTaskDetail,
  KnowledgeTaskSummary
} from '../../../shared/knowledge-processing'
import { Button, Icon } from '../ui'
import {
  KnowledgeTaskActivityDetail,
  KnowledgeTaskResultDetail,
  knowledgeTaskResultView
} from './KnowledgeTaskDetails'

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN')
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs} ms`
  return `${(durationMs / 1_000).toFixed(1)} s`
}

function statusLabel(status: KnowledgeTaskSummary['status']): string {
  if (status === 'completed') return '已完成'
  if (status === 'abandoned') return '已放弃'
  return '可继续'
}

export function KnowledgeTaskHistory(props: {
  tasks: KnowledgeTaskSummary[]
  loading: boolean
  selected?: KnowledgeTaskDetail
  loadingTaskId?: string
  onOpen(taskId: string): Promise<KnowledgeTaskDetail | undefined>
}) {
  const [detail, setDetail] = createSignal<'activity' | 'result'>()

  createEffect(() => {
    if (detail() && !props.selected) setDetail(undefined)
  })

  createEffect(() => {
    if (!detail()) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setDetail(undefined)
    }
    document.addEventListener('keydown', closeOnEscape)
    onCleanup(() => document.removeEventListener('keydown', closeOnEscape))
  })

  async function open(taskId: string, target: 'activity' | 'result'): Promise<void> {
    if (await props.onOpen(taskId)) setDetail(target)
  }

  return (
    <div class="processing-history" data-testid="knowledge-task-history">
      <section class="processing-history__overview">
          <div class="processing-history__heading">
            <div>
              <h2>测试历史</h2>
              <p>Task、领域变化和 Agent Session 由同一 Git 历史保存；执行失败不会自动终结 Task。</p>
            </div>
            <strong>{props.tasks.length}</strong>
          </div>
          <Show
            when={!props.loading}
            fallback={<div class="processing-history__empty">正在读取测试历史…</div>}
          >
            <Show
              when={props.tasks.length}
              fallback={<div class="processing-history__empty">还没有 Knowledge Processing Task。</div>}
            >
              <div class="processing-history__list">
                <For each={props.tasks}>{(task) => (
                  <article class={`processing-history-task processing-history-task--${task.status}`} data-testid={`history-task-${task.taskId}`}>
                    <div class="processing-history-task__heading">
                      <div>
                        <h3>{task.sourceConversationTitle || '未命名 Source Conversation'}</h3>
                        <p>{task.sourceDisplayName || 'Source Conversation 尚未解析'}{task.projectPath ? ` · ${task.projectPath}` : ''}</p>
                      </div>
                      <time>{statusLabel(task.status)} · {formatTime(task.updatedAt)}</time>
                    </div>
                    <div class="processing-history-task__metrics">
                      <span><strong>{task.statementCount}</strong> Statements</span>
                      <span><strong>{formatDuration(task.durationMs)}</strong> 耗时</span>
                      <span><strong>{task.agentInvocationCount}</strong> Agent Invocations</span>
                      <span><strong>{task.modelCallCount}</strong> Model Calls</span>
                    </div>
                    <div class="processing-history-task__models">
                      <span>知识维护 · {task.maintainerModel}</span>
                    </div>
                    <Show when={task.error}><p class="agent-activity-error">{task.error}</p></Show>
                    <div class="processing-history-task__actions">
                      <Button
                        variant="secondary"
                        icon="link"
                        disabled={props.loadingTaskId === task.taskId}
                        data-testid={`open-history-activity-${task.taskId}`}
                        onClick={() => void open(task.taskId, 'activity')}
                      >Invocation 详情</Button>
                      <Button
                        variant="primary"
                        icon="layers"
                        disabled={task.status !== 'completed' || props.loadingTaskId === task.taskId}
                        data-testid={`open-history-result-${task.taskId}`}
                        onClick={() => void open(task.taskId, 'result')}
                      >{props.loadingTaskId === task.taskId ? '正在读取…' : '查看结果'}</Button>
                    </div>
                  </article>
                )}</For>
              </div>
            </Show>
          </Show>
      </section>

      <Show when={detail() && props.selected ? props.selected : undefined}>
        {(record) => (
          <aside class="processing-history__inspector" role="complementary" aria-label="历史详情">
            <div class="processing-history__inspector-toolbar">
              <strong>{detail() === 'activity' ? 'Invocation 详情' : '结果快照'}</strong>
              <button
                type="button"
                data-testid={detail() === 'activity' ? 'history-task-activity-back' : 'history-task-result-back'}
                aria-label="关闭历史详情"
                onClick={() => setDetail(undefined)}
              ><Icon name="close" /><span>关闭</span></button>
            </div>
            <div class="processing-history__inspector-content">
              <Show when={detail() === 'activity'}>
                <KnowledgeTaskActivityDetail
                  invocations={record().invocationDebugRecords}
                  status={record().status}
                  error={record().lastError}
                  title="历史 Agent Invocations"
                  description="这是该 Task 已保存的模型与工具调用记录。"
                  detailTestId="history-task-activity-detail"
                />
              </Show>
              <Show when={detail() === 'result' && record().status === 'completed' && record().result}>
                <KnowledgeTaskResultDetail
                  result={knowledgeTaskResultView(record().result!)}
                  title="历史结果快照"
                  description="这是该次测试结束时保存的已批准 Git revision；它没有合并到目标分支。"
                  listLabel="历史 Statements"
                  detailTestId="history-task-result-detail"
                />
              </Show>
            </div>
          </aside>
        )}
      </Show>
    </div>
  )
}

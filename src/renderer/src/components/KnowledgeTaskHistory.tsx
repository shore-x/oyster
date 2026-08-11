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
import { appLanguage, uiText } from '../i18n'

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(appLanguage())
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs} ms`
  return `${(durationMs / 1_000).toFixed(1)} s`
}

function statusLabel(status: KnowledgeTaskSummary['status']): string {
  if (status === 'completed') return uiText('已完成', 'Completed')
  if (status === 'abandoned') return uiText('已放弃', 'Abandoned')
  return uiText('可继续', 'Can Continue')
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
              <h2>{uiText('测试历史', 'Test History')}</h2>
              <p>{uiText(
                'Task、领域变化和 Agent Session 由同一 Git 历史保存；执行失败不会自动终结 Task。',
                'Tasks, domain changes, and Agent Sessions share the same Git history; execution failures do not automatically end a Task.'
              )}</p>
            </div>
            <strong>{props.tasks.length}</strong>
          </div>
          <Show
            when={!props.loading}
            fallback={<div class="processing-history__empty">{uiText('正在读取测试历史…', 'Reading test history…')}</div>}
          >
            <Show
              when={props.tasks.length}
              fallback={<div class="processing-history__empty">{uiText('还没有 Knowledge Processing Task。', 'No Knowledge Processing Tasks yet.')}</div>}
            >
              <div class="processing-history__list">
                <For each={props.tasks}>{(task) => (
                  <article class={`processing-history-task processing-history-task--${task.status}`} data-testid={`history-task-${task.taskId}`}>
                    <div class="processing-history-task__heading">
                      <div>
                        <h3>{task.sourceConversationTitle || uiText('未命名 Source Conversation', 'Untitled Source Conversation')}</h3>
                        <p>{task.sourceDisplayName || uiText('Source Conversation 尚未解析', 'Source Conversation not resolved')}{task.projectPath ? ` · ${task.projectPath}` : ''}</p>
                      </div>
                      <time>{statusLabel(task.status)} · {formatTime(task.updatedAt)}</time>
                    </div>
                    <div class="processing-history-task__metrics">
                      <span><strong>{task.statementCount}</strong> Statements</span>
                      <span><strong>{formatDuration(task.durationMs)}</strong> {uiText('耗时', 'duration')}</span>
                      <span><strong>{task.agentInvocationCount}</strong> Agent Invocations</span>
                      <span><strong>{task.modelCallCount}</strong> Model Calls</span>
                    </div>
                    <div class="processing-history-task__models">
                      <span>{uiText('知识维护', 'Knowledge Maintenance')} · {task.maintainerModel}</span>
                    </div>
                    <Show when={task.error}><p class="agent-activity-error">{task.error}</p></Show>
                    <div class="processing-history-task__actions">
                      <Button
                        variant="secondary"
                        icon="link"
                        disabled={props.loadingTaskId === task.taskId}
                        data-testid={`open-history-activity-${task.taskId}`}
                        onClick={() => void open(task.taskId, 'activity')}
                      >{uiText('Invocation 详情', 'Invocation Details')}</Button>
                      <Button
                        variant="primary"
                        icon="layers"
                        disabled={task.status !== 'completed' || props.loadingTaskId === task.taskId}
                        data-testid={`open-history-result-${task.taskId}`}
                        onClick={() => void open(task.taskId, 'result')}
                      >{props.loadingTaskId === task.taskId ? uiText('正在读取…', 'Reading…') : uiText('查看结果', 'View Result')}</Button>
                    </div>
                  </article>
                )}</For>
              </div>
            </Show>
          </Show>
      </section>

      <Show when={detail() && props.selected ? props.selected : undefined}>
        {(record) => (
          <aside class="processing-history__inspector" role="complementary" aria-label={uiText('历史详情', 'History details')}>
            <div class="processing-history__inspector-toolbar">
              <strong>{detail() === 'activity' ? uiText('Invocation 详情', 'Invocation Details') : uiText('结果快照', 'Result Snapshot')}</strong>
              <button
                type="button"
                data-testid={detail() === 'activity' ? 'history-task-activity-back' : 'history-task-result-back'}
                aria-label={uiText('关闭历史详情', 'Close history details')}
                onClick={() => setDetail(undefined)}
              ><Icon name="close" /><span>{uiText('关闭', 'Close')}</span></button>
            </div>
            <div class="processing-history__inspector-content">
              <Show when={detail() === 'activity'}>
                <KnowledgeTaskActivityDetail
                  invocations={record().invocationDebugRecords}
                  status={record().status}
                  error={record().lastError}
                  title={uiText('历史 Agent Invocations', 'Historical Agent Invocations')}
                  description={uiText('这是该 Task 已保存的模型与工具调用记录。', 'These are the model and tool call records saved for this Task.')}
                  detailTestId="history-task-activity-detail"
                />
              </Show>
              <Show when={detail() === 'result' && record().status === 'completed' && record().result}>
                <KnowledgeTaskResultDetail
                  result={knowledgeTaskResultView(record().result!)}
                  title={uiText('历史结果快照', 'Historical Result Snapshot')}
                  description={uiText('这是该次测试结束时保存的已批准 Git revision；它没有合并到目标分支。', 'This is the approved Git revision saved when the test ended; it was not merged into the target branch.')}
                  listLabel={uiText('历史 Statements', 'Historical Statements')}
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

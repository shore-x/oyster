import { For, Show, createEffect, createSignal } from 'solid-js'
import type {
  KnowledgeTaskDetail,
  KnowledgeTaskSummary
} from '../../../shared/knowledge-processing'
import { Button, Inspector } from '../ui'
import {
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
  if (status === 'completed') return uiText('已合并', 'Integrated')
  return uiText('仍在 Task 分支', 'Still on Task Branch')
}

export function KnowledgeTaskHistory(props: {
  tasks: KnowledgeTaskSummary[]
  loading: boolean
  selected?: KnowledgeTaskDetail
  loadingTaskId?: string
  onOpen(taskId: string): Promise<KnowledgeTaskDetail | undefined>
}) {
  const [resultOpen, setResultOpen] = createSignal(false)

  createEffect(() => {
    if (resultOpen() && !props.selected) setResultOpen(false)
  })

  async function open(taskId: string): Promise<void> {
    if (await props.onOpen(taskId)) setResultOpen(true)
  }

  return (
    <div class="processing-history" data-testid="knowledge-task-history">
      <section class="processing-history__overview">
          <div class="processing-history__heading">
            <div>
              <h2>{uiText('Task 历史', 'Task History')}</h2>
              <p>{uiText(
                '已完成的 Task 已由 Reviewer 合并到 main；open Task 的修改仍保留在各自的 Task 分支。',
                'Completed Tasks were integrated into main by the Reviewer. Changes from open Tasks remain on their Task branches.'
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
                      <span><strong>{task.changedPathCount}</strong> {uiText('变更文件', 'Changed Files')}</span>
                      <span><strong>{formatDuration(task.durationMs)}</strong> {uiText('耗时', 'duration')}</span>
                    </div>
                    <div class="processing-history-task__models">
                      <span>{uiText('知识维护', 'Knowledge Maintenance')} · {task.maintainerModel}</span>
                    </div>
                    <div class="processing-history-task__actions">
                      <Button
                        variant="primary"
                        icon="layers"
                        disabled={task.status !== 'completed' || props.loadingTaskId === task.taskId}
                        data-testid={`open-history-result-${task.taskId}`}
                        onClick={() => void open(task.taskId)}
                      >{props.loadingTaskId === task.taskId
                          ? uiText('正在读取…', 'Reading…')
                          : task.status === 'completed'
                            ? uiText('查看结果', 'View Result')
                            : uiText('合并后可查看', 'Available After Integration')}</Button>
                    </div>
                  </article>
                )}</For>
              </div>
            </Show>
          </Show>
      </section>

      <Show when={resultOpen() && props.selected ? props.selected : undefined}>
        {(record) => (
          <Inspector
            class="processing-history__inspector"
            size="wide"
            ariaLabel={uiText('历史详情', 'History details')}
            title={uiText('已合并结果', 'Integrated Result')}
            closeLabel={uiText('关闭', 'Close')}
            closeTestId="history-task-result-back"
            onClose={() => setResultOpen(false)}
            contentClass="processing-history__inspector-content"
          >
              <Show when={record().status === 'completed' && record().result}>
                <KnowledgeTaskResultDetail
                  result={knowledgeTaskResultView(record().result!)}
                  title={uiText('历史合并结果', 'Historical Integrated Result')}
                  description={uiText(
                    '这是该 Task 合并到 main 后记录的 revision 与文件变更；请前往知识库或工作台浏览当前内容。',
                    'These are the revision and file changes recorded after the Task was integrated into main. Browse current content in Knowledge or Workbench.'
                  )}
                  detailTestId="history-task-result-detail"
                />
              </Show>
          </Inspector>
        )}
      </Show>
    </div>
  )
}

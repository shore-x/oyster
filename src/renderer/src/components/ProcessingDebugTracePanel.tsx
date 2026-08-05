import { For, Show, createEffect, createMemo, createSignal } from 'solid-js'
import type {
  KnowledgeMaintenanceTraceEvent,
  KnowledgeProcessingDebugTrace,
  ProcessingDebugStatus
} from '../../../shared/knowledge-processing'
import { Markdown } from '../ui'

function formatDuration(durationMs?: number): string {
  if (durationMs === undefined) return '进行中'
  if (durationMs < 1_000) return `${durationMs} ms`
  return `${(durationMs / 1_000).toFixed(1)} s`
}

function statusLabel(status: ProcessingDebugStatus): string {
  if (status === 'running') return '运行中'
  if (status === 'completed') return '已完成'
  if (status === 'cancelled') return '已取消'
  return '失败'
}

function eventMeta(event: KnowledgeMaintenanceTraceEvent): string {
  return `${statusLabel(event.status)} · ${formatDuration(event.durationMs)}`
}

function MaintenanceTimeline(props: {
  maintenance: KnowledgeProcessingDebugTrace['maintenance']
}) {
  return (
    <section class="processing-debug__stage" aria-label="知识维护 Agent 调试详情">
      <div class="processing-debug__stage-heading">
        <div>
          <h4>Knowledge Maintenance Agent</h4>
          <p>展示模型轮次与经过筛选的工具事件</p>
        </div>
        <span>{props.maintenance.modelCallCount} 次模型 · {props.maintenance.toolCallCount} 次工具</span>
      </div>
      <Show when={props.maintenance.workspace}>
        {(workspace) => (
          <div class="processing-debug-workspace" data-testid="maintenance-workspace-status">
            <div><span>待处理 Todo</span><strong>{workspace().todos.pending}</strong></div>
            <div><span>已完成 Todo</span><strong>{workspace().todos.completed}</strong></div>
            <div><span>Todo 总数</span><strong>{workspace().todos.total}</strong></div>
            <div><span>待写入知识</span><strong>{workspace().draftStatementCount}</strong></div>
          </div>
        )}
      </Show>
      <Show
        when={props.maintenance.events.length}
        fallback={<div class="processing-debug__empty">Agent 启动后，模型与工具事件会显示在这里。</div>}
      >
        <ol class="processing-debug-timeline">
          <For each={props.maintenance.events}>{(event) => (
            <li class={`processing-debug-status--${event.status}`} data-testid={`maintenance-event-${event.sequence}`}>
              <span class="processing-debug__marker" aria-hidden="true" />
              <div>
                <div class="processing-debug-timeline__heading">
                  <strong>{event.label}</strong>
                  <span>{eventMeta(event)}</span>
                </div>
                <p>{event.kind === 'model_call' ? '模型调用' : 'Agent 工具调用'}</p>
                <Show when={
                  event.kind === 'tool_call'
                  && event.detail
                  && event.label !== '读取原始观察证据'
                    ? event.detail
                    : undefined
                }>
                  {(detail) => <code>{detail()}</code>}
                </Show>
              </div>
            </li>
          )}</For>
        </ol>
      </Show>
    </section>
  )
}

export function ProcessingDebugTracePanel(props: {
  trace: KnowledgeProcessingDebugTrace
  title?: string
}) {
  return (
    <section class={`processing-debug-panel processing-debug-status--${props.trace.status}`} data-testid="processing-debug-trace">
      <div class="processing-debug__heading">
        <div>
          <span class="processing-debug__marker" aria-hidden="true" />
          <div><h3>{props.title ?? '运行调试'}</h3></div>
        </div>
        <span class="processing-debug__status">{statusLabel(props.trace.status)}</span>
      </div>
      <Show when={props.trace.error}>
        {(error) => <p class="processing-debug__error">{error()}</p>}
      </Show>
      <div class="processing-debug__stages">
        <MaintenanceTimeline maintenance={props.trace.maintenance} />
      </div>
    </section>
  )
}

interface TraceExplorerEntry {
  key: string
  stage: '知识维护'
  kind: '模型调用' | '工具调用'
  label: string
  status: ProcessingDebugStatus
  durationMs?: number
  detail?: string
  input?: string
  inputTruncated?: boolean
  output?: string
  outputTruncated?: boolean
}

function compactPreview(value?: string): string | undefined {
  if (!value) return undefined
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length > 120 ? `${compact.slice(0, 119)}…` : compact
}

function traceExplorerEntries(trace: KnowledgeProcessingDebugTrace): TraceExplorerEntry[] {
  return trace.maintenance.events.map((event) => ({
    key: `maintenance:${event.id}`,
    stage: '知识维护',
    kind: event.kind === 'model_call' ? '模型调用' : '工具调用',
    label: event.label,
    status: event.status,
    durationMs: event.durationMs,
    detail: event.detail,
    input: event.input,
    inputTruncated: event.inputTruncated,
    output: event.output,
    outputTruncated: event.outputTruncated
  }))
}

export function ProcessingTraceExplorer(props: { trace: KnowledgeProcessingDebugTrace }) {
  const entries = createMemo(() => traceExplorerEntries(props.trace))
  const [selectedKey, setSelectedKey] = createSignal<string>()
  const selected = createMemo(() => (
    entries().find((entry) => entry.key === selectedKey()) ?? entries()[0]
  ))
  const modelCalls = createMemo(() => entries().filter((entry) => entry.kind === '模型调用').length)
  const toolCalls = createMemo(() => entries().filter((entry) => entry.kind === '工具调用').length)

  createEffect(() => {
    const current = selectedKey()
    if (current && entries().some((entry) => entry.key === current)) return
    const preferred = entries().find((entry) => entry.status === 'failed')
      ?? entries().find((entry) => entry.status === 'running')
      ?? entries()[0]
    setSelectedKey(preferred?.key)
  })

  return (
    <section class="trace-explorer" data-testid="processing-trace-explorer">
      <div class="trace-explorer__summary">
        <div><span>事件总数</span><strong>{entries().length}</strong></div>
        <div><span>模型调用</span><strong>{modelCalls()}</strong></div>
        <div><span>工具调用</span><strong>{toolCalls()}</strong></div>
        <div><span>运行状态</span><strong>{statusLabel(props.trace.status)}</strong></div>
      </div>

      <Show
        when={entries().length}
        fallback={<div class="trace-explorer__empty">运行产生模型或工具事件后，可以在这里逐项检查。</div>}
      >
        <div class="trace-explorer__workspace">
          <div class="trace-explorer__events" role="listbox" aria-label="模型与工具调用">
            <For each={entries()}>{(entry) => (
              <button
                type="button"
                class={`trace-explorer-event processing-debug-status--${entry.status}`}
                role="option"
                aria-selected={selected()?.key === entry.key}
                data-testid={`trace-explorer-event-${entry.key.replace(':', '-')}`}
                onClick={() => setSelectedKey(entry.key)}
              >
                <span class="processing-debug__marker" aria-hidden="true" />
                <span class="trace-explorer-event__body">
                  <span>{entry.stage} · {entry.kind}</span>
                  <strong>{entry.label}</strong>
                  <small>{compactPreview(entry.output) ?? entry.detail ?? (entry.status === 'running' ? '正在等待结果…' : '没有可展示的输出')}</small>
                </span>
                <span class="trace-explorer-event__meta">{formatDuration(entry.durationMs)}</span>
              </button>
            )}</For>
          </div>

          <Show when={selected()}>
            {(entry) => (
              <article class="trace-explorer__detail" data-testid="trace-explorer-event-detail">
                <div class="trace-explorer__detail-heading">
                  <div>
                    <span>{entry().stage} · {entry().kind}</span>
                    <h3>{entry().label}</h3>
                  </div>
                  <span class={`chain-test__status chain-test__status--${entry().status}`}>
                    {statusLabel(entry().status)} · {formatDuration(entry().durationMs)}
                  </span>
                </div>
                <Show when={entry().detail}>
                  {(detail) => <p class="trace-explorer__detail-summary">{detail()}</p>}
                </Show>
                <Show when={entry().input}>
                  {(input) => (
                    <section class="trace-explorer__payload">
                      <h4>工具参数</h4>
                      <pre data-testid="trace-explorer-event-input">{input()}</pre>
                      <Show when={entry().inputTruncated}><p>调试副本已在单次 I/O 边界截断。</p></Show>
                    </section>
                  )}
                </Show>
                <section class="trace-explorer__payload">
                  <h4>{entry().kind === '工具调用' ? '工具结果' : '模型输出'}</h4>
                  <Show
                    when={entry().output}
                    fallback={<div class="trace-explorer__payload-empty">{entry().status === 'running' ? '正在等待本次调用返回…' : '本次调用没有文本输出。'}</div>}
                  >
                    {(output) => entry().kind === '模型调用'
                      ? <Markdown class="trace-explorer__markdown-output" text={output()} testId="trace-explorer-event-output" />
                      : <pre data-testid="trace-explorer-event-output">{output()}</pre>}
                  </Show>
                  <Show when={entry().outputTruncated}>
                    <p>调试副本已在单次 I/O 边界截断；Agent 实际收到的内容未受影响。</p>
                  </Show>
                </section>
              </article>
            )}
          </Show>
        </div>
      </Show>
    </section>
  )
}

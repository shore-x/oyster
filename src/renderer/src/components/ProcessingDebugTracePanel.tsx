import { For, Show, createEffect, createMemo, createSignal } from 'solid-js'
import type {
  KnowledgeMaintenanceTraceEvent,
  KnowledgeProcessingDebugTrace,
  PreprocessingModelCallTrace,
  ProcessingDebugStatus
} from '../../../shared/knowledge-processing'
import { Markdown } from '../ui'

function formatDuration(durationMs?: number): string {
  if (durationMs === undefined) return '进行中'
  if (durationMs < 1_000) return `${durationMs} ms`
  return `${(durationMs / 1_000).toFixed(1)} s`
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KiB`
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`
}

function statusLabel(status: ProcessingDebugStatus): string {
  if (status === 'running') return '运行中'
  if (status === 'completed') return '已完成'
  if (status === 'cancelled') return '已取消'
  return '失败'
}

function phaseLabel(phase: NonNullable<KnowledgeProcessingDebugTrace['preprocessing']>['phase']): string {
  if (phase === 'preparing') return '准备分段'
  if (phase === 'discovering') return '发现 Statement 候选'
  return '预处理完成'
}

function callLabel(call: PreprocessingModelCallTrace): string {
  return `Statement 候选发现 · 分段 ${call.sequence}`
}

function visiblePreprocessingOutput(output: string): string {
  try {
    const parsed = JSON.parse(output) as { candidates?: unknown }
    if (!Array.isArray(parsed.candidates)) return output
    return JSON.stringify({
      ...parsed,
      candidates: parsed.candidates.map((candidate) => {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return candidate
        const {
          locations: _locations,
          evidenceLocations: _evidenceLocations,
          selectors: _selectors,
          ...visible
        } = candidate as Record<string, unknown>
        return visible
      })
    }, null, 2)
  } catch {
    return output.replace(/L\d{6}(?:(?:\s+|:)C\d+(?::\d+(?:\/\d+)?)?)?(?:\s*-\s*L\d{6}(?:(?:\s+|:)C\d+(?::\d+(?:\/\d+)?)?)?)?/g, '原始证据')
  }
}

function PreprocessingCalls(props: {
  preprocessing: NonNullable<KnowledgeProcessingDebugTrace['preprocessing']>
}) {
  const totalSegments = () => props.preprocessing.totalSegments ?? 0
  const completedCalls = createMemo(() => props.preprocessing.calls.filter(
    (call) => call.status === 'completed'
  ).length)

  return (
    <section class="processing-debug__stage" aria-label="观察预处理调试详情">
      <div class="processing-debug__stage-heading">
        <div>
          <h4>Observation Preprocessor</h4>
          <p>{phaseLabel(props.preprocessing.phase)}</p>
        </div>
        <span>{completedCalls()} / {props.preprocessing.calls.length} 次调用完成</span>
      </div>

      <Show when={props.preprocessing.view}>
        {(view) => (
          <div class="processing-debug__progress" data-testid="preprocessing-view-summary">
            <div>
              <span>模型输入材料</span>
              <strong>{view().selectedUnitCount} 个对话单元</strong>
            </div>
            <p>
              约 {formatBytes(view().modelMaterialBytes)}，低层执行细节仍可由 Agent 按需读取。
            </p>
          </div>
        )}
      </Show>

      <div class="processing-debug__progress">
        <div>
          <span>Observation 分段</span>
          <strong>
            {props.preprocessing.completedSegments}
            {totalSegments() ? ` / ${totalSegments()}` : ''}
          </strong>
        </div>
        <progress
          data-testid="preprocessing-segment-progress"
          max={Math.max(1, totalSegments())}
          value={Math.min(props.preprocessing.completedSegments, Math.max(1, totalSegments()))}
        />
      </div>

      <Show
        when={props.preprocessing.calls.length}
        fallback={<div class="processing-debug__empty">分段完成后，模型调用会依次显示在这里。</div>}
      >
        <div class="processing-debug__calls">
          <For each={props.preprocessing.calls}>{(call) => (
            <details
              class={`processing-debug-call processing-debug-status--${call.status}`}
              open={call.status === 'running' || call.status === 'failed' || call.status === 'cancelled'}
              data-testid={`preprocessing-call-${call.sequence}`}
            >
              <summary>
                <span class="processing-debug__marker" aria-hidden="true" />
                <span class="processing-debug-call__identity">
                  <strong>{callLabel(call)}</strong>
                  <small>从本段原始观察中发现需要知识维护 Agent 裁决的名称与指代问题</small>
                </span>
                <span class="processing-debug-call__meta">
                  {statusLabel(call.status)} · {formatDuration(call.durationMs)}
                </span>
              </summary>
              <Show when={call.output}>
                {(output) => (
                  <div class="processing-debug-call__body">
                    <span>模型输出</span>
                    <pre>{visiblePreprocessingOutput(output())}</pre>
                    <Show when={call.outputTruncated}>
                      <p class="processing-debug-call__notice">调试副本已截断；实际候选发现结果未受影响。</p>
                    </Show>
                  </div>
                )}
              </Show>
              <Show when={call.error}>
                {(error) => <p class="processing-debug__error">{error()}</p>}
              </Show>
              <Show when={!call.output && !call.error && call.status === 'running'}>
                <p class="processing-debug-call__waiting">正在等待本次模型调用返回…</p>
              </Show>
            </details>
          )}</For>
        </div>
      </Show>
    </section>
  )
}

function eventMeta(event: KnowledgeMaintenanceTraceEvent): string {
  return `${statusLabel(event.status)} · ${formatDuration(event.durationMs)}`
}

function MaintenanceTimeline(props: {
  maintenance: NonNullable<KnowledgeProcessingDebugTrace['maintenance']>
}) {
  return (
    <section class="processing-debug__stage" aria-label="知识维护 Agent 调试详情">
      <div class="processing-debug__stage-heading">
        <div>
          <h4>Knowledge Maintenance Agent</h4>
          <p>仅展示模型轮次与经过筛选的安全工具事件</p>
        </div>
        <span>{props.maintenance.modelCallCount} 次模型 · {props.maintenance.toolCallCount} 次工具</span>
      </div>
      <Show when={props.maintenance.workspace}>
        {(workspace) => (
          <div class="processing-debug-workspace" data-testid="maintenance-workspace-status">
            <div>
              <span>待裁决候选</span>
              <strong>{workspace().candidates.open}</strong>
            </div>
            <div>
              <span>已裁决候选</span>
              <strong>{workspace().candidates.resolved}</strong>
            </div>
            <div>
              <span>候选总数</span>
              <strong>{workspace().candidates.total}</strong>
            </div>
            <div>
              <span>待写入知识</span>
              <strong>{workspace().draftStatementCount}</strong>
            </div>
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

export interface ProcessingDebugTracePanelProps {
  trace: KnowledgeProcessingDebugTrace
  showPreprocessing?: boolean
  showMaintenance?: boolean
  title?: string
}

export function ProcessingDebugTracePanel(props: ProcessingDebugTracePanelProps) {
  const showPreprocessing = () => props.showPreprocessing !== false && Boolean(props.trace.preprocessing)
  const showMaintenance = () => props.showMaintenance !== false && Boolean(props.trace.maintenance)

  return (
    <section class={`processing-debug-panel processing-debug-status--${props.trace.status}`} data-testid="processing-debug-trace">
      <div class="processing-debug__heading">
        <div>
          <span class="processing-debug__marker" aria-hidden="true" />
          <div>
            <h3>{props.title ?? '运行调试'}</h3>
          </div>
        </div>
        <span class="processing-debug__status">{statusLabel(props.trace.status)}</span>
      </div>
      <Show when={showPreprocessing()}>
        <p class="processing-debug__disclosure">模型输出可能复述原始材料，仅用于当前本地调试，不作为知识或审计记录。</p>
      </Show>
      <Show when={props.trace.error}>
        {(error) => <p class="processing-debug__error">{error()}</p>}
      </Show>
      <div class="processing-debug__stages">
        <Show when={showPreprocessing() && props.trace.preprocessing}>
          <PreprocessingCalls preprocessing={props.trace.preprocessing!} />
        </Show>
        <Show when={showMaintenance() && props.trace.maintenance}>
          <MaintenanceTimeline maintenance={props.trace.maintenance!} />
        </Show>
      </div>
    </section>
  )
}

interface TraceExplorerEntry {
  key: string
  stage: '观察预处理' | '知识维护'
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
  const preprocessing = trace.preprocessing?.calls.map((call) => ({
    key: `preprocessing:${call.id}`,
    stage: '观察预处理' as const,
    kind: '模型调用' as const,
    label: callLabel(call),
    status: call.status,
    durationMs: call.durationMs,
    detail: '从当前分段发现需要知识维护 Agent 裁决的名称与指代问题',
    output: call.output ? visiblePreprocessingOutput(call.output) : undefined,
    outputTruncated: call.outputTruncated
  })) ?? []
  const maintenance = trace.maintenance?.events.map((event) => ({
    key: `maintenance:${event.id}`,
    stage: '知识维护' as const,
    kind: event.kind === 'model_call' ? '模型调用' as const : '工具调用' as const,
    label: event.label,
    status: event.status,
    durationMs: event.durationMs,
    detail: event.detail,
    input: event.input,
    inputTruncated: event.inputTruncated,
    output: event.output,
    outputTruncated: event.outputTruncated
  })) ?? []
  return [...preprocessing, ...maintenance]
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
                      <Show when={entry().inputTruncated}>
                        <p>调试副本已在单次 I/O 边界截断。</p>
                      </Show>
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
                      ? (
                          <Markdown
                            class="trace-explorer__markdown-output"
                            text={output()}
                            testId="trace-explorer-event-output"
                          />
                        )
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

import { For, Show, createMemo } from 'solid-js'
import type {
  KnowledgeMaintenanceTraceEvent,
  KnowledgeProcessingDebugTrace,
  PreprocessingModelCallTrace,
  ProcessingDebugStatus
} from '../../../shared/knowledge-processing'

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
  if (phase === 'mapping') return '生成局部地图'
  if (phase === 'assembling') return '组装导航地图'
  return '预处理完成'
}

function callLabel(call: PreprocessingModelCallTrace): string {
  const ranges = call.selectors.join(', ')
  const location = `L${String(call.readLocation.line).padStart(6, '0')}:C${call.readLocation.offset}`
  return call.kind === 'segment_map'
    ? `分段映射 · 读取起点 ${location} · 来源范围 ${ranges}`
    : `导航归并 · 首个读取起点 ${location} · 来源范围 ${ranges}`
}

function callSections(call: PreprocessingModelCallTrace): string {
  if (!call.sectionIds.length) return '无局部 Section'
  if (call.sectionIds.length <= 4) return call.sectionIds.join('、')
  return `${call.sectionIds.slice(0, 4).join('、')} 等 ${call.sectionIds.length} 个 Section`
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
              <span>选择性预处理视图</span>
              <strong>{view().selectedLineCount} / {view().sourceLineCount} 行</strong>
            </div>
            <p>
              {view().formatVersion} · 原始约 {formatBytes(view().sourceBytes)} ·
              {' '}{view().selectedUnitCount} 个单元 ·
              {' '}{formatBytes(view().modelMaterialBytes)} 模型材料 ·
              {' '}{formatBytes(view().selectedSourceBytes)} 选中范围原文
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
                  <strong>Call {call.sequence} · {callLabel(call)}</strong>
                  <small>{callSections(call)}</small>
                </span>
                <span class="processing-debug-call__meta">
                  {statusLabel(call.status)} · {formatDuration(call.durationMs)}
                </span>
              </summary>
              <Show when={call.output}>
                {(output) => (
                  <div class="processing-debug-call__body">
                    <span>模型输出</span>
                    <pre>{output()}</pre>
                    <Show when={call.outputTruncated}>
                      <p class="processing-debug-call__notice">调试副本已截断；实际 Evidence Map 处理未受影响。</p>
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
                <Show when={event.detail}>
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
            <p>Run <code>{props.trace.id}</code></p>
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

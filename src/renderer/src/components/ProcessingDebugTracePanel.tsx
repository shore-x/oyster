import { Show } from 'solid-js'
import type { KnowledgeProcessingDebugTrace } from '../../../shared/knowledge-processing'
import { AgentRunExplorer, agentRunStatusLabel } from './AgentRunView'

export function ProcessingDebugTracePanel(props: {
  trace: KnowledgeProcessingDebugTrace
  title?: string
}) {
  return (
    <section class={`processing-debug-panel agent-trace-status--${props.trace.run.status}`} data-testid="processing-debug-trace">
      <div class="processing-debug__heading">
        <div>
          <span class="processing-debug__marker" aria-hidden="true" />
          <div><h3>{props.title ?? '运行轨迹'}</h3></div>
        </div>
        <span class="processing-debug__status">{agentRunStatusLabel(props.trace.run.status)}</span>
      </div>
      <Show when={props.trace.workspace}>
        {(workspace) => (
          <div class="processing-debug-workspace" data-testid="maintenance-workspace-status">
            <div><span>待处理 Todo</span><strong>{workspace().todos.pending}</strong></div>
            <div><span>已完成 Todo</span><strong>{workspace().todos.completed}</strong></div>
            <div><span>Todo 总数</span><strong>{workspace().todos.total}</strong></div>
            <div><span>待写入知识</span><strong>{workspace().draftStatementCount}</strong></div>
          </div>
        )}
      </Show>
      <Show when={props.trace.run.error}>{(error) => <p class="processing-debug__error">{error()}</p>}</Show>
      <AgentRunExplorer run={props.trace.run} compact />
    </section>
  )
}

export function ProcessingTraceExplorer(props: { trace: KnowledgeProcessingDebugTrace }) {
  return <AgentRunExplorer run={props.trace.run} />
}

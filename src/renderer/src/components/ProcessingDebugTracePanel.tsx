import { Show } from 'solid-js'
import type { KnowledgeProcessingDebugTrace } from '../../../shared/knowledge-processing'
import { processingAgentDisplayName } from '../processing-agent-presentation'
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
      <Show when={props.trace.run.error}>{(error) => <p class="processing-debug__error">{error()}</p>}</Show>
      <AgentRunExplorer
        run={props.trace.run}
        agentDisplayName={processingAgentDisplayName(props.trace.run.agentId)}
        compact
      />
    </section>
  )
}

export function ProcessingTraceExplorer(props: { trace: KnowledgeProcessingDebugTrace }) {
  return <AgentRunExplorer
    run={props.trace.run}
    agentDisplayName={processingAgentDisplayName(props.trace.run.agentId)}
  />
}

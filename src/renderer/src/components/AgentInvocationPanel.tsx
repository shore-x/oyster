import { Show } from 'solid-js'
import type { LiveAgentInvocationView } from '../../../shared/knowledge-processing'
import { processingAgentDisplayName } from '../processing-agent-presentation'
import {
  AgentInvocationExplorer,
  agentInvocationStatusLabel
} from './AgentInvocationView'

export function AgentInvocationPanel(props: {
  view: LiveAgentInvocationView
  title?: string
}) {
  return (
    <section class={`agent-invocation-panel agent-activity-status--${props.view.invocation.status}`} data-testid="agent-preview-invocation">
      <div class="agent-invocation-panel__heading">
        <div>
          <span class="agent-activity__marker" aria-hidden="true" />
          <div><h3>{props.title ?? 'Agent Invocation'}</h3></div>
        </div>
        <span class="agent-invocation-panel__status">
          {agentInvocationStatusLabel(props.view.invocation.status)}
        </span>
      </div>
      <Show when={props.view.invocation.error}>{(error) => <p class="agent-invocation-panel__error">{error()}</p>}</Show>
      <AgentInvocationExplorer
        invocation={props.view.invocation}
        agentDisplayName={processingAgentDisplayName(props.view.invocation.agentId)}
        compact
      />
    </section>
  )
}

export function ProcessingInvocationExplorer(props: { view: LiveAgentInvocationView }) {
  return <AgentInvocationExplorer
    invocation={props.view.invocation}
    agentDisplayName={processingAgentDisplayName(props.view.invocation.agentId)}
  />
}

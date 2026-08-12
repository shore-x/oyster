import { renderToString } from 'solid-js/web'
import { describe, expect, it } from 'vitest'
import type { AgentInvocationRecord } from '../src/shared/agent-runtime'
import {
  AgentInvocationCollectionExplorer,
  AgentInvocationExplorer,
  AgentModelCallInspector
} from '../src/renderer/src/components/AgentInvocationView'
import { processingAgentDisplayName } from '../src/renderer/src/processing-agent-presentation'
import { completedAgentInvocation } from './agent-invocation-fixture'

function invocationWithAssistantMessage(agentId: string): AgentInvocationRecord {
  const invocation = completedAgentInvocation(`invocation:${agentId}`, [], 1, agentId)
  invocation.messages.push({
    id: `${invocation.invocationId}:assistant:1`,
    sequence: 1,
    status: 'completed',
    role: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Finished.' }] }
  })
  return invocation
}

describe('Agent Invocation view', () => {
  it('uses the business Agent name for the Invocation and assistant messages', () => {
    const invocation = invocationWithAssistantMessage('knowledge_maintainer')
    const html = renderToString(() => (
      <AgentInvocationExplorer invocation={invocation} agentDisplayName="Maintainer" />
    ))

    expect(html).toContain('Maintainer')
    expect(html).not.toContain('>Oyster<')
  })

  it('distinguishes Maintainer and Reviewer in one multi-Invocation selector', () => {
    const invocations = [
      completedAgentInvocation('invocation:maintainer', [], 1, 'knowledge_maintainer'),
      completedAgentInvocation('invocation:reviewer', [], 1, 'knowledge_reviewer')
    ]
    const html = renderToString(() => (
      <AgentInvocationCollectionExplorer
        invocations={invocations}
        agentDisplayName={(invocation) => processingAgentDisplayName(invocation.agentId)}
      />
    ))

    expect(html).toContain('Maintainer')
    expect(html).toContain('Reviewer')
    expect(html).not.toContain('knowledge_maintainer')
    expect(html).not.toContain('knowledge_reviewer')
  })

  it('shows the final Provider request and response in the model call inspector', () => {
    const call = completedAgentInvocation('invocation:provider', [], 1).modelCalls[0]
    call.providerRequest = {
      payload: { model: 'test-model', input: 'final payload' },
      headers: { authorization: '[redacted]' }
    }
    call.providerResponse = {
      status: 200,
      headers: { 'x-request-id': 'request-1' }
    }

    const html = renderToString(() => <AgentModelCallInspector call={call} index={0} />)

    expect(html).toContain('Provider Request（最终 Payload）')
    expect(html).toContain('final payload')
    expect(html).toContain('[redacted]')
    expect(html).toContain('request-1')
  })

  it('uses the shared Inspector when model-call handling stays local', () => {
    const invocation = completedAgentInvocation('invocation:inspector', [], 1)
    const html = renderToString(() => (
      <AgentInvocationExplorer invocation={invocation} />
    ))

    expect(html).not.toContain('data-testid="agent-invocation-inspector"')
    expect(html).not.toContain('agent-invocation-view__inspector-toolbar')
  })
})

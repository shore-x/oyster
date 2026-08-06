import { renderToString } from 'solid-js/web'
import { describe, expect, it } from 'vitest'
import type { AgentRunRecord } from '../src/shared/agent-runtime'
import {
  AgentRunCollectionExplorer,
  AgentRunExplorer
} from '../src/renderer/src/components/AgentRunView'
import { processingAgentDisplayName } from '../src/renderer/src/processing-agent-presentation'
import { completedAgentRun } from './agent-run-fixture'

function runWithAssistantMessage(agentId: string): AgentRunRecord {
  const run = completedAgentRun(`run:${agentId}`, [], 1, agentId)
  run.messages.push({
    id: `${run.id}:assistant:1`,
    sequence: 1,
    status: 'completed',
    role: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Finished.' }] }
  })
  return run
}

describe('Agent Run view', () => {
  it('uses the business Agent name for the run and assistant messages', () => {
    const run = runWithAssistantMessage('knowledge_maintenance_agent')
    const html = renderToString(() => (
      <AgentRunExplorer run={run} agentDisplayName="Maintainer" />
    ))

    expect(html).toContain('Maintainer')
    expect(html).not.toContain('>Oyster<')
  })

  it('distinguishes Maintainer and Reviewer in one multi-Run selector', () => {
    const runs = [
      completedAgentRun('run:maintainer', [], 1, 'knowledge_maintenance_agent'),
      completedAgentRun('run:reviewer', [], 1, 'knowledge_reviewer_agent')
    ]
    const html = renderToString(() => (
      <AgentRunCollectionExplorer
        runs={runs}
        agentDisplayName={(run) => processingAgentDisplayName(run.agentId)}
      />
    ))

    expect(html).toContain('Maintainer')
    expect(html).toContain('Reviewer')
    expect(html).not.toContain('knowledge_maintenance_agent')
    expect(html).not.toContain('knowledge_reviewer_agent')
  })
})

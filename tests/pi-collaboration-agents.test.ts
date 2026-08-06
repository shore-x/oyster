import { describe, expect, it } from 'vitest'
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
  type FauxResponseStep
} from '@earendil-works/pi-ai'
import type { ModelRuntime } from '../src/main/ai-backends/model'
import {
  PiKnowledgeMaintainerAgent,
  PiKnowledgeReviewerAgent
} from '../src/main/knowledge-processing/pi-collaboration-agents'
import type { CollaborationWorkspace } from '../src/main/knowledge-processing/collaboration-repository'
import type { AgentObservation } from '../src/main/observation/model'

const workspace: CollaborationWorkspace = {
  id: 'workspace-test',
  repositoryPath: '/tmp/oyster-collaboration-repository',
  worktreePath: '/tmp/oyster-collaboration-worktree',
  targetBranch: 'main',
  branchName: 'collaboration/test',
  baseRevision: 'a'.repeat(40),
  workOrderRevision: 'b'.repeat(40)
}

const observation: AgentObservation = {
  rawEvidence: {
    formatVersion: 'test-raw-v1',
    lines: ['raw line'],
    skillHints: []
  },
  canonicalActivity: {
    formatVersion: 'test-activity-v1',
    items: [{
      kind: 'user_message',
      content: 'canonical activity',
      rawRanges: [{
        start: { line: 1, offset: 0 },
        end: { line: 1, offset: 8 }
      }]
    }],
    attachments: []
  }
}

function fauxRuntime(responses: FauxResponseStep[]): ModelRuntime {
  const faux = fauxProvider()
  faux.setResponses(responses)
  const models = createModels()
  models.setProvider(faux.provider)
  return {
    model: { ...faux.getModel(), contextWindow: 128_000 },
    streamFn: (model, context, options) => models.streamSimple(model, context, options)
  }
}

function contextText(context: Context): string {
  return JSON.stringify(context.messages)
}

describe('Pi collaboration Agents', () => {
  it('gives the Maintainer coding and observation tools rooted in the collaboration task', async () => {
    const runtime = fauxRuntime([
      (context) => {
        expect(context.tools?.map((tool) => tool.name)).toEqual([
          'read', 'bash', 'edit', 'write',
          'read_activity', 'read_activity_attachment', 'read_evidence'
        ])
        expect(contextText(context)).toContain(workspace.worktreePath)
        expect(contextText(context)).toContain('.oyster/WORK.md')
        expect(contextText(context)).not.toContain('list_todos')
        return fauxAssistantMessage(
          fauxToolCall('read_activity', { activity: 1, offset: 0, limit: 100 }),
          { stopReason: 'toolUse' }
        )
      },
      (context) => {
        expect(contextText(context)).toContain('canonical activity')
        return fauxAssistantMessage('Maintainer handoff committed.')
      }
    ])

    const result = await new PiKnowledgeMaintainerAgent().run({
      runtime,
      systemPrompt: 'Maintain the collaboration tree.',
      workspace,
      observation,
      sourceRef: 'raw:test@revision',
      previousRevision: workspace.workOrderRevision,
      runId: 'maintainer-run',
      signal: new AbortController().signal
    })

    expect(result.toolCalls).toEqual(['read_activity'])
  })

  it('gives the Reviewer only coding tools and no observation or Todo access', async () => {
    const runtime = fauxRuntime([
      (context) => {
        expect(context.tools?.map((tool) => tool.name)).toEqual([
          'read', 'bash', 'edit', 'write'
        ])
        expect(contextText(context)).toContain(workspace.worktreePath)
        expect(contextText(context)).toContain('Exact revision to review')
        expect(contextText(context)).not.toContain('read_evidence')
        expect(contextText(context)).not.toContain('list_todos')
        return fauxAssistantMessage('Reviewer approval committed.')
      }
    ])

    const result = await new PiKnowledgeReviewerAgent().run({
      runtime,
      systemPrompt: 'Review the collaboration tree.',
      workspace,
      reviewedRevision: 'c'.repeat(40),
      runId: 'reviewer-run',
      signal: new AbortController().signal
    })

    expect(result.toolCalls).toEqual([])
  })
})

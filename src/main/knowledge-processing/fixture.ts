import type { AiBackendService } from '../ai-backends/ai-backend-service'
import type { KnowledgeAgentRunInput, KnowledgeAgentRunResult, KnowledgeAgentRuntime } from './model'
import { InMemoryKnowledgeProcessingRepository } from './repository'
import { KnowledgeProcessingService } from './knowledge-processing-service'

export class FixtureKnowledgeAgentRuntime implements KnowledgeAgentRuntime {
  async run(input: KnowledgeAgentRunInput): Promise<KnowledgeAgentRunResult> {
    input.signal.throwIfAborted()
    input.onTrace?.({
      type: 'workspace_status',
      candidates: {
        total: input.statementCandidates.length,
        open: input.statementCandidates.length,
        resolved: 0
      },
      draftStatementCount: 0
    })
    input.onTrace?.({ type: 'model_started', callNumber: 1 })
    input.onTrace?.({
      type: 'model_completed',
      callNumber: 1,
      status: 'completed',
      detail: 'stop=toolUse · tokens=48 · tools=read_evidence, submit_knowledge_contribution'
    })
    input.onTrace?.({ type: 'tool_started', toolCallId: 'fixture-read', toolName: 'read_evidence' })
    input.onTrace?.({
      type: 'tool_completed',
      toolCallId: 'fixture-read',
      toolName: 'read_evidence',
      status: 'completed',
      detail: 'L000001:C0-L000001:C48 · 48 字符 · EOF'
    })
    input.onTrace?.({
      type: 'tool_started',
      toolCallId: 'fixture-submit',
      toolName: 'submit_knowledge_contribution'
    })
    input.onTrace?.({
      type: 'tool_completed',
      toolCallId: 'fixture-submit',
      toolName: 'submit_knowledge_contribution',
      status: 'completed',
      detail: '捕获 1 条候选 Statement'
    })
    input.onTrace?.({
      type: 'workspace_status',
      candidates: {
        total: input.statementCandidates.length,
        open: 0,
        resolved: input.statementCandidates.length
      },
      draftStatementCount: 1
    })
    return {
      contribution: {
        runRef: input.contributionRunRef,
        statements: [{
          title: 'Fixture 中的明确偏好',
          content: '用户希望知识加工链路保持简洁，并保留可回溯的来源。'
        }]
      },
      statementCandidates: input.statementCandidates.map((candidate, index) => ({
        ref: `C${String(index + 1).padStart(6, '0')}`,
        expression: candidate.expression,
        question: candidate.question,
        evidenceLocations: candidate.locations.map((location) => (
          `L${String(location.line).padStart(6, '0')}:C${location.offset}`
        )),
        status: 'resolved',
        resolution: 'Fixture runtime marked this candidate as covered by its contribution.'
      })),
      modelCallCount: 1,
      toolCalls: ['read_evidence', 'submit_knowledge_contribution']
    }
  }
}

export function createFixtureKnowledgeProcessingService(
  aiBackendService: AiBackendService
): KnowledgeProcessingService {
  return new KnowledgeProcessingService(
    new InMemoryKnowledgeProcessingRepository({
      stages: [
        { stageId: 'observation_preprocessor', connectionId: 'model:fixture', modelId: 'fixture-model' },
        { stageId: 'knowledge_maintenance_agent', connectionId: 'model:fixture', modelId: 'fixture-model' }
      ]
    }),
    aiBackendService,
    new FixtureKnowledgeAgentRuntime()
  )
}

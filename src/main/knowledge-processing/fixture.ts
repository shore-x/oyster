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
      detail: 'stop=toolUse · tokens=48 · tools=read_evidence, submit_knowledge_contribution',
      output: 'Tool call · read_evidence\n{"line":1,"offset":0,"limit":48}'
    })
    input.onTrace?.({
      type: 'tool_started',
      toolCallId: 'fixture-read',
      toolName: 'read_evidence',
      input: '{"line":1,"offset":0,"limit":48}'
    })
    input.onTrace?.({
      type: 'tool_completed',
      toolCallId: 'fixture-read',
      toolName: 'read_evidence',
      status: 'completed',
      detail: 'L000001:C0-L000001:C48 · 48 字符 · EOF',
      output: 'Fixture raw evidence for knowledge processing.'
    })
    input.onTrace?.({
      type: 'tool_started',
      toolCallId: 'fixture-submit',
      toolName: 'submit_knowledge_contribution',
      input: '{}'
    })
    input.onTrace?.({
      type: 'tool_completed',
      toolCallId: 'fixture-submit',
      toolName: 'submit_knowledge_contribution',
      status: 'completed',
      detail: '捕获 1 条候选 Statement',
      output: 'The Knowledge Contribution has been captured for host validation and commit.'
    })
    input.onTrace?.({
      type: 'workspace_status',
      candidates: {
        total: input.statementCandidates.length,
        open: 0,
        resolved: input.statementCandidates.length
      },
      draftStatementCount: 2
    })
    return {
      contribution: {
        runRef: input.contributionRunRef,
        statements: [
          {
            title: '知识加工链路',
            content: '知识加工链路应保持简洁，由 [[Knowledge Maintenance Agent|知识维护 Agent]] 处理候选知识，并保留可回溯的来源。'
          },
          {
            title: 'Knowledge Maintenance Agent',
            content: 'Knowledge Maintenance Agent 读取候选清单和原始证据，为 [[知识加工链路]] 维护相互可解释的 Statement。'
          }
        ]
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

import type { AiBackendService } from '../ai-backends/ai-backend-service'
import type { KnowledgeAgentRunInput, KnowledgeAgentRunResult, KnowledgeAgentRuntime } from './model'
import { InMemoryKnowledgeProcessingRepository } from './repository'
import { KnowledgeProcessingService } from './knowledge-processing-service'

export class FixtureKnowledgeAgentRuntime implements KnowledgeAgentRuntime {
  async run(input: KnowledgeAgentRunInput): Promise<KnowledgeAgentRunResult> {
    input.signal.throwIfAborted()
    return {
      contribution: {
        runRef: input.contributionRunRef,
        statements: [{
          localRef: 'fixture-preference',
          title: 'Fixture 中的明确偏好',
          content: '用户希望知识加工链路保持简洁，并保留可回溯的来源。',
          sources: [{ sourceRef: input.sourceRef, selector: 'L000001-L000001' }]
        }]
      },
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

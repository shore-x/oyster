import type {
  ObservationPreprocessingResult,
  RunSessionPreprocessorInput
} from '../../shared/knowledge-processing'
import type { DiscoveryService } from '../discovery/discovery-service'
import { loadSessionMaterial } from './session'
import {
  KnowledgeProcessingService,
  type ProcessingStageRunBinding
} from './knowledge-processing-service'

/** Runs the existing preprocessor against one selected external Session revision. */
export class SessionPreprocessor {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly processing: KnowledgeProcessingService
  ) {}

  async run(
    input: RunSessionPreprocessorInput,
    binding: ProcessingStageRunBinding
  ): Promise<ObservationPreprocessingResult> {
    if (input?.attention !== undefined && typeof input.attention !== 'string') {
      throw new Error('Attention 格式无效')
    }
    const material = await loadSessionMaterial(this.discovery, input)
    return this.processing.runObservationPreprocessor({
      observation: material.evidence.content,
      attention: input.attention
    }, undefined, {
      binding: structuredClone(binding),
      sourceRef: material.sourceRef
    })
  }
}

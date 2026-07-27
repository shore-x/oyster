import { describe, expect, it } from 'vitest'
import type { ProcessingConnectionView, ProcessingStageView } from '../src/shared/knowledge-processing'
import {
  backendLabel,
  providerLabel,
  reasoningLabel,
  runtimeLabel,
  selectedStageModel
} from '../src/renderer/src/processing-configuration'

describe('processing configuration presentation', () => {
  it('resolves the exact model selected for a stage', () => {
    const connection: ProcessingConnectionView = {
      id: 'coding-plan:openai-codex',
      displayName: 'OpenAI Codex',
      backendKind: 'coding_plan',
      providerId: 'openai_codex',
      destination: 'OpenAI Codex Coding Plan',
      status: 'ready',
      models: [
        { id: 'small', displayName: 'Small', reasoningEfforts: ['low'] },
        { id: 'large', displayName: 'Large', reasoningEfforts: ['high'] }
      ],
      defaultModelId: 'large'
    }
    const stage = {
      id: 'observation_preprocessor',
      modelId: 'small'
    } as ProcessingStageView

    expect(selectedStageModel(stage, connection)?.id).toBe('small')
    expect(backendLabel(connection.backendKind)).toBe('Coding Plan')
    expect(providerLabel(connection.providerId)).toBe('OpenAI Codex')
    expect(runtimeLabel('direct_model_call')).toBe('Direct Model')
    expect(reasoningLabel()).toBe('模型默认')
  })
})

import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import { OPENAI_MODELS } from '@earendil-works/pi-ai/providers/openai.models'
import type { ModelProviderId, ReasoningEffort } from '../../shared/ai-backends'

/**
 * Reasoning support is deliberately conservative. The standard `/models` response does not
 * describe capabilities, so Oyster only enables the control for models present in Pi's typed
 * OpenAI catalog. Unknown and OpenAI-compatible models remain usable without an effort field.
 */
export function reasoningEffortsForModel(
  providerId: ModelProviderId,
  modelId: string
): ReasoningEffort[] {
  if (providerId !== 'openai') return []
  const model = OPENAI_MODELS[modelId as keyof typeof OPENAI_MODELS]
  if (!model?.reasoning) return []
  return getSupportedThinkingLevels(model).filter(
    (level): level is ReasoningEffort => level !== 'off'
  )
}


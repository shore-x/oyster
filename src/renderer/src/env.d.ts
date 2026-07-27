import type { DiscoveryApi } from '../../shared/discovery'
import type { AiBackendApi } from '../../shared/ai-backends'
import type { KnowledgeProcessingApi } from '../../shared/knowledge-processing'

declare global {
  interface Window {
    oyster: {
      discovery: DiscoveryApi
      aiBackends: AiBackendApi
      knowledgeProcessing: KnowledgeProcessingApi
    }
  }
}

export {}

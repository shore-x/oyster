import type { DiscoveryApi } from '../../shared/discovery'
import type { AiBackendApi } from '../../shared/ai-backends'
import type { KnowledgeProcessingApi } from '../../shared/knowledge-processing'
import type { KnowledgeApi } from '../../shared/knowledge'
import type { ChatApi } from '../../shared/chat'

declare global {
  interface Window {
    oyster: {
      discovery: DiscoveryApi
      aiBackends: AiBackendApi
      knowledge: KnowledgeApi
      knowledgeProcessing: KnowledgeProcessingApi
      chat: ChatApi
    }
  }
}

export {}

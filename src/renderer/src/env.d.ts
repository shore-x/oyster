import type { DiscoveryApi } from '../../shared/discovery'
import type { AiBackendApi } from '../../shared/ai-backends'
import type { KnowledgeProcessingApi } from '../../shared/knowledge-processing'
import type { KnowledgeApi } from '../../shared/knowledge'
import type { ChatApi } from '../../shared/chat'
import type { ArtifactApi } from '../../shared/artifacts'
import type { SkillApi } from '../../shared/skills'
import type { FolderBrowserApi } from '../../shared/folder-browser'
import type { PiAgentSettingsApi } from '../../shared/pi-agent-settings'
import type { PiExtensionConfigurationApi } from '../../shared/pi-extensions'

declare global {
  interface Window {
    oyster: {
      discovery: DiscoveryApi
      skills: SkillApi
      aiBackends: AiBackendApi
      knowledge: KnowledgeApi
      artifacts: ArtifactApi
      folderBrowser: FolderBrowserApi
      knowledgeProcessing: KnowledgeProcessingApi
      chat: ChatApi
      piAgentSettings: PiAgentSettingsApi
      piExtensions: PiExtensionConfigurationApi
    }
  }
}

export {}

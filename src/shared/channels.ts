export const discoveryChannels = {
  state: 'discovery:state',
  getState: 'discovery:get-state',
  sourceConversationCatalog: 'discovery:source-conversation-catalog',
  getSourceConversationCatalog: 'discovery:get-source-conversation-catalog',
  refreshSourceConversationCatalog: 'discovery:refresh-source-conversation-catalog',
  detectAgents: 'discovery:detect-agents',
  scanSource: 'discovery:scan-source',
  cancelScan: 'discovery:cancel-scan',
  chooseSourceRoot: 'discovery:choose-source-root'
} as const

export const skillChannels = {
  getDiscoveryStateView: 'skills:get-discovery-snapshot',
  discover: 'skills:discover',
  readDiscoveredDocument: 'skills:read-discovered-document',
  openDiscoveredFolder: 'skills:open-discovered-folder',
  getManagedSnapshot: 'skills:get-managed-snapshot',
  readManagedDocument: 'skills:read-managed-document',
  openManagedFolder: 'skills:open-managed-folder',
  bindManagedSkill: 'skills:bind-managed-skill',
  unbindManagedSkill: 'skills:unbind-managed-skill'
} as const

export const aiBackendChannels = {
  snapshot: 'ai-backends:snapshot',
  getSnapshot: 'ai-backends:get-snapshot',
  refresh: 'ai-backends:refresh',
  connect: 'ai-backends:connect',
  cancelConnect: 'ai-backends:cancel-connect',
  discoverModels: 'ai-backends:discover-models',
  saveModelConnection: 'ai-backends:save-model-connection',
  saveDefaultLlm: 'ai-backends:save-default-llm',
  removeConnection: 'ai-backends:remove-connection',
  testConnection: 'ai-backends:test-connection'
} as const

export const knowledgeProcessingChannels = {
  state: 'knowledge-processing:state',
  getState: 'knowledge-processing:get-state',
  saveAgent: 'knowledge-processing:save-agent',
  saveAgentDefaultInstructions: 'knowledge-processing:save-agent-default-instructions',
  previewKnowledgeMaintainer: 'knowledge-processing:preview-maintainer',
  startKnowledgeTask: 'knowledge-processing:start-task',
  listKnowledgeTasks: 'knowledge-processing:list-tasks',
  readKnowledgeTask: 'knowledge-processing:read-task',
  cancelKnowledgeTask: 'knowledge-processing:cancel-task',
  cancelAgentPreview: 'knowledge-processing:cancel-agent-preview'
} as const

export const knowledgeChannels = {
  browse: 'knowledge:browse',
  read: 'knowledge:read',
  getNeighborhood: 'knowledge:get-neighborhood',
  clear: 'knowledge:clear'
} as const

export const artifactChannels = {
  getSnapshot: 'artifacts:get-snapshot',
  refresh: 'artifacts:refresh',
  createArtifact: 'artifacts:create',
  openRepository: 'artifacts:open-repository'
} as const

export const folderBrowserChannels = {
  getDesignDocumentsPath: 'folder-browser:get-design-documents-path',
  openFolder: 'folder-browser:open-folder',
  browseFolder: 'folder-browser:browse-folder',
  readFile: 'folder-browser:read-file'
} as const

export const chatChannels = {
  event: 'chat:event',
  getState: 'chat:get-state',
  createConversation: 'chat:create-conversation',
  readConversation: 'chat:read-conversation',
  deleteConversation: 'chat:delete-conversation',
  sendMessage: 'chat:send-message',
  cancelInvocation: 'chat:cancel-invocation',
  saveDefaultInstructions: 'chat:save-default-instructions'
} as const

export const piExtensionChannels = {
  getConfiguration: 'pi-extensions:get-configuration',
  addSource: 'pi-extensions:add-source',
  setSourceEnabled: 'pi-extensions:set-source-enabled',
  removeSource: 'pi-extensions:remove-source'
} as const

export const piAgentSettingsChannels = {
  getSettings: 'pi-agent-settings:get-settings',
  saveSettings: 'pi-agent-settings:save-settings'
} as const

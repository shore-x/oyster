export const discoveryChannels = {
  snapshot: 'discovery:snapshot',
  getSnapshot: 'discovery:get-snapshot',
  sessionCatalogSnapshot: 'discovery:session-catalog-snapshot',
  getSessionCatalog: 'discovery:get-session-catalog',
  refreshSessionCatalog: 'discovery:refresh-session-catalog',
  detectAgents: 'discovery:detect-agents',
  scanSource: 'discovery:scan-source',
  cancelRun: 'discovery:cancel-run',
  chooseSourceRoot: 'discovery:choose-source-root'
} as const

export const skillChannels = {
  getDiscoverySnapshot: 'skills:get-discovery-snapshot',
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
  snapshot: 'knowledge-processing:snapshot',
  getSnapshot: 'knowledge-processing:get-snapshot',
  saveStage: 'knowledge-processing:save-stage',
  saveDefaultInstructions: 'knowledge-processing:save-default-instructions',
  runKnowledgeMaintenance: 'knowledge-processing:run-knowledge-maintenance',
  runFullChain: 'knowledge-processing:run-full-chain',
  listFullChainRuns: 'knowledge-processing:list-full-chain-runs',
  readFullChainRun: 'knowledge-processing:read-full-chain-run',
  cancelFullChain: 'knowledge-processing:cancel-full-chain',
  cancelRun: 'knowledge-processing:cancel-run'
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
  openRepository: 'artifacts:open-repository',
  openArtifact: 'artifacts:open-artifact'
} as const

export const chatChannels = {
  event: 'chat:event',
  getSnapshot: 'chat:get-snapshot',
  createSession: 'chat:create-session',
  readSession: 'chat:read-session',
  deleteSession: 'chat:delete-session',
  sendMessage: 'chat:send-message',
  cancelRun: 'chat:cancel-run',
  saveDefaultInstructions: 'chat:save-default-instructions'
} as const

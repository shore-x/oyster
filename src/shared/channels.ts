export const discoveryChannels = {
  snapshot: 'discovery:snapshot',
  getSnapshot: 'discovery:get-snapshot',
  listAvailableSessions: 'discovery:list-available-sessions',
  detectAgents: 'discovery:detect-agents',
  scanSource: 'discovery:scan-source',
  cancelRun: 'discovery:cancel-run',
  chooseSourceRoot: 'discovery:choose-source-root'
} as const

export const aiBackendChannels = {
  snapshot: 'ai-backends:snapshot',
  getSnapshot: 'ai-backends:get-snapshot',
  refresh: 'ai-backends:refresh',
  connect: 'ai-backends:connect',
  cancelConnect: 'ai-backends:cancel-connect',
  discoverModels: 'ai-backends:discover-models',
  saveModelConnection: 'ai-backends:save-model-connection',
  removeConnection: 'ai-backends:remove-connection',
  testConnection: 'ai-backends:test-connection'
} as const

export const knowledgeProcessingChannels = {
  snapshot: 'knowledge-processing:snapshot',
  getSnapshot: 'knowledge-processing:get-snapshot',
  saveStage: 'knowledge-processing:save-stage',
  saveDefaultInstructions: 'knowledge-processing:save-default-instructions',
  runObservationPreprocessor: 'knowledge-processing:run-observation-preprocessor',
  runSessionPreprocessor: 'knowledge-processing:run-session-preprocessor',
  runKnowledgeMaintenance: 'knowledge-processing:run-knowledge-maintenance',
  runFullChain: 'knowledge-processing:run-full-chain',
  listFullChainRuns: 'knowledge-processing:list-full-chain-runs',
  readFullChainRun: 'knowledge-processing:read-full-chain-run',
  importFullChainRun: 'knowledge-processing:import-full-chain-run',
  cancelFullChain: 'knowledge-processing:cancel-full-chain',
  discardSandbox: 'knowledge-processing:discard-sandbox',
  cancelRun: 'knowledge-processing:cancel-run'
} as const

export const knowledgeChannels = {
  browse: 'knowledge:browse',
  read: 'knowledge:read',
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

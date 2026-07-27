export const discoveryChannels = {
  snapshot: 'discovery:snapshot',
  getSnapshot: 'discovery:get-snapshot',
  listAvailableSessions: 'discovery:list-available-sessions',
  inspectAvailableSession: 'discovery:inspect-available-session',
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
  runObservationPreprocessor: 'knowledge-processing:run-observation-preprocessor',
  runSessionPreprocessor: 'knowledge-processing:run-session-preprocessor',
  runKnowledgeMaintenance: 'knowledge-processing:run-knowledge-maintenance',
  runFullChain: 'knowledge-processing:run-full-chain',
  cancelFullChain: 'knowledge-processing:cancel-full-chain',
  discardSandbox: 'knowledge-processing:discard-sandbox',
  cancelRun: 'knowledge-processing:cancel-run'
} as const

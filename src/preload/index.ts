import { contextBridge, ipcRenderer } from 'electron'
import {
  aiBackendChannels,
  discoveryChannels,
  knowledgeChannels,
  knowledgeProcessingChannels
} from '../shared/channels'
import type { AiBackendApi, AiBackendSnapshot } from '../shared/ai-backends'
import type { DiscoveryApi, DiscoverySnapshot } from '../shared/discovery'
import type {
  KnowledgeProcessingApi,
  KnowledgeProcessingSnapshot
} from '../shared/knowledge-processing'
import type { KnowledgeApi } from '../shared/knowledge'

const api: DiscoveryApi = {
  getSnapshot: () => ipcRenderer.invoke(discoveryChannels.getSnapshot),
  listAvailableSessions: () => ipcRenderer.invoke(discoveryChannels.listAvailableSessions),
  detectAgents: () => ipcRenderer.invoke(discoveryChannels.detectAgents),
  scanSource: (sourceId) => ipcRenderer.invoke(discoveryChannels.scanSource, sourceId),
  cancelRun: (runId) => ipcRenderer.invoke(discoveryChannels.cancelRun, runId),
  chooseSourceRoot: (sourceId) => ipcRenderer.invoke(discoveryChannels.chooseSourceRoot, sourceId),
  subscribe: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: DiscoverySnapshot): void => listener(snapshot)
    ipcRenderer.on(discoveryChannels.snapshot, handler)
    return () => ipcRenderer.removeListener(discoveryChannels.snapshot, handler)
  }
}

const aiBackends: AiBackendApi = {
  getSnapshot: () => ipcRenderer.invoke(aiBackendChannels.getSnapshot),
  refresh: () => ipcRenderer.invoke(aiBackendChannels.refresh),
  connect: (input) => ipcRenderer.invoke(aiBackendChannels.connect, input),
  cancelConnect: (connectionId) => ipcRenderer.invoke(aiBackendChannels.cancelConnect, connectionId),
  discoverModels: (input) => ipcRenderer.invoke(aiBackendChannels.discoverModels, input),
  saveModelConnection: (input) => ipcRenderer.invoke(aiBackendChannels.saveModelConnection, input),
  removeConnection: (connectionId) => ipcRenderer.invoke(aiBackendChannels.removeConnection, connectionId),
  testConnection: (connectionId) => ipcRenderer.invoke(aiBackendChannels.testConnection, connectionId),
  subscribe: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: AiBackendSnapshot): void => listener(snapshot)
    ipcRenderer.on(aiBackendChannels.snapshot, handler)
    return () => ipcRenderer.removeListener(aiBackendChannels.snapshot, handler)
  }
}

const knowledgeProcessing: KnowledgeProcessingApi = {
  getSnapshot: () => ipcRenderer.invoke(knowledgeProcessingChannels.getSnapshot),
  saveStage: (input) => ipcRenderer.invoke(knowledgeProcessingChannels.saveStage, input),
  saveDefaultInstructions: (input) => ipcRenderer.invoke(
    knowledgeProcessingChannels.saveDefaultInstructions,
    input
  ),
  runObservationPreprocessor: (input) => ipcRenderer.invoke(
    knowledgeProcessingChannels.runObservationPreprocessor,
    input
  ),
  runSessionPreprocessor: (input) => ipcRenderer.invoke(
    knowledgeProcessingChannels.runSessionPreprocessor,
    input
  ),
  runKnowledgeMaintenance: (input) => ipcRenderer.invoke(
    knowledgeProcessingChannels.runKnowledgeMaintenance,
    input
  ),
  runFullChain: (input) => ipcRenderer.invoke(knowledgeProcessingChannels.runFullChain, input),
  listFullChainRuns: () => ipcRenderer.invoke(knowledgeProcessingChannels.listFullChainRuns),
  readFullChainRun: (runId) => ipcRenderer.invoke(
    knowledgeProcessingChannels.readFullChainRun,
    runId
  ),
  importFullChainRun: (runId) => ipcRenderer.invoke(
    knowledgeProcessingChannels.importFullChainRun,
    runId
  ),
  cancelFullChain: () => ipcRenderer.invoke(knowledgeProcessingChannels.cancelFullChain),
  discardSandbox: (sandboxId) => ipcRenderer.invoke(
    knowledgeProcessingChannels.discardSandbox,
    sandboxId
  ),
  cancelRun: (stageId) => ipcRenderer.invoke(knowledgeProcessingChannels.cancelRun, stageId),
  subscribe: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      snapshot: KnowledgeProcessingSnapshot
    ): void => listener(snapshot)
    ipcRenderer.on(knowledgeProcessingChannels.snapshot, handler)
    return () => ipcRenderer.removeListener(knowledgeProcessingChannels.snapshot, handler)
  }
}

const knowledge: KnowledgeApi = {
  browse: (input) => ipcRenderer.invoke(knowledgeChannels.browse, input),
  read: (title) => ipcRenderer.invoke(knowledgeChannels.read, title),
  clear: () => ipcRenderer.invoke(knowledgeChannels.clear)
}

contextBridge.exposeInMainWorld('oyster', { discovery: api, aiBackends, knowledge, knowledgeProcessing })

import { contextBridge, ipcRenderer } from 'electron'
import {
  aiBackendChannels,
  artifactChannels,
  chatChannels,
  discoveryChannels,
  knowledgeChannels,
  knowledgeProcessingChannels,
  skillChannels
} from '../shared/channels'
import type { AiBackendApi, AiBackendSnapshot } from '../shared/ai-backends'
import type { DiscoveryApi, DiscoverySnapshot } from '../shared/discovery'
import type {
  KnowledgeProcessingApi,
  KnowledgeProcessingSnapshot
} from '../shared/knowledge-processing'
import type { KnowledgeApi } from '../shared/knowledge'
import type { ChatApi, ChatEvent } from '../shared/chat'
import type { ArtifactApi } from '../shared/artifacts'
import type { SkillApi } from '../shared/skills'

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

const skills: SkillApi = {
  getDiscoverySnapshot: () => ipcRenderer.invoke(skillChannels.getDiscoverySnapshot),
  discover: () => ipcRenderer.invoke(skillChannels.discover),
  readDiscoveredDocument: (skillId) => ipcRenderer.invoke(
    skillChannels.readDiscoveredDocument,
    skillId
  ),
  openDiscoveredFolder: (skillId) => ipcRenderer.invoke(
    skillChannels.openDiscoveredFolder,
    skillId
  ),
  getManagedSnapshot: () => ipcRenderer.invoke(skillChannels.getManagedSnapshot),
  readManagedDocument: (artifactDirectoryName) => ipcRenderer.invoke(
    skillChannels.readManagedDocument,
    artifactDirectoryName
  ),
  openManagedFolder: (artifactDirectoryName) => ipcRenderer.invoke(
    skillChannels.openManagedFolder,
    artifactDirectoryName
  ),
  bindManagedSkill: (input) => ipcRenderer.invoke(skillChannels.bindManagedSkill, input),
  unbindManagedSkill: (input) => ipcRenderer.invoke(skillChannels.unbindManagedSkill, input)
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
  getNeighborhood: (title) => ipcRenderer.invoke(knowledgeChannels.getNeighborhood, title),
  clear: () => ipcRenderer.invoke(knowledgeChannels.clear)
}

const artifacts: ArtifactApi = {
  getSnapshot: () => ipcRenderer.invoke(artifactChannels.getSnapshot),
  refresh: () => ipcRenderer.invoke(artifactChannels.refresh),
  createArtifact: (input) => ipcRenderer.invoke(artifactChannels.createArtifact, input),
  openRepository: () => ipcRenderer.invoke(artifactChannels.openRepository),
  openArtifact: (directoryName) => ipcRenderer.invoke(
    artifactChannels.openArtifact,
    directoryName
  )
}

const chat: ChatApi = {
  getSnapshot: () => ipcRenderer.invoke(chatChannels.getSnapshot),
  createSession: (input) => ipcRenderer.invoke(chatChannels.createSession, input),
  readSession: (sessionId) => ipcRenderer.invoke(chatChannels.readSession, sessionId),
  deleteSession: (input) => ipcRenderer.invoke(chatChannels.deleteSession, input),
  sendMessage: (input) => ipcRenderer.invoke(chatChannels.sendMessage, input),
  cancelRun: (input) => ipcRenderer.invoke(chatChannels.cancelRun, input),
  saveDefaultInstructions: (input) => ipcRenderer.invoke(
    chatChannels.saveDefaultInstructions,
    input
  ),
  subscribe: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, chatEvent: ChatEvent): void => listener(chatEvent)
    ipcRenderer.on(chatChannels.event, handler)
    return () => ipcRenderer.removeListener(chatChannels.event, handler)
  }
}

contextBridge.exposeInMainWorld('oyster', {
  discovery: api,
  skills,
  aiBackends,
  knowledge,
  artifacts,
  knowledgeProcessing,
  chat
})

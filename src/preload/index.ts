import { contextBridge, ipcRenderer } from 'electron'
import {
  appSettingsChannels,
  aiBackendChannels,
  artifactChannels,
  chatChannels,
  discoveryChannels,
  folderBrowserChannels,
  knowledgeChannels,
  knowledgeProcessingChannels,
  piAgentSettingsChannels,
  piExtensionChannels,
  skillChannels
} from '../shared/channels'
import type { AppSettingsApi } from '../shared/app-settings'
import type { AiBackendApi, AiBackendSnapshot } from '../shared/ai-backends'
import type {
  DiscoveryApi,
  DiscoveryStateView,
  SourceConversationCatalogView
} from '../shared/discovery'
import type {
  KnowledgeProcessingApi,
  KnowledgeProcessingStateView
} from '../shared/knowledge-processing'
import type { KnowledgeApi } from '../shared/knowledge'
import type { ChatApi, ChatEvent } from '../shared/chat'
import type { ArtifactApi } from '../shared/artifacts'
import type { SkillApi } from '../shared/skills'
import type { FolderBrowserApi } from '../shared/folder-browser'
import type { PiAgentSettingsApi } from '../shared/pi-agent-settings'
import type { PiExtensionConfigurationApi } from '../shared/pi-extensions'

const api: DiscoveryApi = {
  getState: () => ipcRenderer.invoke(discoveryChannels.getState),
  getSourceConversationCatalog: () => ipcRenderer.invoke(discoveryChannels.getSourceConversationCatalog),
  refreshSourceConversationCatalog: () => ipcRenderer.invoke(discoveryChannels.refreshSourceConversationCatalog),
  detectAgents: () => ipcRenderer.invoke(discoveryChannels.detectAgents),
  scanSource: (sourceId) => ipcRenderer.invoke(discoveryChannels.scanSource, sourceId),
  cancelScan: (scanId) => ipcRenderer.invoke(discoveryChannels.cancelScan, scanId),
  chooseSourceRoot: (sourceId) => ipcRenderer.invoke(discoveryChannels.chooseSourceRoot, sourceId),
  subscribe: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: DiscoveryStateView): void => listener(state)
    ipcRenderer.on(discoveryChannels.state, handler)
    return () => ipcRenderer.removeListener(discoveryChannels.state, handler)
  },
  subscribeSourceConversationCatalog: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      catalog: SourceConversationCatalogView
    ): void => listener(catalog)
    ipcRenderer.on(discoveryChannels.sourceConversationCatalog, handler)
    return () => ipcRenderer.removeListener(discoveryChannels.sourceConversationCatalog, handler)
  }
}

const skills: SkillApi = {
  getDiscoveryStateView: () => ipcRenderer.invoke(skillChannels.getDiscoveryStateView),
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
  saveDefaultLlm: (binding) => ipcRenderer.invoke(aiBackendChannels.saveDefaultLlm, binding),
  removeConnection: (connectionId) => ipcRenderer.invoke(aiBackendChannels.removeConnection, connectionId),
  testConnection: (connectionId) => ipcRenderer.invoke(aiBackendChannels.testConnection, connectionId),
  subscribe: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: AiBackendSnapshot): void => listener(snapshot)
    ipcRenderer.on(aiBackendChannels.snapshot, handler)
    return () => ipcRenderer.removeListener(aiBackendChannels.snapshot, handler)
  }
}

const knowledgeProcessing: KnowledgeProcessingApi = {
  getState: () => ipcRenderer.invoke(knowledgeProcessingChannels.getState),
  saveAgent: (input) => ipcRenderer.invoke(knowledgeProcessingChannels.saveAgent, input),
  saveAgentDefaultInstructions: (input) => ipcRenderer.invoke(
    knowledgeProcessingChannels.saveAgentDefaultInstructions,
    input
  ),
  previewKnowledgeMaintainer: (input) => ipcRenderer.invoke(
    knowledgeProcessingChannels.previewKnowledgeMaintainer,
    input
  ),
  startKnowledgeTask: (input) => ipcRenderer.invoke(knowledgeProcessingChannels.startKnowledgeTask, input),
  listKnowledgeTasks: () => ipcRenderer.invoke(knowledgeProcessingChannels.listKnowledgeTasks),
  readKnowledgeTask: (taskId) => ipcRenderer.invoke(
    knowledgeProcessingChannels.readKnowledgeTask,
    taskId
  ),
  cancelKnowledgeTask: () => ipcRenderer.invoke(knowledgeProcessingChannels.cancelKnowledgeTask),
  cancelAgentPreview: (agentId) => ipcRenderer.invoke(
    knowledgeProcessingChannels.cancelAgentPreview,
    agentId
  ),
  subscribe: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      state: KnowledgeProcessingStateView
    ): void => listener(state)
    ipcRenderer.on(knowledgeProcessingChannels.state, handler)
    return () => ipcRenderer.removeListener(knowledgeProcessingChannels.state, handler)
  }
}

const knowledge: KnowledgeApi = {
  browse: (input) => ipcRenderer.invoke(knowledgeChannels.browse, input),
  read: (title) => ipcRenderer.invoke(knowledgeChannels.read, title),
  getNeighborhood: (title) => ipcRenderer.invoke(knowledgeChannels.getNeighborhood, title)
}

const artifacts: ArtifactApi = {
  getSnapshot: () => ipcRenderer.invoke(artifactChannels.getSnapshot),
  refresh: () => ipcRenderer.invoke(artifactChannels.refresh)
}

const folderBrowser: FolderBrowserApi = {
  getDesignDocumentsPath: () => ipcRenderer.invoke(
    folderBrowserChannels.getDesignDocumentsPath
  ),
  openFolder: (folderPath) => ipcRenderer.invoke(
    folderBrowserChannels.openFolder,
    folderPath
  ),
  browseFolder: (folderPath) => ipcRenderer.invoke(
    folderBrowserChannels.browseFolder,
    folderPath
  ),
  readFile: (filePath) => ipcRenderer.invoke(folderBrowserChannels.readFile, filePath)
}

const chat: ChatApi = {
  getState: () => ipcRenderer.invoke(chatChannels.getState),
  createConversation: (input) => ipcRenderer.invoke(chatChannels.createConversation, input),
  readConversation: (conversationId) => ipcRenderer.invoke(
    chatChannels.readConversation,
    conversationId
  ),
  sendMessage: (input) => ipcRenderer.invoke(chatChannels.sendMessage, input),
  cancelInvocation: (input) => ipcRenderer.invoke(chatChannels.cancelInvocation, input),
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

const piExtensions: PiExtensionConfigurationApi = {
  getConfiguration: () => ipcRenderer.invoke(piExtensionChannels.getConfiguration),
  addSource: (input) => ipcRenderer.invoke(piExtensionChannels.addSource, input),
  setSourceEnabled: (input) => ipcRenderer.invoke(piExtensionChannels.setSourceEnabled, input),
  removeSource: (input) => ipcRenderer.invoke(piExtensionChannels.removeSource, input)
}

const piAgentSettings: PiAgentSettingsApi = {
  getSettings: () => ipcRenderer.invoke(piAgentSettingsChannels.getSettings),
  saveSettings: (input) => ipcRenderer.invoke(piAgentSettingsChannels.saveSettings, input)
}

const appSettings: AppSettingsApi = {
  getSettings: () => ipcRenderer.invoke(appSettingsChannels.getSettings),
  saveSettings: (input) => ipcRenderer.invoke(appSettingsChannels.saveSettings, input)
}

contextBridge.exposeInMainWorld('oyster', {
  appSettings,
  discovery: api,
  skills,
  aiBackends,
  knowledge,
  artifacts,
  folderBrowser,
  knowledgeProcessing,
  chat,
  piAgentSettings,
  piExtensions
})

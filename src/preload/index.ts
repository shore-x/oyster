import { contextBridge, ipcRenderer } from 'electron'
import { discoveryChannels } from '../shared/channels'
import type { DiscoveryApi, DiscoverySnapshot } from '../shared/discovery'

const api: DiscoveryApi = {
  getSnapshot: () => ipcRenderer.invoke(discoveryChannels.getSnapshot),
  detectAgents: () => ipcRenderer.invoke(discoveryChannels.detectAgents),
  scanSource: (sourceId) => ipcRenderer.invoke(discoveryChannels.scanSource, sourceId),
  importSource: (sourceId) => ipcRenderer.invoke(discoveryChannels.importSource, sourceId),
  cancelRun: (runId) => ipcRenderer.invoke(discoveryChannels.cancelRun, runId),
  chooseSourceRoot: (sourceId) => ipcRenderer.invoke(discoveryChannels.chooseSourceRoot, sourceId),
  openRawEvidenceDirectory: () => ipcRenderer.invoke(discoveryChannels.openRawEvidenceDirectory),
  subscribe: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: DiscoverySnapshot): void => listener(snapshot)
    ipcRenderer.on(discoveryChannels.snapshot, handler)
    return () => ipcRenderer.removeListener(discoveryChannels.snapshot, handler)
  }
}

contextBridge.exposeInMainWorld('oyster', { discovery: api })

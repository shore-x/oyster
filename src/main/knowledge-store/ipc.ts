import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { knowledgeChannels } from '../../shared/channels'
import type { BrowseKnowledgeInput } from '../../shared/knowledge'
import type { KnowledgeFullChainService } from '../knowledge-processing/full-chain-service'
import type { SqliteKnowledgeStore } from './sqlite-knowledge-store'

export function registerKnowledgeIpc(
  store: SqliteKnowledgeStore,
  fullChain: KnowledgeFullChainService,
  getMainWindow: () => BrowserWindow | undefined
): void {
  const assertTrustedSender = (event: IpcMainInvokeEvent): void => {
    const window = getMainWindow()
    if (
      !window
      || window.isDestroyed()
      || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame
    ) {
      throw new Error('拒绝来自非主窗口的知识请求')
    }
  }

  ipcMain.handle(knowledgeChannels.browse, (event, input?: BrowseKnowledgeInput) => {
    assertTrustedSender(event)
    return store.browse(input)
  })
  ipcMain.handle(knowledgeChannels.read, (event, title: string) => {
    assertTrustedSender(event)
    return store.getStatement(title)
  })
  ipcMain.handle(knowledgeChannels.clear, (event) => {
    assertTrustedSender(event)
    return fullChain.clearKnowledge()
  })
}

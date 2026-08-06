import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { knowledgeChannels } from '../../shared/channels'
import type { BrowseKnowledgeInput } from '../../shared/knowledge'
import { KnowledgeExplorerProjectionService } from '../knowledge-projection/knowledge-explorer-projection'
import type { FileKnowledgeStore } from './file-knowledge-store'

export function registerKnowledgeIpc(
  store: FileKnowledgeStore,
  getMainWindow: () => BrowserWindow | undefined
): void {
  const explorer = new KnowledgeExplorerProjectionService(store)

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
    return explorer.browse(input)
  })
  ipcMain.handle(knowledgeChannels.read, (event, title: string) => {
    assertTrustedSender(event)
    return store.getStatement(title)
  })
  ipcMain.handle(knowledgeChannels.getNeighborhood, (event, title: string) => {
    assertTrustedSender(event)
    return explorer.getNeighborhood(title)
  })
  ipcMain.handle(knowledgeChannels.clear, (event) => {
    assertTrustedSender(event)
    return store.clear()
  })
}

import {
  ipcMain,
  shell,
  type BrowserWindow,
  type IpcMainInvokeEvent
} from 'electron'
import { folderBrowserChannels } from '../../shared/channels'
import { FolderBrowserService } from './folder-browser-service'

export function registerFolderBrowserIpc(
  browser: FolderBrowserService,
  designDocumentsPath: string,
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
      throw new Error('拒绝来自非主窗口的文件浏览请求')
    }
  }

  ipcMain.handle(folderBrowserChannels.getDesignDocumentsPath, (event) => {
    assertTrustedSender(event)
    return designDocumentsPath
  })
  ipcMain.handle(folderBrowserChannels.openFolder, async (event, folderPath: string) => {
    assertTrustedSender(event)
    const path = await browser.resolveFolderPath(folderPath)
    const errorMessage = await shell.openPath(path)
    if (errorMessage) throw new Error(`无法打开文件夹：${errorMessage}`)
  })
  ipcMain.handle(folderBrowserChannels.browseFolder, (event, folderPath: string) => {
    assertTrustedSender(event)
    return browser.browseFolder(folderPath)
  })
  ipcMain.handle(folderBrowserChannels.readFile, (event, filePath: string) => {
    assertTrustedSender(event)
    return browser.readFile(filePath)
  })
}

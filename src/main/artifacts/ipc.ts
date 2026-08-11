import {
  ipcMain,
  type BrowserWindow,
  type IpcMainInvokeEvent
} from 'electron'
import { artifactChannels } from '../../shared/channels'
import { ArtifactService } from './artifact-repository'

export function registerArtifactIpc(
  repository: ArtifactService,
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
      throw new Error('拒绝来自非主窗口的 Artifact 请求')
    }
  }

  ipcMain.handle(artifactChannels.getSnapshot, (event) => {
    assertTrustedSender(event)
    return repository.refresh()
  })
  ipcMain.handle(artifactChannels.refresh, (event) => {
    assertTrustedSender(event)
    return repository.refresh()
  })
}

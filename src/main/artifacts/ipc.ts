import {
  ipcMain,
  shell,
  type BrowserWindow,
  type IpcMainInvokeEvent
} from 'electron'
import { artifactChannels } from '../../shared/channels'
import type { CreateArtifactInput } from '../../shared/artifacts'
import { ArtifactService } from './artifact-repository'

async function openPath(path: string, label: string): Promise<void> {
  const errorMessage = await shell.openPath(path)
  if (errorMessage) throw new Error(`无法打开${label}：${errorMessage}`)
}

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
  ipcMain.handle(
    artifactChannels.createArtifact,
    (event, input: CreateArtifactInput) => {
      assertTrustedSender(event)
      return repository.createArtifact(input)
    }
  )
  ipcMain.handle(artifactChannels.openRepository, async (event) => {
    assertTrustedSender(event)
    await openPath(repository.repositoryPath, ' Oyster Repository')
  })
}

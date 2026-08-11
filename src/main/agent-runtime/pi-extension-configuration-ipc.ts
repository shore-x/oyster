import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { piExtensionChannels } from '../../shared/channels'
import type {
  AddPiExtensionSourceInput,
  PiExtensionSourceMutationInput,
  SetPiExtensionSourceEnabledInput
} from '../../shared/pi-extensions'
import type { PiExtensionConfigurationService } from './pi-extension-configuration-service'

export function registerPiExtensionConfigurationIpc(
  service: PiExtensionConfigurationService,
  getMainWindow: () => BrowserWindow | undefined
): void {
  const assertTrustedSender = (event: IpcMainInvokeEvent): void => {
    const window = getMainWindow()
    if (!window || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('拒绝来自非主窗口的 Extension 配置请求')
    }
  }
  ipcMain.handle(piExtensionChannels.getConfiguration, (event) => {
    assertTrustedSender(event)
    return service.getConfiguration()
  })
  ipcMain.handle(piExtensionChannels.addSource, (event, input: AddPiExtensionSourceInput) => {
    assertTrustedSender(event)
    return service.addSource(input)
  })
  ipcMain.handle(
    piExtensionChannels.setSourceEnabled,
    (event, input: SetPiExtensionSourceEnabledInput) => {
      assertTrustedSender(event)
      return service.setSourceEnabled(input)
    }
  )
  ipcMain.handle(piExtensionChannels.removeSource, (event, input: PiExtensionSourceMutationInput) => {
    assertTrustedSender(event)
    return service.removeSource(input)
  })
}

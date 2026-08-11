import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { appSettingsChannels } from '../../shared/channels'
import type { SaveAppSettingsInput } from '../../shared/app-settings'
import type { AppSettingsService } from './app-settings-service'

export function registerAppSettingsIpc(
  service: AppSettingsService,
  getMainWindow: () => BrowserWindow | undefined
): void {
  const assertTrustedSender = (event: IpcMainInvokeEvent): void => {
    const window = getMainWindow()
    if (!window || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('拒绝来自非主窗口的应用设置请求')
    }
  }
  ipcMain.handle(appSettingsChannels.getSettings, (event) => {
    assertTrustedSender(event)
    return service.getSettings()
  })
  ipcMain.handle(appSettingsChannels.saveSettings, (event, input: SaveAppSettingsInput) => {
    assertTrustedSender(event)
    return service.saveSettings(input)
  })
}

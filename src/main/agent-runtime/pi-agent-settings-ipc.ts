import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { piAgentSettingsChannels } from '../../shared/channels'
import type { SavePiAgentSettingsInput } from '../../shared/pi-agent-settings'
import type { PiAgentSettingsService } from './pi-agent-settings-service'

export function registerPiAgentSettingsIpc(
  service: PiAgentSettingsService,
  getMainWindow: () => BrowserWindow | undefined
): void {
  const assertTrustedSender = (event: IpcMainInvokeEvent): void => {
    const window = getMainWindow()
    if (!window || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('拒绝来自非主窗口的 Pi Agent 配置请求')
    }
  }
  ipcMain.handle(piAgentSettingsChannels.getSettings, (event) => {
    assertTrustedSender(event)
    return service.getSettings()
  })
  ipcMain.handle(
    piAgentSettingsChannels.saveSettings,
    (event, input: SavePiAgentSettingsInput) => {
      assertTrustedSender(event)
      return service.saveSettings(input)
    }
  )
}

import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { chatChannels } from '../../shared/channels'
import type {
  CancelChatRunInput,
  CreateChatSessionInput,
  DeleteChatSessionInput,
  SaveChatDefaultInstructionsInput,
  SendChatMessageInput
} from '../../shared/chat'
import type { ChatAgentService } from './chat-agent-service'

export function registerChatIpc(
  service: ChatAgentService,
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
      throw new Error('拒绝来自非主窗口的对话请求')
    }
  }

  ipcMain.handle(chatChannels.getSnapshot, (event) => {
    assertTrustedSender(event)
    return service.getSnapshot()
  })
  ipcMain.handle(chatChannels.createSession, (event, input: CreateChatSessionInput) => {
    assertTrustedSender(event)
    return service.createSession(input)
  })
  ipcMain.handle(chatChannels.readSession, (event, sessionId: string) => {
    assertTrustedSender(event)
    return service.readSession(sessionId)
  })
  ipcMain.handle(chatChannels.deleteSession, (event, input: DeleteChatSessionInput) => {
    assertTrustedSender(event)
    return service.deleteSession(input)
  })
  ipcMain.handle(chatChannels.sendMessage, (event, input: SendChatMessageInput) => {
    assertTrustedSender(event)
    return service.sendMessage(input)
  })
  ipcMain.handle(chatChannels.cancelRun, (event, input: CancelChatRunInput) => {
    assertTrustedSender(event)
    return service.cancelRun(input)
  })
  ipcMain.handle(
    chatChannels.saveDefaultInstructions,
    (event, input: SaveChatDefaultInstructionsInput) => {
      assertTrustedSender(event)
      return service.saveDefaultInstructions(input)
    }
  )

  service.subscribe((chatEvent) => {
    const window = getMainWindow()
    if (window && !window.isDestroyed()) window.webContents.send(chatChannels.event, chatEvent)
  })
}

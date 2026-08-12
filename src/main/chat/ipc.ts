import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { chatChannels } from '../../shared/channels'
import type {
  CancelChatInvocationInput,
  CreateChatConversationInput,
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

  ipcMain.handle(chatChannels.getState, (event) => {
    assertTrustedSender(event)
    return service.getState()
  })
  ipcMain.handle(chatChannels.createConversation, (event, input: CreateChatConversationInput) => {
    assertTrustedSender(event)
    return service.createConversation(input)
  })
  ipcMain.handle(chatChannels.readConversation, (event, conversationId: string) => {
    assertTrustedSender(event)
    return service.readConversation(conversationId)
  })
  ipcMain.handle(chatChannels.sendMessage, (event, input: SendChatMessageInput) => {
    assertTrustedSender(event)
    return service.sendMessage(input)
  })
  ipcMain.handle(chatChannels.cancelInvocation, (event, input: CancelChatInvocationInput) => {
    assertTrustedSender(event)
    return service.cancelInvocation(input)
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

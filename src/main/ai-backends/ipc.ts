import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { aiBackendChannels } from '../../shared/channels'
import type {
  ConnectAiBackendInput,
  DiscoverModelsInput,
  SaveModelConnectionInput,
  TestConnectionInput
} from '../../shared/ai-backends'
import type { AiBackendService } from './ai-backend-service'

export function registerAiBackendIpc(
  service: AiBackendService,
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
      throw new Error('拒绝来自非主窗口的 AI Backend 请求')
    }
  }

  ipcMain.handle(aiBackendChannels.getSnapshot, (event) => {
    assertTrustedSender(event)
    return service.snapshot()
  })
  ipcMain.handle(aiBackendChannels.refresh, (event) => {
    assertTrustedSender(event)
    return service.refresh()
  })
  ipcMain.handle(aiBackendChannels.connect, async (event, input: ConnectAiBackendInput) => {
    assertTrustedSender(event)
    return service.connect(input)
  })
  ipcMain.handle(aiBackendChannels.cancelConnect, (event, connectionId: string) => {
    assertTrustedSender(event)
    service.cancelConnect(connectionId)
  })
  ipcMain.handle(
    aiBackendChannels.discoverModels,
    (event, input: DiscoverModelsInput) => {
      assertTrustedSender(event)
      return service.discoverModels(input)
    }
  )
  ipcMain.handle(
    aiBackendChannels.saveModelConnection,
    (event, input: SaveModelConnectionInput) => {
      assertTrustedSender(event)
      return service.saveModelConnection(input)
    }
  )
  ipcMain.handle(
    aiBackendChannels.removeConnection,
    (event, connectionId: string) => {
      assertTrustedSender(event)
      return service.removeConnection(connectionId)
    }
  )
  ipcMain.handle(aiBackendChannels.testConnection, async (event, input: TestConnectionInput) => {
    assertTrustedSender(event)
    const connection = service.snapshot().connections.find(
      (candidate) => candidate.id === input?.connectionId
    )
    if (!connection) throw new Error('未找到 AI Connection')
    const model = connection.models.find((candidate) => candidate.id === input.modelId)
    if (!model) throw new Error('所选 Model 不属于该 Connection')
    const destination = connection.modelConfig?.baseUrl || 'OpenAI Codex Direct Provider'
    const billing = connection.backendKind === 'coding_plan'
      ? 'ChatGPT/Codex Coding Plan'
      : 'Provider API 账户'
    const backend = connection.backendKind === 'coding_plan' ? 'Coding Plan' : 'Model API'
    const owner = BrowserWindow.getFocusedWindow() || getMainWindow()
    const result = owner
      ? await dialog.showMessageBox(owner, {
          type: 'warning',
          title: '运行连接测试',
          message: '这将发送一条不含项目数据的测试请求，并可能消耗额度或产生费用。',
          detail: [
            `Connection：${connection.displayName}`,
            `Backend：${backend}`,
            `Model：${model.displayName} (${model.id})`,
            `思考强度：${input.reasoningEffort ?? '模型默认'}`,
            `数据目的地：${destination}`,
            `计费来源：${billing}`
          ].join('\n'),
          buttons: ['取消', '运行测试'],
          defaultId: 1,
          cancelId: 0
        })
      : { response: 0 }
    if (result.response !== 1) {
      return { connectionId: input.connectionId, output: '', durationMs: 0, cancelled: true }
    }
    return service.testConnection(input)
  })

  service.subscribe((snapshot) => {
    const window = getMainWindow()
    if (window && !window.isDestroyed()) window.webContents.send(aiBackendChannels.snapshot, snapshot)
  })
}

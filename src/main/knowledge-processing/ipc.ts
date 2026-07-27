import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { knowledgeProcessingChannels } from '../../shared/channels'
import type {
  ProcessingStageId,
  RunSessionPreprocessorInput,
  RunKnowledgeFullChainInput,
  RunKnowledgeMaintenanceInput,
  RunObservationPreprocessorInput,
  SaveProcessingStageInput
} from '../../shared/knowledge-processing'
import type { KnowledgeProcessingService } from './knowledge-processing-service'
import type { ProcessingStageRunBinding } from './knowledge-processing-service'
import type { KnowledgeFullChainService } from './full-chain-service'
import type { SessionPreprocessor } from './session-preprocessor'
import { validateSessionSelection } from './session'

export function registerKnowledgeProcessingIpc(
  service: KnowledgeProcessingService,
  sessionPreprocessor: SessionPreprocessor,
  fullChain: KnowledgeFullChainService,
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
      throw new Error('拒绝来自非主窗口的知识加工请求')
    }
  }

  const confirmRun = async (
    stageId: ProcessingStageId,
    message: string,
    detailPrefix: string
  ): Promise<ProcessingStageRunBinding | undefined> => {
    if (fullChain.isRunning()) throw new Error('完整链路正在运行，不能启动独立阶段')
    const snapshot = service.snapshot()
    const binding = service.runBinding(stageId)
    const stage = snapshot.stages.find((candidate) => candidate.id === stageId)
    const connection = snapshot.connections.find((candidate) => candidate.id === stage?.connectionId)
    const model = connection?.models.find((candidate) => candidate.id === binding.modelId)
    if (!stage?.connectionId || !connection || !model) {
      throw new Error('请先为该阶段选择并保存 Connection 与 Model')
    }
    const billingSource = connection.backendKind === 'coding_plan'
      ? 'ChatGPT/Codex Coding Plan'
      : connection.providerId === 'openai'
        ? 'OpenAI API 账户'
        : '由该自定义端点的运营方决定'
    const owner = BrowserWindow.getFocusedWindow() || getMainWindow()
    if (!owner) return undefined
    const result = await dialog.showMessageBox(owner, {
      type: 'warning',
      title: `运行${stage.displayName}`,
      message,
      detail: [
        detailPrefix,
        `Connection：${connection.displayName}`,
        `Backend：${connection.backendKind === 'coding_plan' ? 'Coding Plan' : 'Model API'}`,
        `Model：${model.displayName} (${model.id})`,
        `思考强度：${binding.reasoningEffort ?? '模型默认'}`,
        `数据目的地：${connection.destination}`,
        `计费/额度来源：${billingSource}`
      ].join('\n'),
      buttons: ['取消', '运行'],
      defaultId: 1,
      cancelId: 0
    })
    return result.response === 1 ? binding : undefined
  }

  const confirmFullChain = async (): Promise<{
    preprocessor: ProcessingStageRunBinding
    maintainer: ProcessingStageRunBinding
  } | undefined> => {
    if (fullChain.isRunning()) throw new Error('完整链路正在运行')
    const snapshot = service.snapshot()
    const preprocessorBinding = service.runBinding('observation_preprocessor')
    const maintainerBinding = service.runBinding('knowledge_maintenance_agent')
    const preprocessor = snapshot.stages.find((stage) => stage.id === 'observation_preprocessor')
    const maintainer = snapshot.stages.find((stage) => stage.id === 'knowledge_maintenance_agent')
    const preprocessorConnection = snapshot.connections.find(
      (connection) => connection.id === preprocessor?.connectionId
    )
    const maintainerConnection = snapshot.connections.find(
      (connection) => connection.id === maintainer?.connectionId
    )
    const preprocessorModel = preprocessorConnection?.models.find(
      (model) => model.id === preprocessorBinding.modelId
    )
    const maintainerModel = maintainerConnection?.models.find(
      (model) => model.id === maintainerBinding.modelId
    )
    if (!preprocessorConnection || !maintainerConnection || !preprocessorModel || !maintainerModel) {
      throw new Error('请先为两个知识加工阶段选择并保存 Connection 与 Model')
    }
    const owner = BrowserWindow.getFocusedWindow() || getMainWindow()
    if (!owner) return undefined
    const result = await dialog.showMessageBox(owner, {
      type: 'warning',
      title: '运行完整知识加工链路',
      message: '这会处理所选 Session，并调用两个已配置的模型阶段。',
      detail: [
        `Observation Preprocessor：${preprocessorConnection.displayName}`,
        `Model：${preprocessorModel.displayName} (${preprocessorModel.id})`,
        `思考强度：${preprocessorBinding.reasoningEffort ?? '模型默认'}`,
        `目的地：${preprocessorConnection.destination}`,
        `Knowledge Maintenance Agent：${maintainerConnection.displayName}`,
        `Model：${maintainerModel.displayName} (${maintainerModel.id})`,
        `思考强度：${maintainerBinding.reasoningEffort ?? '模型默认'}`,
        `目的地：${maintainerConnection.destination}`,
        '',
        '所选 Session 会在运行时从 Agent 的原始目录读取并发送给预处理模型；长 Session 会在单次运行上限内自动分段并产生多次模型调用（最多 32 个原始分段、63 次预处理调用）。维护 Agent 会收到 Evidence Map，并可按需展开局部地图、读取本次原始证据和 Sandbox 中的已有知识。模型调用可能消耗额度或产生费用；失败或取消前已经发起的调用也可能计费。',
        '所有 Knowledge Statement 只会写入一次性 Knowledge Sandbox，不影响正式知识库。'
      ].join('\n'),
      buttons: ['取消', '运行'],
      defaultId: 1,
      cancelId: 0
    })
    if (result.response !== 1) return undefined
    return {
      preprocessor: preprocessorBinding,
      maintainer: maintainerBinding
    }
  }

  ipcMain.handle(knowledgeProcessingChannels.getSnapshot, (event) => {
    assertTrustedSender(event)
    return service.snapshot()
  })
  ipcMain.handle(
    knowledgeProcessingChannels.saveStage,
    (event, input: SaveProcessingStageInput) => {
      assertTrustedSender(event)
      return service.saveStage(input)
    }
  )
  ipcMain.handle(
    knowledgeProcessingChannels.runObservationPreprocessor,
    async (event, input: RunObservationPreprocessorInput) => {
      assertTrustedSender(event)
      const binding = await confirmRun(
        'observation_preprocessor',
        '这会把当前 System Prompt、Observation 和 Attention 发送给所选模型，并可能消耗额度或产生费用。',
        '输出只是可丢弃的 Evidence Map，不会写入知识层。'
      )
      return binding
        ? service.runObservationPreprocessor(input, undefined, { binding })
        : undefined
    }
  )
  ipcMain.handle(
    knowledgeProcessingChannels.runSessionPreprocessor,
    async (event, input: RunSessionPreprocessorInput) => {
      assertTrustedSender(event)
      validateSessionSelection(input)
      const binding = await confirmRun(
        'observation_preprocessor',
        '这会从 Agent 的原始目录读取所选 Session，并把当前 System Prompt、原始 Observation 和 Attention 发送给所选模型；长 Session 会在单次运行上限内自动分段并产生多次模型调用（最多 32 个原始分段、63 次预处理调用），可能消耗额度或产生费用。失败或取消前已经发起的调用也可能计费。',
        '输出只是可丢弃的 Evidence Map，不会写入知识层。'
      )
      return binding ? sessionPreprocessor.run(input, binding) : undefined
    }
  )
  ipcMain.handle(
    knowledgeProcessingChannels.runKnowledgeMaintenance,
    async (event, input: RunKnowledgeMaintenanceInput) => {
      assertTrustedSender(event)
      const binding = await confirmRun(
        'knowledge_maintenance_agent',
        '这会把当前 System Prompt 和 Evidence Map 发送给所选模型；Agent 还可以按需读取并发送相关 Knowledge Statement 与本次授权的原始 Observation。',
        '输出只是候选 Knowledge Contribution，不会写入权威知识层。'
      )
      return binding
        ? service.runKnowledgeMaintenance(input, undefined, { binding })
        : undefined
    }
  )
  ipcMain.handle(
    knowledgeProcessingChannels.runFullChain,
    async (event, input: RunKnowledgeFullChainInput) => {
      assertTrustedSender(event)
      const bindings = await confirmFullChain()
      return bindings ? fullChain.run(input, bindings) : undefined
    }
  )
  ipcMain.handle(knowledgeProcessingChannels.cancelFullChain, (event) => {
    assertTrustedSender(event)
    fullChain.cancel()
  })
  ipcMain.handle(
    knowledgeProcessingChannels.discardSandbox,
    (event, sandboxId: string) => {
      assertTrustedSender(event)
      return fullChain.discardSandbox(sandboxId)
    }
  )
  ipcMain.handle(
    knowledgeProcessingChannels.cancelRun,
    (event, stageId: ProcessingStageId) => {
      assertTrustedSender(event)
      service.cancelRun(stageId)
    }
  )

  service.subscribe((snapshot) => {
    const window = getMainWindow()
    if (window && !window.isDestroyed()) {
      window.webContents.send(knowledgeProcessingChannels.snapshot, snapshot)
    }
  })
}

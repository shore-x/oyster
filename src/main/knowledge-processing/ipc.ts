import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
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

  const resolveRunBinding = (stageId: ProcessingStageId): ProcessingStageRunBinding => {
    if (fullChain.isRunning()) throw new Error('完整链路正在运行，不能启动独立阶段')
    const snapshot = service.snapshot()
    const binding = service.runBinding(stageId)
    const stage = snapshot.stages.find((candidate) => candidate.id === stageId)
    const connection = snapshot.connections.find((candidate) => candidate.id === stage?.connectionId)
    const model = connection?.models.find((candidate) => candidate.id === binding.modelId)
    if (!stage?.connectionId || !connection || !model) {
      throw new Error('请先为该阶段选择并保存 Connection 与 Model')
    }
    return binding
  }

  const resolveFullChainBindings = (): {
    preprocessor: ProcessingStageRunBinding
    maintainer: ProcessingStageRunBinding
  } => {
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
      const binding = resolveRunBinding('observation_preprocessor')
      return service.runObservationPreprocessor(input, undefined, { binding })
    }
  )
  ipcMain.handle(
    knowledgeProcessingChannels.runSessionPreprocessor,
    async (event, input: RunSessionPreprocessorInput) => {
      assertTrustedSender(event)
      validateSessionSelection(input)
      const binding = resolveRunBinding('observation_preprocessor')
      return sessionPreprocessor.run(input, binding)
    }
  )
  ipcMain.handle(
    knowledgeProcessingChannels.runKnowledgeMaintenance,
    async (event, input: RunKnowledgeMaintenanceInput) => {
      assertTrustedSender(event)
      const binding = resolveRunBinding('knowledge_maintenance_agent')
      return service.runKnowledgeMaintenance(input, undefined, { binding })
    }
  )
  ipcMain.handle(
    knowledgeProcessingChannels.runFullChain,
    async (event, input: RunKnowledgeFullChainInput) => {
      assertTrustedSender(event)
      return fullChain.run(input, resolveFullChainBindings())
    }
  )
  ipcMain.handle(knowledgeProcessingChannels.listFullChainRuns, (event) => {
    assertTrustedSender(event)
    return fullChain.listRuns()
  })
  ipcMain.handle(
    knowledgeProcessingChannels.readFullChainRun,
    (event, runId: string) => {
      assertTrustedSender(event)
      return fullChain.readRun(runId)
    }
  )
  ipcMain.handle(
    knowledgeProcessingChannels.importFullChainRun,
    (event, runId: string) => {
      assertTrustedSender(event)
      return fullChain.importRun(runId)
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

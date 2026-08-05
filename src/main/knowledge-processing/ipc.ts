import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { knowledgeProcessingChannels } from '../../shared/channels'
import type {
  ProcessingStageId,
  RunKnowledgeFullChainInput,
  RunKnowledgeMaintenanceInput,
  SaveProcessingDefaultInstructionsInput,
  SaveProcessingStageInput
} from '../../shared/knowledge-processing'
import type { DiscoveryService } from '../discovery/discovery-service'
import type { KnowledgeProcessingService } from './knowledge-processing-service'
import type { ProcessingStageRunBinding } from './knowledge-processing-service'
import type { KnowledgeFullChainService } from './full-chain-service'
import { loadSessionMaterial } from './session'

export function registerKnowledgeProcessingIpc(
  discovery: DiscoveryService,
  service: KnowledgeProcessingService,
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

  const resolveMaintainerBinding = (): ProcessingStageRunBinding => {
    if (fullChain.isRunning()) throw new Error('完整链路正在运行，不能启动独立调试')
    const binding = service.runBinding('knowledge_maintenance_agent')
    const snapshot = service.snapshot()
    const stage = snapshot.stages[0]
    const connection = snapshot.connections.find((candidate) => candidate.id === stage?.connectionId)
    const model = connection?.models.find((candidate) => candidate.id === binding.modelId)
    if (!stage?.connectionId || !connection || !model) {
      throw new Error('请先为知识维护 Agent 选择并保存 Connection 与 Model')
    }
    return binding
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
    knowledgeProcessingChannels.saveDefaultInstructions,
    (event, input: SaveProcessingDefaultInstructionsInput) => {
      assertTrustedSender(event)
      return service.saveDefaultInstructions(input)
    }
  )
  ipcMain.handle(
    knowledgeProcessingChannels.runKnowledgeMaintenance,
    async (event, input: RunKnowledgeMaintenanceInput) => {
      assertTrustedSender(event)
      const material = await loadSessionMaterial(discovery, input)
      return service.runKnowledgeMaintenance(
        material.evidence.rawEvidence,
        material.sourceRef,
        input.attention,
        { binding: resolveMaintainerBinding() }
      )
    }
  )
  ipcMain.handle(
    knowledgeProcessingChannels.runFullChain,
    async (event, input: RunKnowledgeFullChainInput) => {
      assertTrustedSender(event)
      return fullChain.run(input, { maintainer: resolveMaintainerBinding() })
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

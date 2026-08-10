import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { knowledgeProcessingChannels } from '../../shared/channels'
import type {
  ProcessingStageId,
  RunKnowledgeFullChainInput,
  RunKnowledgeMaintenanceInput,
  SaveProcessingDefaultInstructionsInput,
  SaveProcessingStageInput,
  SessionRunResponse
} from '../../shared/knowledge-processing'
import type { DiscoveryService } from '../discovery/discovery-service'
import type { KnowledgeProcessingService } from './knowledge-processing-service'
import type { ProcessingStageRunBinding } from './knowledge-processing-service'
import type { KnowledgeFullChainService } from './full-chain-service'
import {
  loadSessionMaterial,
  SessionSelectionRejectedError
} from './session'

async function sessionRunResponse<Result>(
  operation: () => Promise<Result>
): Promise<SessionRunResponse<Result>> {
  try {
    return { status: 'completed', result: await operation() }
  } catch (error) {
    if (error instanceof SessionSelectionRejectedError) {
      return {
        status: 'session_rejected',
        reason: error.reason,
        message: error.message
      }
    }
    throw error
  }
}

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

  const resolveBinding = (stageId: ProcessingStageId): ProcessingStageRunBinding => {
    if (fullChain.isRunning()) throw new Error('完整链路正在运行，不能启动独立调试')
    return service.runBinding(stageId)
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
      return sessionRunResponse(async () => {
        const material = await loadSessionMaterial(discovery, input)
        return service.runKnowledgeMaintenance(
          {
            rawEvidence: material.evidence.rawEvidence,
            canonicalActivity: material.evidence.canonicalActivity
          },
          material.sourceRef,
          input.attention,
          { binding: resolveBinding('knowledge_maintenance_agent') }
        )
      })
    }
  )
  ipcMain.handle(
    knowledgeProcessingChannels.runFullChain,
    async (event, input: RunKnowledgeFullChainInput) => {
      assertTrustedSender(event)
      return sessionRunResponse(() => fullChain.run(input, {
        maintainer: resolveBinding('knowledge_maintenance_agent'),
        reviewer: resolveBinding('knowledge_reviewer_agent')
      }))
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
  ipcMain.handle(knowledgeProcessingChannels.cancelFullChain, (event) => {
    assertTrustedSender(event)
    fullChain.cancel()
  })
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

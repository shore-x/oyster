import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { knowledgeProcessingChannels } from '../../shared/channels'
import type {
  KnowledgeAgentBinding,
  KnowledgeAgentId,
  SaveKnowledgeAgentDefaultInstructionsInput,
  SaveKnowledgeAgentInput,
  SourceSnapshotOperationResult,
  StartKnowledgeAgentPreviewInput,
  StartKnowledgeTaskInput
} from '../../shared/knowledge-processing'
import type { DiscoveryService } from '../discovery/discovery-service'
import type { KnowledgeProcessingService } from './knowledge-processing-service'
import type { KnowledgeTaskService } from './knowledge-task-service'
import {
  loadSourceSnapshotMaterial,
  SourceSnapshotRejectedError
} from './source-snapshot'

async function sourceSnapshotOperation<Result>(
  operation: () => Promise<Result>
): Promise<SourceSnapshotOperationResult<Result>> {
  try {
    return { status: 'completed', result: await operation() }
  } catch (error) {
    if (error instanceof SourceSnapshotRejectedError) {
      return {
        status: 'source_snapshot_rejected',
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
  tasks: KnowledgeTaskService,
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

  const previewBinding = (agentId: KnowledgeAgentId): KnowledgeAgentBinding => {
    if (tasks.isActive()) {
      throw new Error('Knowledge Processing Task 正在进行，不能启动 Agent Preview')
    }
    return service.agentBinding(agentId)
  }

  ipcMain.handle(knowledgeProcessingChannels.getState, (event) => {
    assertTrustedSender(event)
    return service.stateView()
  })
  ipcMain.handle(
    knowledgeProcessingChannels.saveAgent,
    (event, input: SaveKnowledgeAgentInput) => {
      assertTrustedSender(event)
      return service.saveAgent(input)
    }
  )
  ipcMain.handle(
    knowledgeProcessingChannels.saveAgentDefaultInstructions,
    (event, input: SaveKnowledgeAgentDefaultInstructionsInput) => {
      assertTrustedSender(event)
      return service.saveAgentDefaultInstructions(input)
    }
  )
  ipcMain.handle(
    knowledgeProcessingChannels.previewKnowledgeMaintainer,
    async (event, input: StartKnowledgeAgentPreviewInput) => {
      assertTrustedSender(event)
      return sourceSnapshotOperation(async () => {
        const material = await loadSourceSnapshotMaterial(discovery, input)
        return service.executeMaintenance(
          {
            rawEvidence: material.evidence.rawEvidence,
            canonicalActivity: material.evidence.canonicalActivity
          },
          material.sourceRef,
          input.attention,
          { binding: previewBinding('knowledge_maintainer') }
        )
      })
    }
  )
  ipcMain.handle(
    knowledgeProcessingChannels.startKnowledgeTask,
    async (event, input: StartKnowledgeTaskInput) => {
      assertTrustedSender(event)
      return sourceSnapshotOperation(() => tasks.start(input, {
        maintainer: previewBinding('knowledge_maintainer'),
        reviewer: previewBinding('knowledge_reviewer')
      }))
    }
  )
  ipcMain.handle(knowledgeProcessingChannels.listKnowledgeTasks, (event) => {
    assertTrustedSender(event)
    return tasks.listTasks()
  })
  ipcMain.handle(
    knowledgeProcessingChannels.readKnowledgeTask,
    (event, taskId: string) => {
      assertTrustedSender(event)
      return tasks.readTask(taskId)
    }
  )
  ipcMain.handle(knowledgeProcessingChannels.cancelKnowledgeTask, (event) => {
    assertTrustedSender(event)
    tasks.cancel()
  })
  ipcMain.handle(
    knowledgeProcessingChannels.cancelAgentPreview,
    (event, agentId: KnowledgeAgentId) => {
      assertTrustedSender(event)
      service.cancelAgentInvocation(agentId)
    }
  )

  service.subscribe((state) => {
    const window = getMainWindow()
    if (window && !window.isDestroyed()) {
      window.webContents.send(knowledgeProcessingChannels.state, state)
    }
  })
}

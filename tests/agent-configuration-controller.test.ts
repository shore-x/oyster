import { createRoot } from 'solid-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CHAT_AGENT_ID,
  type ChatApi,
  type ChatSnapshot
} from '../src/shared/chat'
import type {
  KnowledgeProcessingApi,
  KnowledgeProcessingSnapshot,
  ProcessingStageView
} from '../src/shared/knowledge-processing'
import { createAgentConfigurationController } from '../src/renderer/src/agent-configuration-controller'

vi.mock('solid-js', async () => vi.importActual('solid-js/dist/solid.js'))

function processingStage(
  overrides: Pick<ProcessingStageView, 'id' | 'displayName' | 'runtime'>
): ProcessingStageView {
  return {
    ...overrides,
    description: `${overrides.displayName} description`,
    inputDescription: 'input',
    outputDescription: 'output',
    capabilities: [],
    tools: [{
      name: 'list_todos',
      label: '查看待办事项',
      description: 'List Todos.',
      parameters: { type: 'object' }
    }],
    builtInInstructions: `${overrides.displayName} built in`,
    defaultInstructions: `${overrides.displayName} default`,
    effectiveInstructions: `${overrides.displayName} default`,
    isDefaultCustomized: false,
    isCustomized: false
  }
}

const PROCESSING_SNAPSHOT: KnowledgeProcessingSnapshot = {
  stages: [
    processingStage({
      id: 'knowledge_maintenance_agent',
      displayName: 'Knowledge Maintenance Agent',
      runtime: 'pi_agent_core'
    })
  ],
  connections: [],
  runningStageIds: [],
  debugTraces: []
}

const CHAT_SNAPSHOT: ChatSnapshot = {
  agent: {
    id: CHAT_AGENT_ID,
    displayName: '通用 Agent',
    description: 'General Agent description',
    runtime: 'pi_agent_core',
    tools: [],
    builtInInstructions: 'Chat built in',
    defaultInstructions: 'Chat default',
    isDefaultCustomized: false
  },
  sessions: []
}

function installApis() {
  const saveProcessingDefault = vi.fn(async () => PROCESSING_SNAPSHOT)
  const saveChatDefault = vi.fn(async () => CHAT_SNAPSHOT)
  const knowledgeProcessing = {
    getSnapshot: async () => PROCESSING_SNAPSHOT,
    saveDefaultInstructions: saveProcessingDefault,
    subscribe: () => () => undefined
  } as unknown as KnowledgeProcessingApi
  const chat = {
    getSnapshot: async () => CHAT_SNAPSHOT,
    saveDefaultInstructions: saveChatDefault,
    subscribe: () => () => undefined
  } as unknown as ChatApi
  vi.stubGlobal('window', { oyster: { knowledgeProcessing, chat } })
  return { saveProcessingDefault, saveChatDefault }
}

afterEach(() => vi.unstubAllGlobals())

describe('agent configuration controller', () => {
  it('lists only actual Agents and routes their default Prompt changes', async () => {
    const { saveProcessingDefault, saveChatDefault } = installApis()

    await createRoot(async (dispose) => {
      try {
        const controller = createAgentConfigurationController()
        await vi.waitFor(() => expect(controller.loading()).toBe(false))

        expect(controller.roles().map((role) => role.id)).toEqual([
          'knowledge_maintenance_agent',
          CHAT_AGENT_ID
        ])
        expect(controller.roles().every((role) => role.runtime === 'pi_agent_core')).toBe(true)
        await expect(controller.saveDefaultInstructions(
          'knowledge_maintenance_agent',
          'Maintainer override'
        )).resolves.toBe(true)
        expect(saveProcessingDefault).toHaveBeenCalledWith({
          stageId: 'knowledge_maintenance_agent',
          instructionsOverride: 'Maintainer override'
        })

        await expect(controller.saveDefaultInstructions(
          CHAT_AGENT_ID,
          'Chat override'
        )).resolves.toBe(true)
        expect(saveChatDefault).toHaveBeenCalledWith({
          instructionsOverride: 'Chat override'
        })
      } finally {
        dispose()
      }
    })
  })
})

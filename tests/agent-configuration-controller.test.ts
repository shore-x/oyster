import { createRoot } from 'solid-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CHAT_AGENT_ID,
  type ChatApi,
  type ChatStateView
} from '../src/shared/chat'
import type {
  KnowledgeProcessingApi,
  KnowledgeProcessingStateView,
  KnowledgeAgentDefinitionView
} from '../src/shared/knowledge-processing'
import { createAgentConfigurationController } from '../src/renderer/src/agent-configuration-controller'

vi.mock('solid-js', async () => vi.importActual('solid-js/dist/solid.js'))

function knowledgeAgent(
  overrides: Pick<KnowledgeAgentDefinitionView, 'id' | 'displayName' | 'runtime'>
): KnowledgeAgentDefinitionView {
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

const PROCESSING_SNAPSHOT: KnowledgeProcessingStateView = {
  agents: [
    knowledgeAgent({
      id: 'knowledge_maintainer',
      displayName: 'Knowledge Maintenance Agent',
      runtime: 'pi_coding_agent'
    })
  ],
  connections: [],
  activeAgentIds: [],
  liveInvocations: []
}

const CHAT_SNAPSHOT: ChatStateView = {
  agent: {
    id: CHAT_AGENT_ID,
    displayName: '通用 Agent',
    description: 'General Agent description',
    runtime: 'pi_coding_agent',
    tools: [],
    builtInInstructions: 'Chat built in',
    defaultInstructions: 'Chat default',
    isDefaultCustomized: false
  },
  conversations: []
}

function installApis() {
  const saveProcessingDefault = vi.fn(async () => PROCESSING_SNAPSHOT)
  const saveChatDefault = vi.fn(async () => CHAT_SNAPSHOT)
  const knowledgeProcessing = {
    getState: async () => PROCESSING_SNAPSHOT,
    saveAgentDefaultInstructions: saveProcessingDefault,
    subscribe: () => () => undefined
  } as unknown as KnowledgeProcessingApi
  const chat = {
    getState: async () => CHAT_SNAPSHOT,
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
          'knowledge_maintainer',
          CHAT_AGENT_ID
        ])
        expect(controller.roles().every((role) => role.runtime === 'pi_coding_agent')).toBe(true)
        await expect(controller.saveDefaultInstructions(
          'knowledge_maintainer',
          'Maintainer override'
        )).resolves.toBe(true)
        expect(saveProcessingDefault).toHaveBeenCalledWith({
          agentId: 'knowledge_maintainer',
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

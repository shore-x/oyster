import { createMemo, createSignal, onCleanup } from 'solid-js'
import { CHAT_AGENT_ID, type ChatAgentConfigurationView, type ChatStateView } from '../../shared/chat'
import type {
  KnowledgeProcessingStateView,
  KnowledgeAgentId,
  KnowledgeAgentDefinitionView,
  AgentToolDefinitionView
} from '../../shared/knowledge-processing'

const EMPTY_PROCESSING_STATE: KnowledgeProcessingStateView = {
  agents: [],
  connections: [],
  activeAgentIds: [],
  liveInvocations: []
}

const EMPTY_CHAT_STATE: ChatStateView = {
  agent: {
    id: CHAT_AGENT_ID,
    displayName: '通用 Agent',
    description: '',
    runtime: 'pi_coding_agent',
    tools: [],
    builtInInstructions: '',
    defaultInstructions: '',
    isDefaultCustomized: false
  },
  conversations: []
}

export type AgentConfigurationRoleId = KnowledgeAgentId | typeof CHAT_AGENT_ID

export interface AgentConfigurationRoleView {
  id: AgentConfigurationRoleId
  displayName: string
  description: string
  runtime: 'pi_coding_agent'
  tools: AgentToolDefinitionView[]
  builtInInstructions: string
  defaultInstructions: string
  isDefaultCustomized: boolean
  promptUsageDescription: string
  promptUsageStatus: string
}

function isKnowledgeAgent(
  agent: KnowledgeAgentDefinitionView
): agent is KnowledgeAgentDefinitionView & { runtime: 'pi_coding_agent' } {
  return agent.runtime === 'pi_coding_agent'
}

function chatRole(agent: ChatAgentConfigurationView): AgentConfigurationRoleView {
  return {
    ...agent,
    promptUsageDescription: '新建对话会固化当时的默认 Prompt；已有对话继续使用创建时的配置。',
    promptUsageStatus: '新建对话使用默认'
  }
}

export function createAgentConfigurationController() {
  const [processingState, setProcessingState] = createSignal(EMPTY_PROCESSING_STATE)
  const [chatState, setChatState] = createSignal(EMPTY_CHAT_STATE)
  const [pendingLoads, setPendingLoads] = createSignal(2)
  const [savingRoleId, setSavingRoleId] = createSignal<AgentConfigurationRoleId>()
  const [savedRoleId, setSavedRoleId] = createSignal<AgentConfigurationRoleId>()
  const [error, setError] = createSignal<string>()

  const roles = createMemo<AgentConfigurationRoleView[]>(() => [
    ...processingState().agents
      .filter(isKnowledgeAgent)
      .map((agent) => ({
        id: agent.id,
        displayName: agent.displayName,
        description: agent.description,
        runtime: agent.runtime,
        tools: agent.tools,
        builtInInstructions: agent.builtInInstructions,
        defaultInstructions: agent.defaultInstructions,
        isDefaultCustomized: agent.isDefaultCustomized,
        promptUsageDescription: '没有 Agent 覆盖的调用使用此值；测试页的 Agent 覆盖优先级更高。',
        promptUsageStatus: agent.isCustomized ? 'Agent Preview 存在覆盖' : '当前调用使用默认'
      })),
    chatRole(chatState().agent)
  ])
  const configurationErrors = createMemo(() => [
    processingState().configurationError,
    chatState().configurationError
  ].filter((message): message is string => Boolean(message)))

  const errorMessage = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause)
  const unsubscribeProcessing = window.oyster.knowledgeProcessing.subscribe(setProcessingState)
  const unsubscribeChat = window.oyster.chat.subscribe((event) => {
    if (event.type === 'state_changed') setChatState(event.state)
  })
  onCleanup(() => {
    unsubscribeProcessing()
    unsubscribeChat()
  })

  const loaded = (): void => {
    setPendingLoads((count) => Math.max(0, count - 1))
  }
  void window.oyster.knowledgeProcessing.getState()
    .then(setProcessingState)
    .catch((cause) => setError(errorMessage(cause)))
    .finally(loaded)
  void window.oyster.chat.getState()
    .then(setChatState)
    .catch((cause) => setError(errorMessage(cause)))
    .finally(loaded)

  async function saveDefaultInstructions(
    roleId: AgentConfigurationRoleId,
    instructionsOverride: string | null
  ): Promise<boolean> {
    try {
      setSavingRoleId(roleId)
      setSavedRoleId(undefined)
      setError(undefined)
      if (roleId === CHAT_AGENT_ID) {
        setChatState(await window.oyster.chat.saveDefaultInstructions({ instructionsOverride }))
      } else {
        setProcessingState(await window.oyster.knowledgeProcessing.saveAgentDefaultInstructions({
          agentId: roleId,
          instructionsOverride
        }))
      }
      setSavedRoleId(roleId)
      return true
    } catch (cause) {
      setError(errorMessage(cause))
      return false
    } finally {
      setSavingRoleId(undefined)
    }
  }

  return {
    roles,
    configurationErrors,
    loading: () => pendingLoads() > 0,
    error,
    isSaving: (roleId: AgentConfigurationRoleId) => savingRoleId() === roleId,
    wasSaved: (roleId: AgentConfigurationRoleId) => savedRoleId() === roleId,
    saveDefaultInstructions
  }
}

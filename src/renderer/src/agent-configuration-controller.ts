import { createMemo, createSignal, onCleanup } from 'solid-js'
import { CHAT_AGENT_ID, type ChatAgentConfigurationView, type ChatSnapshot } from '../../shared/chat'
import type {
  KnowledgeProcessingSnapshot,
  ProcessingStageId,
  ProcessingStageView,
  ProcessingToolView
} from '../../shared/knowledge-processing'

const EMPTY_PROCESSING_SNAPSHOT: KnowledgeProcessingSnapshot = {
  stages: [],
  connections: [],
  runningStageIds: [],
  debugTraces: []
}

const EMPTY_CHAT_SNAPSHOT: ChatSnapshot = {
  agent: {
    id: CHAT_AGENT_ID,
    displayName: '通用 Agent',
    description: '',
    runtime: 'pi_agent_core',
    tools: [],
    builtInInstructions: '',
    defaultInstructions: '',
    isDefaultCustomized: false
  },
  sessions: []
}

export type AgentConfigurationRoleId = ProcessingStageId | typeof CHAT_AGENT_ID

export interface AgentConfigurationRoleView {
  id: AgentConfigurationRoleId
  displayName: string
  description: string
  runtime: 'pi_agent_core'
  tools: ProcessingToolView[]
  builtInInstructions: string
  defaultInstructions: string
  isDefaultCustomized: boolean
  promptUsageDescription: string
  promptUsageStatus: string
}

function isAgentStage(
  stage: ProcessingStageView
): stage is ProcessingStageView & { runtime: 'pi_agent_core' } {
  return stage.runtime === 'pi_agent_core'
}

function chatRole(agent: ChatAgentConfigurationView): AgentConfigurationRoleView {
  return {
    ...agent,
    promptUsageDescription: '新建对话会固化当时的默认 Prompt；已有对话继续使用创建时的配置。',
    promptUsageStatus: '新建对话使用默认'
  }
}

export function createAgentConfigurationController() {
  const [processingSnapshot, setProcessingSnapshot] = createSignal(EMPTY_PROCESSING_SNAPSHOT)
  const [chatSnapshot, setChatSnapshot] = createSignal(EMPTY_CHAT_SNAPSHOT)
  const [pendingLoads, setPendingLoads] = createSignal(2)
  const [savingRoleId, setSavingRoleId] = createSignal<AgentConfigurationRoleId>()
  const [savedRoleId, setSavedRoleId] = createSignal<AgentConfigurationRoleId>()
  const [error, setError] = createSignal<string>()

  const roles = createMemo<AgentConfigurationRoleView[]>(() => [
    ...processingSnapshot().stages
      .filter(isAgentStage)
      .map((stage) => ({
        id: stage.id,
        displayName: stage.displayName,
        description: stage.description,
        runtime: stage.runtime,
        tools: stage.tools,
        builtInInstructions: stage.builtInInstructions,
        defaultInstructions: stage.defaultInstructions,
        isDefaultCustomized: stage.isDefaultCustomized,
        promptUsageDescription: '没有阶段覆盖的加工运行使用此值；加工测试页的阶段覆盖优先级更高。',
        promptUsageStatus: stage.isCustomized ? '加工测试存在覆盖' : '当前运行使用默认'
      })),
    chatRole(chatSnapshot().agent)
  ])
  const configurationErrors = createMemo(() => [
    processingSnapshot().configurationError,
    chatSnapshot().configurationError
  ].filter((message): message is string => Boolean(message)))

  const errorMessage = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause)
  const unsubscribeProcessing = window.oyster.knowledgeProcessing.subscribe(setProcessingSnapshot)
  const unsubscribeChat = window.oyster.chat.subscribe((event) => {
    if (event.type === 'snapshot_changed') setChatSnapshot(event.snapshot)
  })
  onCleanup(() => {
    unsubscribeProcessing()
    unsubscribeChat()
  })

  const loaded = (): void => {
    setPendingLoads((count) => Math.max(0, count - 1))
  }
  void window.oyster.knowledgeProcessing.getSnapshot()
    .then(setProcessingSnapshot)
    .catch((cause) => setError(errorMessage(cause)))
    .finally(loaded)
  void window.oyster.chat.getSnapshot()
    .then(setChatSnapshot)
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
        setChatSnapshot(await window.oyster.chat.saveDefaultInstructions({ instructionsOverride }))
      } else {
        setProcessingSnapshot(await window.oyster.knowledgeProcessing.saveDefaultInstructions({
          stageId: roleId,
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

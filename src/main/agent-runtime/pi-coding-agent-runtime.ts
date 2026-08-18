import type { AgentMessage, AgentTool, StreamFn } from '@earendil-works/pi-agent-core'
import {
  InMemoryCredentialStore,
  type Api,
  type Model,
  type Provider
} from '@earendil-works/pi-ai'
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime as PiModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ResourceLoader,
  type ToolDefinition
} from '@earendil-works/pi-coding-agent'
import type { ReasoningEffort } from '../../shared/ai-backends'
import { DEFAULT_APP_SETTINGS, type AppLanguage } from '../../shared/app-settings'
import type {
  AgentInvocationDebugRecord,
  AgentModelCallPurpose
} from '../../shared/agent-runtime'
import type { SelectedModelStream } from '../ai-backends/model'
import { createArtifactGitEnvironment } from '../artifacts/git-runtime'
import { AgentTodoStore, createAgentTodoTools } from './agent-todos'
import { withAgentLanguage } from './agent-language'
import type { AgentDebugStore } from './agent-debug-store'
import {
  createPiAgentInvocationRecorder,
  type PiAgentInvocationRecorder
} from './pi-agent-invocation-recorder'

const RUNTIME_FEEDBACK_CUSTOM_TYPE = 'oyster-runtime-feedback-v1'

const AGENT_TURN_RETRY = {
  enabled: true,
  maxRetries: 3,
  baseDelayMs: 2_000,
  // Keep retries at one layer so the total retry budget remains predictable.
  provider: { maxRetries: 0 }
} as const

/** Initial handoff attempt plus two Host feedback turns. */
export const MAX_AGENT_HANDOFF_FEEDBACKS = 2

export type PiCodingAgentResourceMode = 'ecosystem' | 'disabled'

export interface CreatePiCodingAgentInvocationOptions {
  agentId: string
  invocationId: string
  parentInvocationId?: string
  onInvocationUpdate?: (record: AgentInvocationDebugRecord) => void
  debugStore: AgentDebugStore
  modelStream: SelectedModelStream
  cwd: string
  agentDir: string
  systemPrompt: string
  language?: AppLanguage
  reasoningEffort?: ReasoningEffort
  piSessionManager: SessionManager
  resourceMode: PiCodingAgentResourceMode
  /** Omit to use Coding Agent's default read/bash/edit/write set. */
  tools?: string[]
  customTools?: AgentTool[]
  initialTodos?: readonly string[]
  /** Chat enables Host-owned Todos; constrained knowledge roles do not expose them. */
  todoTools?: boolean
}

export interface PiCodingAgentInvocation {
  session: AgentSession
  recorder: PiAgentInvocationRecorder
  todos: AgentTodoStore
  dispose(): void
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

/** Keep SDK bash commands on Oyster's bundled Git without changing the process environment. */
function artifactGitCommandPrefix(): string {
  const base = process.env
  const artifact = createArtifactGitEnvironment(base)
  const keys = new Set([
    ...Object.keys(base).filter((key) => key.toUpperCase().startsWith('GIT_')),
    ...Object.keys(artifact).filter((key) => key.toUpperCase().startsWith('GIT_')),
    Object.keys(artifact).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
  ])
  const assignments = [...keys].sort().flatMap((key) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return []
    const value = artifact[key]
    return [value === undefined
      ? `unset ${key}`
      : `export ${key}=${shellQuote(value)}`]
  })
  return assignments.length ? `${assignments.join('; ')};` : ''
}

function toolDefinition(tool: AgentTool): ToolDefinition {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.executionMode ? { executionMode: tool.executionMode } : {}),
    execute: (toolCallId, parameters, signal, onUpdate) => tool.execute(
      toolCallId,
      parameters,
      signal,
      onUpdate
    )
  } as ToolDefinition
}

function selectedModelProvider(modelStream: SelectedModelStream, streamFn: StreamFn): Provider<Api> {
  const model = modelStream.model
  const stream = (requestedModel: Model<Api>, context: Parameters<StreamFn>[1], options?: Parameters<StreamFn>[2]) => (
    streamFn(requestedModel, context, options)
  )
  return {
    id: model.provider,
    name: `Oyster Connection (${model.provider})`,
    auth: {
      apiKey: {
        name: 'Oyster Connection',
        resolve: async () => ({ auth: {}, source: 'Oyster Connection' })
      }
    },
    getModels: () => [model],
    stream,
    streamSimple: stream
  } as Provider<Api>
}

async function modelRuntimeBridge(
  modelStream: SelectedModelStream,
  recorder: PiAgentInvocationRecorder,
  purpose: () => AgentModelCallPurpose
): Promise<PiModelRuntime> {
  const modelRuntime = await PiModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false
  })
  modelRuntime.registerNativeProvider(selectedModelProvider(
    modelStream,
    recorder.wrapStreamFn(modelStream.streamFn, purpose)
  ))
  return modelRuntime
}

function resourceLoader(
  options: CreatePiCodingAgentInvocationOptions,
  settingsManager: SettingsManager
): ResourceLoader {
  return new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
    systemPromptOverride: () => withAgentLanguage(
      options.systemPrompt,
      options.language ?? DEFAULT_APP_SETTINGS.agentLanguage
    ),
    ...(options.resourceMode === 'disabled' ? {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true
    } : {
      // The desktop integration supports executable Headless Extensions only.
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true
    })
  })
}

function applyRuntimeSettings(settingsManager: SettingsManager): void {
  settingsManager.applyOverrides({
    shellCommandPrefix: artifactGitCommandPrefix(),
    retry: AGENT_TURN_RETRY,
    images: { autoResize: false, blockImages: false }
  })
}

function finalAssistantMessage(messages: readonly AgentMessage[]): Extract<AgentMessage, { role: 'assistant' }> | undefined {
  return [...messages].reverse().find(
    (message): message is Extract<AgentMessage, { role: 'assistant' }> => message.role === 'assistant'
  )
}

function runtimeFeedback(reasons: readonly string[]): AgentMessage {
  return {
    role: 'custom',
    customType: RUNTIME_FEEDBACK_CUSTOM_TYPE,
    content: [{
      type: 'text',
      text: [
        'The Agent cannot finish yet:',
        ...reasons.map((reason) => `- ${reason}`),
        'Continue working. Use the available tools to inspect current invocation state when needed.'
      ].join('\n')
    }],
    display: false,
    timestamp: Date.now()
  } as AgentMessage
}

function handoffFeedback(error: unknown, feedbackNumber: number): AgentMessage {
  const reason = error instanceof Error
    ? error.message
    : (typeof error === 'string' && error ? error : 'Unknown handoff validation failure')
  return runtimeFeedback([
    `The Host rejected this handoff: ${reason}`,
    `This is handoff feedback ${feedbackNumber} of ${MAX_AGENT_HANDOFF_FEEDBACKS}. Inspect the current repository state, correct every related issue, commit all intended changes, and finish naturally again.`
  ])
}

export function isPiCodingAgentRuntimeFeedback(message: AgentMessage): boolean {
  return message.role === 'custom'
    && (message as AgentMessage & { customType?: string }).customType === RUNTIME_FEEDBACK_CUSTOM_TYPE
}

export async function createPiCodingAgentInvocation(
  options: CreatePiCodingAgentInvocationOptions
): Promise<PiCodingAgentInvocation> {
  const todos = new AgentTodoStore(options.initialTodos)
  const recorder = createPiAgentInvocationRecorder({
    agentId: options.agentId,
    invocationId: options.invocationId,
    ...(options.parentInvocationId ? { parentInvocationId: options.parentInvocationId } : {}),
    sessionManager: options.piSessionManager,
    debugStore: options.debugStore,
    ...(options.onInvocationUpdate ? { onUpdate: options.onInvocationUpdate } : {}),
    completeOnAgentEnd: false
  })
  let modelCallPurpose: AgentModelCallPurpose = 'agent'
  const piModelRuntime = await modelRuntimeBridge(options.modelStream, recorder, () => modelCallPurpose)
  const settingsManager = options.resourceMode === 'ecosystem'
    // Oyster has no project-trust prompt yet. Keep project .pi settings/packages/extensions
    // disabled while still loading user resources from the explicit agentDir and context files.
    ? SettingsManager.create(options.cwd, options.agentDir, { projectTrusted: false })
    : SettingsManager.inMemory()
  applyRuntimeSettings(settingsManager)
  const loader = resourceLoader(options, settingsManager)
  await loader.reload()
  // Resource loading reloads file-backed settings; Host invariants must win afterwards.
  applyRuntimeSettings(settingsManager)
  const todoTools = options.todoTools === false ? [] : createAgentTodoTools(todos)
  const customTools = [...(options.customTools ?? []), ...todoTools]
  const activeTools = options.tools
    ? [...options.tools, ...customTools.map((tool) => tool.name)]
    : undefined
  const { session } = await createAgentSession({
    cwd: options.cwd,
    agentDir: options.agentDir,
    modelRuntime: piModelRuntime,
    model: options.modelStream.model,
    thinkingLevel: options.modelStream.model.reasoning ? (options.reasoningEffort ?? 'off') : 'off',
    sessionManager: options.piSessionManager,
    settingsManager,
    resourceLoader: loader,
    customTools: customTools.map(toolDefinition),
    ...(activeTools ? { tools: activeTools } : {})
  })
  await session.bindExtensions({
    // Electron owns presentation; Pi TUI components are intentionally unavailable.
    mode: 'print',
    abortHandler: () => { void session.abort() },
    shutdownHandler: () => { void session.abort() }
  })
  const detachRecorder = recorder.attach(session.agent)
  const detachSession = session.subscribe((event) => {
    if (event.type === 'compaction_start') modelCallPurpose = 'context_compaction'
    if (event.type === 'compaction_end') modelCallPurpose = 'agent'
    if (
      event.type !== 'turn_end'
      || event.toolResults.length !== 0
      || event.message.role !== 'assistant'
      || event.message.stopReason !== 'stop'
      || session.agent.hasQueuedMessages()
      || todos.pendingCount === 0
    ) return
    session.agent.followUp(runtimeFeedback([
      `${todos.pendingCount} Todos remain pending. Use list_todos to inspect them and complete_todos after finishing each item.`
    ]))
  })
  return {
    session,
    recorder,
    todos,
    dispose: () => {
      detachSession()
      detachRecorder()
      session.dispose()
    }
  }
}

async function runPiCodingAgentPrompt(
  invocation: PiCodingAgentInvocation,
  prompt: string | AgentMessage,
  signal: AbortSignal,
  label: string
): Promise<void> {
  signal.throwIfAborted()
  const abort = (): void => { void invocation.session.abort() }
  signal.addEventListener('abort', abort, { once: true })
  try {
    const active = typeof prompt === 'string'
      ? invocation.session.prompt(prompt)
      : invocation.session.agent.prompt(prompt)
    if (signal.aborted) await invocation.session.abort()
    await active
    await invocation.session.waitForIdle()
  } finally {
    signal.removeEventListener('abort', abort)
  }
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error(`${label} Agent Invocation 已取消`)
  }
  const final = finalAssistantMessage(invocation.session.messages)
  if (!final || final.stopReason === 'error') {
    throw new Error(final?.errorMessage || invocation.session.state.errorMessage || `${label} 模型调用失败`)
  }
}

export async function promptPiCodingAgent(
  invocation: PiCodingAgentInvocation,
  prompt: string,
  signal: AbortSignal,
  label: string
): Promise<void> {
  await runPiCodingAgentPrompt(invocation, prompt, signal, label)
}

/**
 * Keeps one Pi Session and Invocation alive until the Agent's natural handoff satisfies the
 * Host-owned boundary check. A failed check becomes ordinary runtime feedback, not a new role
 * invocation or collaboration round.
 */
export async function promptPiCodingAgentUntilHandoff(
  invocation: PiCodingAgentInvocation,
  prompt: string,
  validateHandoff: () => Promise<void>,
  signal: AbortSignal,
  label: string
): Promise<void> {
  let nextPrompt: string | AgentMessage = prompt
  for (let feedbackCount = 0; ; feedbackCount += 1) {
    await runPiCodingAgentPrompt(invocation, nextPrompt, signal, label)

    try {
      await validateHandoff()
      return
    } catch (error) {
      if (feedbackCount >= MAX_AGENT_HANDOFF_FEEDBACKS) {
        const reason = error instanceof Error
          ? error.message
          : (typeof error === 'string' && error ? error : '未知错误')
        throw new Error(
          `Agent 交接在 ${MAX_AGENT_HANDOFF_FEEDBACKS} 次 Host 反馈后仍未通过：${reason}`,
          { cause: error }
        )
      }
      nextPrompt = handoffFeedback(error, feedbackCount + 1)
    }
  }
}

export function piCodingAgentFinalAssistant(
  invocation: PiCodingAgentInvocation
): Extract<AgentMessage, { role: 'assistant' }> | undefined {
  return finalAssistantMessage(invocation.session.messages)
}

export { SessionManager }

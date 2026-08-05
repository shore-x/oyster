import { randomUUID } from 'node:crypto'
import { Agent, type AgentMessage, type AgentTool } from '@earendil-works/pi-agent-core'
import { createCodingTools } from '@earendil-works/pi-coding-agent'
import { ModelConnectionFailureError } from '../ai-backends/model'
import {
  createPiContextCompactor,
  PiContextCompactionOutputError,
  PiContextWindowError
} from '../agent-runtime/pi-context-compactor'
import {
  convertPiAgentMessages,
  createPiAgentRuntime,
  isAgentRuntimeFeedbackMessage
} from '../agent-runtime/pi-agent-runtime'
import type { KnowledgeStatement } from '../../shared/knowledge'
import type { PiChatAgentRunInput, ChatKnowledgeStore } from './model'
import { chatMessageView, serializableChatValue } from './chat-message-view'
import {
  chatAgentToolDefinition,
  spawnAgentParameters,
  upsertKnowledgeParameters
} from './chat-tool-catalog'
import {
  readKnowledgeParameters,
  searchKnowledgeParameters
} from '../knowledge-processing/knowledge-maintenance-tool-catalog'
import { createArtifactGitEnvironment } from '../artifacts/git-runtime'
import { chatAgentSystemPrompt } from './prompt'

function asError(value: unknown, fallback: string): Error {
  if (value instanceof Error) return value
  if (typeof value === 'string' && value) return new Error(value)
  return new Error(fallback)
}

function compactInline(value: string, maximum: number): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length <= maximum ? compact : `${compact.slice(0, maximum - 1)}…`
}

function statementText(statement: KnowledgeStatement): string {
  return `Title: ${statement.title}\nContent:\n${statement.content}`
}

function finalAssistantText(messages: readonly AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== 'assistant') continue
    const text = message.content.flatMap((block) => (
      block.type === 'text' ? [block.text] : []
    )).join('\n')
    return text
  }
  return ''
}

interface CreatedAgentRun {
  agent: Agent
  getCompactionError(): Error | undefined
}

function assertAgentRunSucceeded(run: CreatedAgentRun, label: string): void {
  const compactionError = run.getCompactionError()
  if (
    compactionError instanceof PiContextWindowError
    || compactionError instanceof PiContextCompactionOutputError
  ) {
    throw compactionError
  }
  if (compactionError) throw new ModelConnectionFailureError(compactionError)
  if (run.agent.state.errorMessage) {
    throw new ModelConnectionFailureError(new Error(`${label} 模型调用失败：${run.agent.state.errorMessage}`))
  }
}

async function promptAgentRun(
  run: CreatedAgentRun,
  prompt: string,
  signal: AbortSignal | undefined,
  label: string
): Promise<void> {
  signal?.throwIfAborted()
  const abortAgent = (): void => run.agent.abort()
  signal?.addEventListener('abort', abortAgent, { once: true })
  try {
    const activeRun = run.agent.prompt(prompt)
    if (signal?.aborted) run.agent.abort()
    await activeRun
  } finally {
    signal?.removeEventListener('abort', abortAgent)
  }
  if (signal?.aborted) throw asError(signal.reason, `${label} 运行已取消`)
  assertAgentRunSucceeded(run, label)
}

function safeEmit(
  input: PiChatAgentRunInput,
  event: Parameters<NonNullable<PiChatAgentRunInput['onEvent']>>[0]
): void {
  try {
    input.onEvent?.(event)
  } catch {
    // UI diagnostics must never change conversational Agent behavior.
  }
}

function knowledgeTools(
  store: ChatKnowledgeStore,
  agentRunId: string
): AgentTool[] {
  return [
    {
      ...chatAgentToolDefinition('search_knowledge'),
      executionMode: 'sequential',
      execute: async (_toolCallId, parameters, signal) => {
        signal?.throwIfAborted()
        const query = parameters.query.trim()
        if (!query) throw new Error('搜索 query 去除空白后不能为空')
        const limit = parameters.limit ?? 8
        const offset = parameters.offset ?? 0
        const records = (await store.search(query, limit, offset, signal)).slice(0, limit)
        const hasNextPage = records.length === limit
        return {
          content: [{
            type: 'text',
            text: records.length
              ? [
                  ...records.map((record) => (
                    `- Title: ${compactInline(record.title, 512)}\n  Preview: ${compactInline(record.content, 1_024)}`
                  )),
                  '',
                  `Next offset: ${hasNextPage ? offset + records.length : 'none'}`
                ].join('\n')
              : 'No matching Knowledge Statements.\nNext offset: none'
          }],
          details: {
            count: records.length,
            offset,
            nextOffset: hasNextPage ? offset + records.length : null
          }
        }
      }
    } as AgentTool<typeof searchKnowledgeParameters>,
    {
      ...chatAgentToolDefinition('read_knowledge'),
      executionMode: 'sequential',
      execute: async (_toolCallId, parameters, signal) => {
        signal?.throwIfAborted()
        const title = parameters.title.trim()
        if (!title) throw new Error('Statement title 去除空白后不能为空')
        const statement = await store.read(title, signal)
        return {
          content: [{
            type: 'text',
            text: statement ? statementText(statement) : 'Knowledge Statement not found.'
          }],
          details: { found: Boolean(statement), title }
        }
      }
    } as AgentTool<typeof readKnowledgeParameters>,
    {
      ...chatAgentToolDefinition('upsert_knowledge'),
      executionMode: 'sequential',
      execute: async (_toolCallId, parameters, signal) => {
        signal?.throwIfAborted()
        const result = store.commit({
          runRef: `chat:${agentRunId}:${randomUUID()}`,
          statements: parameters.statements
        })
        return {
          content: [{
            type: 'text',
            text: [
              `Committed ${result.statements.length} Knowledge Statements.`,
              result.createdTitles.length ? `Created: ${result.createdTitles.join(', ')}` : undefined,
              result.updatedTitles.length ? `Updated: ${result.updatedTitles.join(', ')}` : undefined
            ].filter((part): part is string => Boolean(part)).join('\n')
          }],
          details: {
            runRef: result.contribution.runRef,
            statementCount: result.statements.length,
            createdTitles: result.createdTitles,
            updatedTitles: result.updatedTitles
          }
        }
      }
    } as AgentTool<typeof upsertKnowledgeParameters>
  ]
}

function codingTools(artifactRepositoryPath: string): AgentTool[] {
  return createCodingTools(artifactRepositoryPath, {
    bash: {
      spawnHook: (context) => ({
        ...context,
        env: createArtifactGitEnvironment(context.env)
      })
    }
  })
}

/** A regular, unrestricted Pi Agent loop with filesystem, shell, and Knowledge tools. */
export class PiChatAgent {
  constructor(
    private readonly knowledgeStore: ChatKnowledgeStore,
    private readonly artifactRepositoryPath: string
  ) {}

  async run(input: PiChatAgentRunInput): Promise<void> {
    if (!input.text.trim()) throw new Error('消息不能为空')
    input.signal.throwIfAborted()

    const context = await input.session.buildContext()
    input.signal.throwIfAborted()
    const systemPrompt = chatAgentSystemPrompt(
      input.binding.systemPrompt,
      this.artifactRepositoryPath
    )
    const thinkingLevel = input.runtime.model.reasoning
      ? (input.binding.reasoningEffort ?? 'off')
      : 'off'

    const createRun: (
      agentRunId: string,
      messages: AgentMessage[],
      initialTodos?: readonly string[]
    ) => CreatedAgentRun = (agentRunId, messages, initialTodos) => {
      let compactionError: Error | undefined
      const agentRuntime = createPiAgentRuntime({ initialTodos })
      const tools: AgentTool[] = [
        ...codingTools(this.artifactRepositoryPath),
        ...knowledgeTools(this.knowledgeStore, agentRunId),
        {
          ...chatAgentToolDefinition('spawn_agent'),
          execute: async (_toolCallId, parameters, signal) => {
            const task = parameters.task.trim()
            if (!task) throw new Error('子 Agent task 去除空白后不能为空')
            signal?.throwIfAborted()

            const childRunId = randomUUID()
            const childRun = createRun(childRunId, [])
            await promptAgentRun(childRun, task, signal, '子 Agent')
            return {
              content: [{
                type: 'text',
                text: finalAssistantText(childRun.agent.state.messages)
                  || 'Child Agent completed without a final text response.'
              }],
              details: {
                runId: childRunId,
                modelId: input.runtime.model.id,
                transcript: serializableChatValue(childRun.agent.state.messages)
              }
            }
          }
        } as AgentTool<typeof spawnAgentParameters>,
        ...agentRuntime.tools
      ]
      const compactContext = createPiContextCompactor({
        model: input.runtime.model,
        streamFn: input.runtime.streamFn,
        systemPrompt,
        tools,
        thinkingLevel,
        onModelCall: (event) => {
          if (event.type === 'failed') {
            compactionError = event.error ?? new Error('Context compaction failed')
          }
        }
      })
      const agent = new Agent({
        initialState: {
          systemPrompt,
          model: input.runtime.model,
          thinkingLevel,
          tools,
          messages
        },
        streamFn: input.runtime.streamFn,
        convertToLlm: convertPiAgentMessages,
        transformContext: async (currentMessages, signal) => {
          try {
            return await compactContext(currentMessages, signal)
          } catch (error) {
            compactionError = asError(error, 'Context compaction failed')
            throw compactionError
          }
        },
        toolExecution: 'sequential',
        sessionId: agentRunId
      })
      agentRuntime.attach(agent)
      return {
        agent,
        getCompactionError: () => compactionError
      }
    }

    const rootRun = createRun(input.sessionId, context.messages, input.initialTodos)
    const agent = rootRun.agent

    agent.subscribe(async (event) => {
      if (event.type === 'message_update') {
        safeEmit(input, {
          type: 'message_updated',
          sessionId: input.sessionId,
          message: chatMessageView(event.message)
        })
        return
      }
      if (event.type === 'message_end') {
        const entryId = await input.session.appendMessage(event.message)
        if (isAgentRuntimeFeedbackMessage(event.message)) return
        const entry = await input.session.getEntry(entryId)
        if (!entry || entry.type !== 'message') throw new Error('对话消息持久化失败')
        safeEmit(input, {
          type: 'message_appended',
          sessionId: input.sessionId,
          entry: {
            id: entry.id,
            createdAt: entry.timestamp,
            message: chatMessageView(entry.message)
          }
        })
        return
      }
      if (event.type === 'tool_execution_start') {
        safeEmit(input, {
          type: 'tool_started',
          sessionId: input.sessionId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: serializableChatValue(event.args)
        })
        return
      }
      if (event.type === 'tool_execution_end') {
        safeEmit(input, {
          type: 'tool_completed',
          sessionId: input.sessionId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: serializableChatValue(event.result),
          isError: event.isError
        })
      }
    })

    await promptAgentRun(rootRun, input.text, input.signal, '对话 Agent')
  }
}

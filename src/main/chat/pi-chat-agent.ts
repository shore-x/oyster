import { randomUUID } from 'node:crypto'
import { Agent, type AgentTool } from '@earendil-works/pi-agent-core'
import { ModelConnectionFailureError } from '../ai-backends/model'
import {
  createPiContextCompactor,
  PiContextCompactionOutputError,
  PiContextWindowError
} from '../agent-runtime/pi-context-compactor'
import type { KnowledgeStatement } from '../../shared/knowledge'
import type { PiChatAgentRunInput, ChatKnowledgeStore } from './model'
import { chatMessageView, serializableChatValue } from './chat-message-view'
import {
  chatAgentToolDefinition,
  upsertKnowledgeStatementsParameters
} from './chat-tool-catalog'
import {
  readKnowledgeParameters,
  searchKnowledgeParameters
} from '../knowledge-processing/knowledge-maintenance-tool-catalog'

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
  input: PiChatAgentRunInput
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
      ...chatAgentToolDefinition('read_knowledge_statement'),
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
      ...chatAgentToolDefinition('upsert_knowledge_statements'),
      executionMode: 'sequential',
      execute: async (_toolCallId, parameters, signal) => {
        signal?.throwIfAborted()
        const result = store.commit({
          runRef: `chat:${input.sessionId}:${randomUUID()}`,
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
    } as AgentTool<typeof upsertKnowledgeStatementsParameters>
  ]
}

/** A regular, unrestricted Pi Agent loop with three Knowledge Store tools. */
export class PiChatAgent {
  constructor(private readonly knowledgeStore: ChatKnowledgeStore) {}

  async run(input: PiChatAgentRunInput): Promise<void> {
    if (!input.text.trim()) throw new Error('消息不能为空')
    input.signal.throwIfAborted()

    const context = await input.session.buildContext()
    input.signal.throwIfAborted()
    const tools = knowledgeTools(this.knowledgeStore, input)
    const thinkingLevel = input.runtime.model.reasoning
      ? (input.binding.reasoningEffort ?? 'off')
      : 'off'
    let compactionError: Error | undefined
    const compactContext = createPiContextCompactor({
      model: input.runtime.model,
      streamFn: input.runtime.streamFn,
      systemPrompt: input.binding.systemPrompt,
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
        systemPrompt: input.binding.systemPrompt,
        model: input.runtime.model,
        thinkingLevel,
        tools,
        messages: context.messages
      },
      streamFn: input.runtime.streamFn,
      transformContext: async (messages, signal) => {
        try {
          return await compactContext(messages, signal)
        } catch (error) {
          compactionError = asError(error, 'Context compaction failed')
          throw compactionError
        }
      },
      toolExecution: 'sequential',
      sessionId: input.sessionId
    })

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

    const abortAgent = (): void => agent.abort()
    input.signal.addEventListener('abort', abortAgent, { once: true })
    try {
      const run = agent.prompt(input.text)
      if (input.signal.aborted) agent.abort()
      await run
    } finally {
      input.signal.removeEventListener('abort', abortAgent)
    }

    if (input.signal.aborted) throw asError(input.signal.reason, '对话 Agent 运行已取消')
    if (
      compactionError instanceof PiContextWindowError
      || compactionError instanceof PiContextCompactionOutputError
    ) {
      throw compactionError
    }
    if (compactionError) throw new ModelConnectionFailureError(compactionError)
    if (agent.state.errorMessage) {
      throw new ModelConnectionFailureError(new Error(`对话 Agent 模型调用失败：${agent.state.errorMessage}`))
    }
  }
}

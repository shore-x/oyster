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
import { CHAT_AGENT_ID } from '../../shared/chat'
import type { AgentRunRecord } from '../../shared/agent-runtime'
import type { PiChatAgentRunInput } from './model'
import { chatMessageView, serializableChatValue } from './chat-message-view'
import {
  chatAgentToolDefinition,
  spawnAgentParameters
} from './chat-tool-catalog'
import { createArtifactGitEnvironment } from '../artifacts/git-runtime'
import { chatAgentSystemPrompt } from './prompt'
import { appendChatAgentRun } from './pi-chat-session-repository'
import type { PiAgentRunRecorder } from '../agent-runtime/pi-agent-run-recorder'

function asError(value: unknown, fallback: string): Error {
  if (value instanceof Error) return value
  if (typeof value === 'string' && value) return new Error(value)
  return new Error(fallback)
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
  recorder: PiAgentRunRecorder
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

function codingTools(repositoryPath: string): AgentTool[] {
  return createCodingTools(repositoryPath, {
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
  constructor(private readonly repositoryPath: string) {}

  async run(input: PiChatAgentRunInput): Promise<void> {
    if (!input.text.trim()) throw new Error('消息不能为空')
    input.signal.throwIfAborted()

    const context = await input.session.buildContext()
    input.signal.throwIfAborted()
    const systemPrompt = chatAgentSystemPrompt(
      input.binding.systemPrompt,
      this.repositoryPath
    )
    const thinkingLevel = input.runtime.model.reasoning
      ? (input.binding.reasoningEffort ?? 'off')
      : 'off'

    const childRuns: CreatedAgentRun[] = []
    const observeRun = (run: AgentRunRecord): void => {
      try {
        input.onRunUpdate?.(run)
        safeEmit(input, { type: 'run_updated', sessionId: input.sessionId, run })
      } catch {
        // Run observation must not change conversational Agent behavior.
      }
    }
    const createRun: (
      agentRunId: string,
      messages: AgentMessage[],
      initialTodos?: readonly string[],
      parentRunId?: string
    ) => CreatedAgentRun = (agentRunId, messages, initialTodos, parentRunId) => {
      let compactionError: Error | undefined
      const agentRuntime = createPiAgentRuntime({
        agentId: CHAT_AGENT_ID,
        initialTodos,
        run: {
          runId: agentRunId,
          ...(parentRunId ? { parentRunId } : {}),
          onUpdate: observeRun
        }
      })
      const tools: AgentTool[] = [
        ...codingTools(this.repositoryPath),
        {
          ...chatAgentToolDefinition('spawn_agent'),
          execute: async (_toolCallId, parameters, signal) => {
            const task = parameters.task.trim()
            if (!task) throw new Error('子 Agent task 去除空白后不能为空')
            signal?.throwIfAborted()

            const childRunId = randomUUID()
            const childRun = createRun(childRunId, [], undefined, agentRunId)
            childRuns.push(childRun)
            try {
              await promptAgentRun(childRun, task, signal, '子 Agent')
              childRun.recorder.complete('completed')
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
            } catch (error) {
              childRun.recorder.complete(signal?.aborted ? 'cancelled' : 'failed', error)
              throw error
            }
          }
        } as AgentTool<typeof spawnAgentParameters>,
        ...agentRuntime.tools
      ]
      const compactContext = createPiContextCompactor({
        model: input.runtime.model,
        streamFn: agentRuntime.run.wrapStreamFn(input.runtime.streamFn, 'context_compaction'),
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
        streamFn: agentRuntime.run.wrapStreamFn(input.runtime.streamFn),
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
        recorder: agentRuntime.run,
        getCompactionError: () => compactionError
      }
    }

    const rootRunId = randomUUID()
    const rootRun = createRun(rootRunId, context.messages, input.initialTodos)
    const agent = rootRun.agent

    agent.subscribe(async (event) => {
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
      }
    })

    try {
      await promptAgentRun(rootRun, input.text, input.signal, '对话 Agent')
      rootRun.recorder.complete('completed')
    } catch (error) {
      rootRun.recorder.complete(input.signal.aborted ? 'cancelled' : 'failed', error)
      throw error
    } finally {
      await appendChatAgentRun(input.session, rootRun.recorder.snapshot())
      for (const childRun of childRuns) {
        await appendChatAgentRun(input.session, childRun.recorder.snapshot())
      }
    }
  }
}

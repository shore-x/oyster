import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { AgentMessage, AgentTool } from '@earendil-works/pi-agent-core'
import { DEFAULT_APP_SETTINGS, type AppLanguage } from '../../shared/app-settings'
import { ModelConnectionFailureError } from '../ai-backends/model'
import {
  createPiCodingAgentInvocation,
  isPiCodingAgentRuntimeFeedback,
  piCodingAgentFinalAssistant,
  promptPiCodingAgent,
  SessionManager,
  type PiCodingAgentInvocation
} from '../agent-runtime/pi-coding-agent-runtime'
import { CHAT_AGENT_ID } from '../../shared/chat'
import type { AgentInvocationDebugRecord } from '../../shared/agent-runtime'
import {
  InMemoryAgentDebugStore,
  type AgentDebugStore
} from '../agent-runtime/agent-debug-store'
import type { PiChatAgentInvocationInput } from './model'
import { chatMessageView } from './chat-message-view'
import {
  chatAgentToolDefinition,
  spawnAgentParameters
} from './chat-tool-catalog'
import { chatAgentSystemPrompt } from './prompt'

function finalAssistantText(messages: readonly AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== 'assistant') continue
    return message.content.flatMap((block) => (
      block.type === 'text' ? [block.text] : []
    )).join('\n')
  }
  return ''
}

function safeEmit(
  input: PiChatAgentInvocationInput,
  event: Parameters<NonNullable<PiChatAgentInvocationInput['onEvent']>>[0]
): void {
  try {
    input.onEvent?.(event)
  } catch {
    // UI diagnostics must never change conversational Agent behavior.
  }
}

function isVisibleConversationMessage(message: AgentMessage): boolean {
  return (message.role === 'user' || message.role === 'assistant' || message.role === 'toolResult')
    && !isPiCodingAgentRuntimeFeedback(message)
}

/** Chat uses Coding Agent's full resource ecosystem from Oyster's explicit agentDir. */
export class PiChatAgent {
  constructor(
    private readonly repositoryPath: string,
    private readonly agentDir = join(repositoryPath, '.oyster', 'pi-agent'),
    private readonly debugStore: AgentDebugStore = new InMemoryAgentDebugStore(),
    private readonly getLanguage: () => AppLanguage = () => DEFAULT_APP_SETTINGS.agentLanguage
  ) {}

  async invoke(input: PiChatAgentInvocationInput): Promise<void> {
    if (!input.text.trim()) throw new Error('消息不能为空')
    input.signal.throwIfAborted()
    // One root Invocation tree uses one language even if the application setting changes mid-turn.
    const language = this.getLanguage()

    const systemPrompt = chatAgentSystemPrompt(
      input.binding.systemPrompt,
      this.repositoryPath
    )
    const observeInvocation = (invocation: AgentInvocationDebugRecord): void => {
      try {
        input.onInvocationUpdate?.(invocation)
      } catch {
        // Invocation observation must not change conversational Agent behavior.
      }
    }

    const createInvocation = async (
      invocationId: string,
      piSessionManager: SessionManager,
      parentInvocationId?: string,
      initialTodos?: readonly string[]
    ): Promise<PiCodingAgentInvocation> => {
      const spawnAgent: AgentTool<typeof spawnAgentParameters> = {
        ...chatAgentToolDefinition('spawn_agent'),
        executionMode: 'sequential',
        execute: async (_toolCallId, parameters, signal) => {
          const instruction = parameters.instruction.trim()
          if (!instruction) throw new Error('子 Agent instruction 去除空白后不能为空')
          signal?.throwIfAborted()

          const childInvocationId = randomUUID()
          const child = await createInvocation(
            childInvocationId,
            SessionManager.create(this.repositoryPath, piSessionManager.getSessionDir(), {
              id: childInvocationId,
              ...(piSessionManager.getSessionFile()
                ? { parentSession: piSessionManager.getSessionFile() }
                : {})
            }),
            invocationId
          )
          try {
            await promptPiCodingAgent(
              child,
              instruction,
              signal ?? new AbortController().signal,
              '子 Agent'
            )
            const childRecord = child.recorder.complete('completed')
            return {
              content: [{
                type: 'text',
                text: finalAssistantText(child.session.messages)
                  || 'Child Agent completed without a final text response.'
              }],
              details: {
                invocationId: childInvocationId,
                modelId: input.modelStream.model.id,
                sessionId: childRecord.session?.sessionId
              }
            }
          } catch (error) {
            child.recorder.complete(signal?.aborted ? 'cancelled' : 'failed', error)
            throw error
          } finally {
            child.dispose()
          }
        }
      }
      return createPiCodingAgentInvocation({
        agentId: CHAT_AGENT_ID,
        invocationId,
        ...(parentInvocationId ? { parentInvocationId } : {}),
        onInvocationUpdate: observeInvocation,
        debugStore: this.debugStore,
        modelStream: input.modelStream,
        cwd: this.repositoryPath,
        agentDir: this.agentDir,
        systemPrompt,
        language,
        reasoningEffort: input.binding.reasoningEffort,
        piSessionManager,
        resourceMode: 'ecosystem',
        customTools: [spawnAgent],
        initialTodos
      })
    }

    const root = await createInvocation(
      input.rootInvocationId,
      input.piSessionManager,
      undefined,
      input.initialTodos
    )
    const pendingNotifications: Promise<void>[] = []
    const unsubscribe = root.session.subscribe((event) => {
      if (event.type !== 'message_end' || !isVisibleConversationMessage(event.message)) return
      const notification = Promise.resolve().then(() => {
        const entry = [...input.piSessionManager.getEntries()].reverse().find((candidate) => (
          candidate.type === 'message' && candidate.message === event.message
        ))
        if (!entry || entry.type !== 'message') return
        safeEmit(input, {
          type: 'message_appended',
          conversationId: input.conversationId,
          entry: {
            id: entry.id,
            createdAt: entry.timestamp,
            message: chatMessageView(entry.message)
          }
        })
      })
      pendingNotifications.push(notification)
    })

    try {
      await promptPiCodingAgent(root, input.text, input.signal, '对话 Agent')
      const final = piCodingAgentFinalAssistant(root)
      if (final?.stopReason === 'error') {
        throw new ModelConnectionFailureError(new Error(final.errorMessage || '对话模型调用失败'))
      }
      root.recorder.complete('completed')
      await Promise.all(pendingNotifications)
    } catch (error) {
      root.recorder.complete(input.signal.aborted ? 'cancelled' : 'failed', error)
      if (piCodingAgentFinalAssistant(root)?.stopReason === 'error'
        && !(error instanceof ModelConnectionFailureError)) {
        throw new ModelConnectionFailureError(error)
      }
      throw error
    } finally {
      unsubscribe()
      root.dispose()
    }
  }
}

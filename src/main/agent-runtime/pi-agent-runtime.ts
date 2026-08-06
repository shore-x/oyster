import { randomUUID } from 'node:crypto'
import { type Agent, type AgentMessage } from '@earendil-works/pi-agent-core'
import type { Message, TextContent } from '@earendil-works/pi-ai'
import { AgentTodoStore, createAgentTodoTools } from './agent-todos'
import {
  createPiAgentRunRecorder,
  type PiAgentRunRecorder,
  type PiAgentRunRecorderOptions
} from './pi-agent-run-recorder'

export interface AgentRuntimeFeedbackMessage {
  role: 'runtimeFeedback'
  content: TextContent[]
  timestamp: number
}

declare module '@earendil-works/pi-agent-core' {
  interface CustomAgentMessages {
    oysterRuntimeFeedback: AgentRuntimeFeedbackMessage
  }
}

export type AgentEndCheck = () => string | undefined | Promise<string | undefined>

export interface PiAgentRuntimeOptions {
  initialTodos?: readonly string[]
  endChecks?: readonly AgentEndCheck[]
  run?: Partial<Pick<PiAgentRunRecorderOptions, 'runId' | 'parentRunId' | 'onUpdate'>>
}

export interface PiAgentRuntime {
  readonly todos: AgentTodoStore
  readonly tools: ReturnType<typeof createAgentTodoTools>
  readonly run: PiAgentRunRecorder
  attach(agent: Agent): () => void
}

export function isAgentRuntimeFeedbackMessage(
  message: AgentMessage
): message is AgentRuntimeFeedbackMessage {
  return message.role === 'runtimeFeedback'
}

/** Convert Host-only Runtime feedback into a model-readable follow-up at the LLM boundary. */
export function convertPiAgentMessages(messages: AgentMessage[]): Message[] {
  return messages.flatMap((message) => {
    if (isAgentRuntimeFeedbackMessage(message)) {
      return [{ role: 'user', content: message.content, timestamp: message.timestamp }]
    }
    return message.role === 'user' || message.role === 'assistant' || message.role === 'toolResult'
      ? [message]
      : []
  })
}

function feedbackMessage(reasons: readonly string[]): AgentRuntimeFeedbackMessage {
  return {
    role: 'runtimeFeedback',
    content: [{
      type: 'text',
      text: [
        'The Agent cannot finish yet:',
        ...reasons.map((reason) => `- ${reason}`),
        'Continue working. Use the available tools to inspect current run state when needed.'
      ].join('\n')
    }],
    timestamp: Date.now()
  }
}

export function createPiAgentRuntime(options: PiAgentRuntimeOptions = {}): PiAgentRuntime {
  const todos = new AgentTodoStore(options.initialTodos)
  const run = createPiAgentRunRecorder({
    runId: options.run?.runId ?? randomUUID(),
    ...(options.run?.parentRunId ? { parentRunId: options.run.parentRunId } : {}),
    ...(options.run?.onUpdate ? { onUpdate: options.run.onUpdate } : {})
  })
  const endChecks: AgentEndCheck[] = [
    () => todos.pendingCount
      ? `${todos.pendingCount} Todos remain pending. Use list_todos to inspect them and complete_todos after finishing each item.`
      : undefined,
    ...(options.endChecks ?? [])
  ]

  return {
    todos,
    tools: createAgentTodoTools(todos),
    run,
    attach: (agent) => {
      const detachRun = run.attach(agent)
      const detachEndChecks = agent.subscribe(async (event) => {
        if (
          event.type !== 'turn_end'
          || event.toolResults.length !== 0
          || event.message.role !== 'assistant'
          || event.message.stopReason !== 'stop'
          || agent.hasQueuedMessages()
        ) return

        const checked = await Promise.all(endChecks.map((check) => check()))
        const reasons = checked.filter((reason): reason is string => Boolean(reason?.trim()))
        if (reasons.length) agent.followUp(feedbackMessage(reasons))
      })
      return () => {
        detachEndChecks()
        detachRun()
      }
    }
  }
}

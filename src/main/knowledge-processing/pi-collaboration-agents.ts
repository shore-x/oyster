import {
  Agent,
  type AgentTool,
  type StreamFn
} from '@earendil-works/pi-agent-core'
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
  type Usage
} from '@earendil-works/pi-ai'
import { createCodingTools } from '@earendil-works/pi-coding-agent'
import {
  ModelConnectionFailureError,
  ModelOutputTruncatedError,
  type ModelRuntime
} from '../ai-backends/model'
import {
  createPiContextCompactor,
  PiContextCompactionOutputError,
  PiContextWindowError
} from '../agent-runtime/pi-context-compactor'
import {
  convertPiAgentMessages,
  createPiAgentRuntime
} from '../agent-runtime/pi-agent-runtime'
import { createArtifactGitEnvironment } from '../artifacts/git-runtime'
import { REASONING_EFFORTS } from '../../shared/ai-backends'
import type { AgentRunRecord } from '../../shared/agent-runtime'
import {
  REVIEW_MARKER_COMMENT,
  REVIEW_MARKER_END,
  REVIEW_MARKER_START,
  type ProcessingRun
} from './processing-repository'
import type {
  KnowledgeMaintainerRunInput,
  KnowledgeMaintainerRuntime,
  KnowledgeReviewerRunInput,
  KnowledgeReviewerRuntime,
  RepositoryAgentRunResult
} from './model'

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  }
}

function failedModelStream(model: Model<Api>, message: string) {
  const stream = createAssistantMessageEventStream()
  const output: AssistantMessage = {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: 'error',
    errorMessage: message,
    timestamp: Date.now()
  }
  stream.push({ type: 'error', reason: 'error', error: output })
  stream.end(output)
  return stream
}

function asError(error: unknown, fallback: string): Error {
  if (error instanceof Error) return error
  if (typeof error === 'string' && error) return new Error(error)
  return new Error(fallback)
}

function validateBaseInput(input: KnowledgeMaintainerRunInput | KnowledgeReviewerRunInput): void {
  if (!input.systemPrompt.trim()) throw new Error('Agent System Prompt 不能为空')
  if (input.reasoningEffort && !REASONING_EFFORTS.includes(input.reasoningEffort)) {
    throw new Error('思考强度无效')
  }
  if (
    !input.run?.repositoryPath
    || !input.run.runPath
    || !input.run.taskPath
    || !input.run.workPath
    || !input.run.inputPath
    || !input.run.branchName
  ) {
    throw new Error('Processing Run 无效')
  }
  input.signal.throwIfAborted()
}

function codingTools(run: ProcessingRun): AgentTool[] {
  return createCodingTools(run.runPath, {
    read: {
      autoResizeImages: false
    },
    bash: {
      spawnHook: (context) => ({
        ...context,
        env: createArtifactGitEnvironment(context.env)
      })
    }
  })
}

interface RunRepositoryAgentInput {
  agentId: 'knowledge_maintenance_agent' | 'knowledge_reviewer_agent'
  runtime: ModelRuntime
  systemPrompt: string
  taskPrompt: string
  reasoningEffort?: KnowledgeMaintainerRunInput['reasoningEffort']
  runId: string
  onRunUpdate?: (run: AgentRunRecord) => void
  signal: AbortSignal
  tools: AgentTool[]
}

async function runRepositoryAgent(input: RunRepositoryAgentInput): Promise<RepositoryAgentRunResult> {
  let compactionError: Error | undefined
  const agentRuntime = createPiAgentRuntime({
    agentId: input.agentId,
    run: { runId: input.runId, onUpdate: input.onRunUpdate }
  })
  const guardedStreamFn: StreamFn = async (model, context, options) => {
    try {
      return await input.runtime.streamFn(model, context, options)
    } catch (error) {
      return failedModelStream(model, asError(error, '模型 Runtime 调用失败').message)
    }
  }
  const thinkingLevel = input.runtime.model.reasoning ? (input.reasoningEffort ?? 'off') : 'off'
  const compactContext = createPiContextCompactor({
    model: input.runtime.model,
    streamFn: agentRuntime.run.wrapStreamFn(guardedStreamFn, 'context_compaction'),
    systemPrompt: input.systemPrompt,
    tools: input.tools,
    thinkingLevel
  })
  const agent = new Agent({
    initialState: {
      systemPrompt: input.systemPrompt,
      model: input.runtime.model,
      thinkingLevel,
      tools: input.tools
    },
    streamFn: agentRuntime.run.wrapStreamFn(guardedStreamFn),
    convertToLlm: convertPiAgentMessages,
    transformContext: async (messages, signal) => {
      try {
        return await compactContext(messages, signal)
      } catch (error) {
        compactionError = asError(error, 'Context compaction failed')
        throw compactionError
      }
    },
    toolExecution: 'sequential'
  })
  const detachRuntime = agentRuntime.attach(agent)
  const abortAgent = (): void => agent.abort()
  input.signal.addEventListener('abort', abortAgent, { once: true })
  try {
    const active = agent.prompt(input.taskPrompt)
    if (input.signal.aborted) agent.abort()
    await active
    if (input.signal.aborted) throw asError(input.signal.reason, 'Agent 运行已取消')
    if (
      compactionError instanceof PiContextWindowError
      || compactionError instanceof PiContextCompactionOutputError
    ) throw compactionError
    if (compactionError) throw new ModelConnectionFailureError(compactionError)
    if (agent.state.errorMessage) {
      throw new ModelConnectionFailureError(new Error(`Agent 模型调用失败：${agent.state.errorMessage}`))
    }
    const finalMessage = [...agent.state.messages].reverse().find((message) => message.role === 'assistant')
    if (finalMessage?.stopReason === 'length') {
      throw new ModelOutputTruncatedError('Agent 最终模型输出达到长度上限，运行结果不完整')
    }
    if (!finalMessage || finalMessage.stopReason !== 'stop') throw new Error('Agent 未正常自然结束')
    const run = agentRuntime.run.complete('completed')
    return {
      run,
      modelCallCount: run.modelCalls.length,
      toolCalls: run.toolCalls.map((call) => call.name)
    }
  } catch (error) {
    agentRuntime.run.complete(input.signal.aborted ? 'cancelled' : 'failed', error)
    throw error
  } finally {
    input.signal.removeEventListener('abort', abortAgent)
    detachRuntime()
  }
}

function maintainerTaskPrompt(_input: KnowledgeMaintainerRunInput): string {
  return [
    'The current working directory is this Knowledge Processing Run workspace.',
    'Read TASK.md and WORK.md with the ordinary read tool, then carry out the Maintainer responsibility described by your System Prompt. All task-specific input is available as files in this workspace.'
  ].join('\n\n')
}

function reviewerTaskPrompt(_input: KnowledgeReviewerRunInput): string {
  return [
    'The current working directory is this Knowledge Processing Run workspace.',
    'Read TASK.md and WORK.md with the ordinary read tool, then carry out the Reviewer responsibility described by your System Prompt. The latest Maintainer handoff in WORK.md identifies the exact candidate revision.'
  ].join('\n\n')
}

export class PiKnowledgeMaintainerAgent implements KnowledgeMaintainerRuntime {
  async run(input: KnowledgeMaintainerRunInput): Promise<RepositoryAgentRunResult> {
    validateBaseInput(input)
    return runRepositoryAgent({
      agentId: 'knowledge_maintenance_agent',
      runtime: input.runtime,
      systemPrompt: input.systemPrompt,
      taskPrompt: maintainerTaskPrompt(input),
      reasoningEffort: input.reasoningEffort,
      runId: input.runId,
      onRunUpdate: input.onRunUpdate,
      signal: input.signal,
      tools: codingTools(input.run)
    })
  }
}

export class PiKnowledgeReviewerAgent implements KnowledgeReviewerRuntime {
  async run(input: KnowledgeReviewerRunInput): Promise<RepositoryAgentRunResult> {
    validateBaseInput(input)
    if (!/^[a-f0-9]{40,64}$/i.test(input.reviewedRevision)) {
      throw new Error('Reviewer revision 无效')
    }
    return runRepositoryAgent({
      agentId: 'knowledge_reviewer_agent',
      runtime: input.runtime,
      systemPrompt: input.systemPrompt,
      taskPrompt: reviewerTaskPrompt(input),
      reasoningEffort: input.reasoningEffort,
      runId: input.runId,
      onRunUpdate: input.onRunUpdate,
      signal: input.signal,
      tools: codingTools(input.run)
    })
  }
}

export const REVIEW_MARKER_FORMAT = [
  REVIEW_MARKER_START,
  'content under review',
  REVIEW_MARKER_COMMENT,
  'actionable review explanation',
  REVIEW_MARKER_END
].join('\n')

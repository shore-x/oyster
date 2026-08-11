import { join } from 'node:path'
import {
  ModelConnectionFailureError,
  ModelOutputTruncatedError,
  type SelectedModelStream
} from '../ai-backends/model'
import {
  createPiCodingAgentInvocation,
  piCodingAgentFinalAssistant,
  promptPiCodingAgent,
  SessionManager
} from '../agent-runtime/pi-coding-agent-runtime'
import { REASONING_EFFORTS } from '../../shared/ai-backends'
import type { AgentInvocationDebugRecord } from '../../shared/agent-runtime'
import {
  InMemoryAgentDebugStore,
  type AgentDebugStore
} from '../agent-runtime/agent-debug-store'
import {
  REVIEW_MARKER_COMMENT,
  REVIEW_MARKER_END,
  REVIEW_MARKER_START,
  type KnowledgeTaskWorkspace
} from './knowledge-task-workspace-repository'
import type {
  KnowledgeMaintainerInvocationInput,
  KnowledgeMaintainerRuntime,
  KnowledgeReviewerInvocationInput,
  KnowledgeReviewerRuntime,
  RepositoryAgentInvocationResult
} from './model'

function asError(error: unknown, fallback: string): Error {
  if (error instanceof Error) return error
  if (typeof error === 'string' && error) return new Error(error)
  return new Error(fallback)
}

function validateBaseInput(input: KnowledgeMaintainerInvocationInput | KnowledgeReviewerInvocationInput): void {
  if (!input.systemPrompt.trim()) throw new Error('Agent System Prompt 不能为空')
  if (input.reasoningEffort && !REASONING_EFFORTS.includes(input.reasoningEffort)) {
    throw new Error('思考强度无效')
  }
  if (
    !input.workspace?.repositoryPath
    || !input.workspace.workspacePath
    || !input.workspace.briefPath
    || !input.workspace.progressPath
    || !input.workspace.inputPath
    || !input.workspace.branchName
  ) {
    throw new Error('Processing Task 无效')
  }
  input.signal.throwIfAborted()
}

interface InvokeRepositoryAgentInput {
  agentId: 'knowledge_maintainer' | 'knowledge_reviewer'
  modelStream: SelectedModelStream
  systemPrompt: string
  taskPrompt: string
  workspace: KnowledgeTaskWorkspace
  reasoningEffort?: KnowledgeMaintainerInvocationInput['reasoningEffort']
  invocationId: string
  onInvocationUpdate?: (record: AgentInvocationDebugRecord) => void
  signal: AbortSignal
}

async function invokeRepositoryAgent(
  input: InvokeRepositoryAgentInput,
  debugStore: AgentDebugStore
): Promise<RepositoryAgentInvocationResult> {
  const piSessionManager = SessionManager.create(
    input.workspace.workspacePath,
    join(input.workspace.workspacePath, 'pi-sessions'),
    { id: input.invocationId }
  )
  const invocation = await createPiCodingAgentInvocation({
    agentId: input.agentId,
    invocationId: input.invocationId,
    onInvocationUpdate: input.onInvocationUpdate,
    modelStream: input.modelStream,
    cwd: input.workspace.workspacePath,
    // Resources are disabled, but an explicit non-global directory keeps every Pi path bounded.
    agentDir: join(input.workspace.workspacePath, '.pi-runtime'),
    systemPrompt: input.systemPrompt,
    reasoningEffort: input.reasoningEffort,
    piSessionManager,
    debugStore,
    resourceMode: 'disabled',
    tools: ['read', 'bash', 'edit', 'write'],
    todoTools: false
  })
  try {
    await promptPiCodingAgent(invocation, input.taskPrompt, input.signal, 'Knowledge Agent')
    if (input.signal.aborted) throw asError(input.signal.reason, 'Agent Invocation 已取消')
    const finalMessage = piCodingAgentFinalAssistant(invocation)
    if (finalMessage?.stopReason === 'length') {
      throw new ModelOutputTruncatedError('Agent 最终模型输出达到长度上限，Invocation 结果不完整')
    }
    if (finalMessage?.stopReason === 'error') {
      throw new ModelConnectionFailureError(new Error(
        finalMessage?.errorMessage
          || invocation.session.state.errorMessage
          || 'Agent 模型调用失败'
      ))
    }
    if (!finalMessage || finalMessage.stopReason !== 'stop') throw new Error('Agent 未正常自然结束')
    const debug = invocation.recorder.complete('completed')
    return {
      invocation: invocation.recorder.invocationRecord(),
      modelCallCount: debug.modelCalls.length,
      toolCalls: debug.toolCalls.map((call) => call.name)
    }
  } catch (error) {
    invocation.recorder.complete(input.signal.aborted ? 'cancelled' : 'failed', error)
    if (piCodingAgentFinalAssistant(invocation)?.stopReason === 'error'
      && !(error instanceof ModelConnectionFailureError)) {
      throw new ModelConnectionFailureError(error)
    }
    throw error
  } finally {
    invocation.dispose()
  }
}

function maintainerTaskPrompt(_input: KnowledgeMaintainerInvocationInput): string {
  return [
    'The current working directory is this Knowledge Processing Task workspace.',
    'Read BRIEF.md and PROGRESS.md with the ordinary read tool, then carry out the Maintainer responsibility described by your System Prompt. All task-specific input is available as files in this workspace.'
  ].join('\n\n')
}

function reviewerTaskPrompt(_input: KnowledgeReviewerInvocationInput): string {
  return [
    'The current working directory is this Knowledge Processing Task workspace.',
    'Read BRIEF.md and PROGRESS.md with the ordinary read tool, then carry out the Reviewer responsibility described by your System Prompt. The latest Maintainer handoff in PROGRESS.md identifies the exact candidate revision.'
  ].join('\n\n')
}

export class PiKnowledgeMaintainerAgent implements KnowledgeMaintainerRuntime {
  constructor(private readonly debugStore: AgentDebugStore = new InMemoryAgentDebugStore()) {}

  async invoke(input: KnowledgeMaintainerInvocationInput): Promise<RepositoryAgentInvocationResult> {
    validateBaseInput(input)
    return invokeRepositoryAgent({
      agentId: 'knowledge_maintainer',
      modelStream: input.modelStream,
      systemPrompt: input.systemPrompt,
      taskPrompt: maintainerTaskPrompt(input),
      workspace: input.workspace,
      reasoningEffort: input.reasoningEffort,
      invocationId: input.invocationId,
      onInvocationUpdate: input.onInvocationUpdate,
      signal: input.signal
    }, this.debugStore)
  }
}

export class PiKnowledgeReviewerAgent implements KnowledgeReviewerRuntime {
  constructor(private readonly debugStore: AgentDebugStore = new InMemoryAgentDebugStore()) {}

  async invoke(input: KnowledgeReviewerInvocationInput): Promise<RepositoryAgentInvocationResult> {
    validateBaseInput(input)
    if (!/^[a-f0-9]{40,64}$/i.test(input.reviewedRepositoryRevision)) {
      throw new Error('Reviewer revision 无效')
    }
    return invokeRepositoryAgent({
      agentId: 'knowledge_reviewer',
      modelStream: input.modelStream,
      systemPrompt: input.systemPrompt,
      taskPrompt: reviewerTaskPrompt(input),
      workspace: input.workspace,
      reasoningEffort: input.reasoningEffort,
      invocationId: input.invocationId,
      onInvocationUpdate: input.onInvocationUpdate,
      signal: input.signal
    }, this.debugStore)
  }
}

export const REVIEW_MARKER_FORMAT = [
  REVIEW_MARKER_START,
  'content under review',
  REVIEW_MARKER_COMMENT,
  'actionable review explanation',
  REVIEW_MARKER_END
].join('\n')

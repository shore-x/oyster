import { join } from 'node:path'
import {
  ModelConnectionFailureError,
  ModelOutputTruncatedError,
  type SelectedModelStream
} from '../ai-backends/model'
import {
  createPiCodingAgentInvocation,
  piCodingAgentFinalAssistant,
  promptPiCodingAgentUntilHandoff,
  SessionManager
} from '../agent-runtime/pi-coding-agent-runtime'
import { REASONING_EFFORTS } from '../../shared/ai-backends'
import { DEFAULT_APP_SETTINGS, type AppLanguage } from '../../shared/app-settings'
import type { AgentInvocationDebugRecord } from '../../shared/agent-runtime'
import {
  InMemoryAgentDebugStore,
  type AgentDebugStore
} from '../agent-runtime/agent-debug-store'
import {
  REVIEW_MARKER_COMMENT,
  REVIEW_MARKER_END,
  REVIEW_MARKER_START,
  type KnowledgeTaskWorktree
} from './knowledge-task-git-repository'
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
    !input.worktree?.repositoryPath
    || !input.worktree.worktreePath
    || !input.worktree.runtimePath
    || !input.worktree.taskPath
    || !input.worktree.inputPath
    || !input.worktree.branchName
  ) {
    throw new Error('Processing Task 无效')
  }
  input.signal.throwIfAborted()
}

interface InvokeRepositoryAgentInput {
  agentId: 'knowledge_maintainer' | 'knowledge_reviewer'
  modelStream: SelectedModelStream
  systemPrompt: string
  language: AppLanguage
  taskPrompt: string
  worktree: KnowledgeTaskWorktree
  validateHandoff: () => Promise<void>
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
    input.worktree.worktreePath,
    join(input.worktree.runtimePath, 'pi-sessions'),
    { id: input.invocationId }
  )
  const invocation = await createPiCodingAgentInvocation({
    agentId: input.agentId,
    invocationId: input.invocationId,
    onInvocationUpdate: input.onInvocationUpdate,
    modelStream: input.modelStream,
    cwd: input.worktree.worktreePath,
    // Resources are disabled; runtime-only Pi state remains outside the tracked Repository.
    agentDir: input.worktree.runtimePath,
    systemPrompt: input.systemPrompt,
    language: input.language,
    reasoningEffort: input.reasoningEffort,
    piSessionManager,
    debugStore,
    resourceMode: 'disabled',
    tools: ['read', 'bash', 'edit', 'write'],
    todoTools: false
  })
  try {
    await promptPiCodingAgentUntilHandoff(
      invocation,
      input.taskPrompt,
      input.validateHandoff,
      input.signal,
      'Knowledge Agent'
    )
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
    'The current working directory is the root of this Knowledge Processing Task checkout.',
    `Read tasks/${_input.worktree.taskId}/TASK.md and tasks/${_input.worktree.taskId}/task.json when it exists, then carry out the Maintainer responsibility described by your System Prompt. All task-specific input is under tasks/${_input.worktree.taskId}/.`,
    `Host-owned handoff contract: remain on branch ${JSON.stringify(_input.worktree.branchName)} in this existing worktree; never modify tasks/${_input.worktree.taskId}/task.json or tasks/${_input.worktree.taskId}/inputs/. Before finishing naturally, commit every intended Task change and leave the worktree clean. The Host validates the Git handoff after each natural stop and may return concrete failures in the same Pi Session for correction.`,
    `Source reference: ${_input.sourceRef}`,
    _input.attention?.trim()
      ? `Additional focus from the user: ${_input.attention.trim()}`
      : 'The user supplied no additional focus.'
  ].join('\n\n')
}

function reviewerTaskPrompt(_input: KnowledgeReviewerInvocationInput): string {
  return [
    'The current working directory is the root of this Knowledge Processing Task checkout.',
    `Read tasks/${_input.worktree.taskId}/TASK.md and tasks/${_input.worktree.taskId}/task.json with the ordinary read tool, then carry out the Reviewer responsibility described by your System Prompt. Do not read tasks/${_input.worktree.taskId}/inputs/. Review exact Task revision ${_input.reviewedRepositoryRevision}.`,
    `Host-owned handoff contract: the Task branch is ${JSON.stringify(_input.worktree.branchName)}, the target branch is ${JSON.stringify(_input.worktree.targetBranch)}, the Task worktree is ${JSON.stringify(_input.worktree.worktreePath)}, and the clean target checkout used for final integration is ${JSON.stringify(_input.worktree.repositoryPath)}. Preserve the reviewed revision on the Task first-parent history and never rebase or otherwise rewrite Task history. If requesting changes, commit the REVIEW markers and unchecked TASK.md items and finish naturally. If approving, commit all Task-side bookkeeping first, merge the latest target branch into the Task branch and resolve any conflicts, then make promotion the final write: from the target checkout fast-forward-only merge the exact Task branch. Do not create worktrees, reset, clean, stash, or push. The Host validates the Git handoff after each natural stop and may return concrete failures in the same Pi Session for correction.`
  ].join('\n\n')
}

export class PiKnowledgeMaintainerAgent implements KnowledgeMaintainerRuntime {
  constructor(
    private readonly debugStore: AgentDebugStore = new InMemoryAgentDebugStore(),
    private readonly getLanguage: () => AppLanguage = () => DEFAULT_APP_SETTINGS.agentLanguage
  ) {}

  async invoke(input: KnowledgeMaintainerInvocationInput): Promise<RepositoryAgentInvocationResult> {
    validateBaseInput(input)
    return invokeRepositoryAgent({
      agentId: 'knowledge_maintainer',
      modelStream: input.modelStream,
      systemPrompt: input.systemPrompt,
      language: this.getLanguage(),
      taskPrompt: maintainerTaskPrompt(input),
      worktree: input.worktree,
      validateHandoff: input.validateHandoff,
      reasoningEffort: input.reasoningEffort,
      invocationId: input.invocationId,
      onInvocationUpdate: input.onInvocationUpdate,
      signal: input.signal
    }, this.debugStore)
  }
}

export class PiKnowledgeReviewerAgent implements KnowledgeReviewerRuntime {
  constructor(
    private readonly debugStore: AgentDebugStore = new InMemoryAgentDebugStore(),
    private readonly getLanguage: () => AppLanguage = () => DEFAULT_APP_SETTINGS.agentLanguage
  ) {}

  async invoke(input: KnowledgeReviewerInvocationInput): Promise<RepositoryAgentInvocationResult> {
    validateBaseInput(input)
    if (!/^[a-f0-9]{40,64}$/i.test(input.reviewedRepositoryRevision)) {
      throw new Error('Reviewer revision 无效')
    }
    return invokeRepositoryAgent({
      agentId: 'knowledge_reviewer',
      modelStream: input.modelStream,
      systemPrompt: input.systemPrompt,
      language: this.getLanguage(),
      taskPrompt: reviewerTaskPrompt(input),
      worktree: input.worktree,
      validateHandoff: input.validateHandoff,
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

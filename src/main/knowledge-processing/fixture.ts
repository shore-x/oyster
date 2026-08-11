import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AiBackendService } from '../ai-backends/ai-backend-service'
import {
  AGENT_INVOCATION_DEBUG_FORMAT_VERSION,
  AGENT_INVOCATION_FORMAT_VERSION,
  type AgentInvocationDebugRecord
} from '../../shared/agent-runtime'
import { parseAgentInvocationRecord } from '../agent-runtime/agent-invocation-record'
import {
  InMemoryAgentDebugStore,
  type AgentDebugStore
} from '../agent-runtime/agent-debug-store'
import { runArtifactGit } from '../artifacts/git-runtime'
import type {
  KnowledgeMaintainerInvocationInput,
  KnowledgeMaintainerRuntime,
  KnowledgeReviewerInvocationInput,
  KnowledgeReviewerRuntime,
  RepositoryAgentInvocationResult
} from './model'
import { InMemoryKnowledgeProcessingConfigurationRepository } from './repository'
import { KnowledgeProcessingService } from './knowledge-processing-service'
import { KnowledgeTaskWorkspaceRepository } from './knowledge-task-workspace-repository'

function fixtureInvocation(
  input: KnowledgeMaintainerInvocationInput | KnowledgeReviewerInvocationInput,
  agentId: 'knowledge_maintainer' | 'knowledge_reviewer',
  toolCalls: string[]
): AgentInvocationDebugRecord {
  const timestamp = new Date().toISOString()
  return {
    formatVersion: AGENT_INVOCATION_FORMAT_VERSION,
    debugFormatVersion: AGENT_INVOCATION_DEBUG_FORMAT_VERSION,
    id: input.invocationId,
    agentId,
    status: 'completed',
    startedAt: timestamp,
    completedAt: timestamp,
    durationMs: 0,
    debugRecordId: input.invocationId,
    modelCallCount: 0,
    toolCallCount: toolCalls.length,
    turns: [],
    messages: [],
    modelCalls: [],
    toolCalls: toolCalls.map((name, index) => ({
      id: `${input.invocationId}:tool:${index + 1}`,
      sequence: index + 1,
      turnId: `${input.invocationId}:turn:1`,
      assistantMessageId: `${input.invocationId}:message:1`,
      name,
      status: 'completed',
      startedAt: timestamp,
      completedAt: timestamp,
      durationMs: 0,
      input: {},
      result: { content: [{ type: 'text', text: `Fixture ${name} completed.` }] },
      isError: false
    }))
  }
}

function inProgressFixtureInvocation(
  input: KnowledgeMaintainerInvocationInput,
  toolCalls: string[],
  visibleToolCount: number
): AgentInvocationDebugRecord {
  const invocation = fixtureInvocation(input, 'knowledge_maintainer', toolCalls)
  invocation.status = 'in_progress'
  delete invocation.completedAt
  delete invocation.durationMs
  invocation.toolCalls = invocation.toolCalls.slice(0, visibleToolCount)
  invocation.toolCallCount = invocation.toolCalls.length
  const activeCall = invocation.toolCalls.at(-1)
  if (activeCall) {
    activeCall.status = 'in_progress'
    delete activeCall.completedAt
    delete activeCall.durationMs
    delete activeCall.result
    delete activeCall.isError
  }
  return invocation
}

async function emitFixtureFrame(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 180))
}

async function commit(repositoryPath: string, message: string): Promise<void> {
  await runArtifactGit(['add', '--', 'knowledge', 'artifacts'], repositoryPath)
  await runArtifactGit(['commit', '--quiet', '--no-gpg-sign', '-m', message], repositoryPath)
}

export class FixtureKnowledgeMaintainerRuntime implements KnowledgeMaintainerRuntime {
  constructor(private readonly debugStore: AgentDebugStore = new InMemoryAgentDebugStore()) {}

  async invoke(
    input: KnowledgeMaintainerInvocationInput
  ): Promise<RepositoryAgentInvocationResult> {
    input.signal.throwIfAborted()
    const toolCalls = ['read', 'read', 'write', 'bash']
    input.onInvocationUpdate?.(inProgressFixtureInvocation(input, toolCalls, 2))
    await emitFixtureFrame()
    input.signal.throwIfAborted()
    const progressPath = input.workspace.progressPath
    await writeFile(
      progressPath,
      (await readFile(progressPath, 'utf8')).replaceAll('- [ ]', '- [x]'),
      'utf8'
    )
    await Promise.all([
      writeFile(
        join(input.workspace.repositoryPath, 'knowledge', 'knowledge-processing.md'),
        '# 知识加工链路\n\n知识加工链路在统一 Git Repository 中由 [[Knowledge Maintenance Agent|知识维护 Agent]] 与 [[Knowledge Reviewer|知识审阅 Agent]] 通过 Knowledge Processing Task 工作状态和 commit 协作。\n',
        'utf8'
      ),
      writeFile(
        join(input.workspace.repositoryPath, 'knowledge', 'knowledge-maintainer.md'),
        '# Knowledge Maintenance Agent\n\nKnowledge Maintenance Agent 从独立 Task 工作空间读取任务、工作清单与文件化 Canonical Activity，并直接维护 [[知识加工链路]] 的 Repository tree。\n',
        'utf8'
      ),
      writeFile(
        join(input.workspace.repositoryPath, 'knowledge', 'knowledge-reviewer.md'),
        '# Knowledge Reviewer\n\nKnowledge Reviewer 在没有 Raw Evidence 的独立上下文中审阅 processing branch，并在 Task 工作区中记录反馈或批准。\n',
        'utf8'
      )
    ])
    await commit(input.workspace.repositoryPath, 'maintain: fixture repository knowledge')
    input.onInvocationUpdate?.(inProgressFixtureInvocation(input, toolCalls, 3))
    await emitFixtureFrame()
    input.signal.throwIfAborted()
    const invocation = fixtureInvocation(input, 'knowledge_maintainer', toolCalls)
    this.debugStore.save(invocation)
    input.onInvocationUpdate?.(invocation)
    await emitFixtureFrame()
    return {
      invocation: parseAgentInvocationRecord(invocation),
      modelCallCount: 0,
      toolCalls: invocation.toolCalls.map((call) => call.name)
    }
  }
}

export class FixtureKnowledgeReviewerRuntime implements KnowledgeReviewerRuntime {
  constructor(private readonly debugStore: AgentDebugStore = new InMemoryAgentDebugStore()) {}

  async invoke(
    input: KnowledgeReviewerInvocationInput
  ): Promise<RepositoryAgentInvocationResult> {
    input.signal.throwIfAborted()
    const invocation = fixtureInvocation(input, 'knowledge_reviewer', ['read', 'bash'])
    this.debugStore.save(invocation)
    input.onInvocationUpdate?.(invocation)
    return {
      invocation: parseAgentInvocationRecord(invocation),
      modelCallCount: 0,
      toolCalls: invocation.toolCalls.map((call) => call.name)
    }
  }
}

export function createFixtureKnowledgeProcessingService(
  aiBackendService: AiBackendService,
  processingRepository: KnowledgeTaskWorkspaceRepository,
  debugStore: AgentDebugStore = new InMemoryAgentDebugStore()
): KnowledgeProcessingService {
  return new KnowledgeProcessingService(
    new InMemoryKnowledgeProcessingConfigurationRepository(),
    aiBackendService,
    processingRepository,
    new FixtureKnowledgeMaintainerRuntime(debugStore),
    new FixtureKnowledgeReviewerRuntime(debugStore)
  )
}

export function fixtureKnowledgeTaskWorkspaceId(): string {
  return randomUUID()
}

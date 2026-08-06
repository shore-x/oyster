import { randomUUID } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AiBackendService } from '../ai-backends/ai-backend-service'
import {
  AGENT_RUN_FORMAT_VERSION,
  type AgentRunRecord
} from '../../shared/agent-runtime'
import { runArtifactGit } from '../artifacts/git-runtime'
import type {
  KnowledgeMaintainerRunInput,
  KnowledgeMaintainerRuntime,
  KnowledgeReviewerRunInput,
  KnowledgeReviewerRuntime,
  RepositoryAgentRunResult
} from './model'
import { InMemoryKnowledgeProcessingRepository } from './repository'
import { KnowledgeProcessingService } from './knowledge-processing-service'
import {
  CollaborationRepository,
  COLLABORATION_WORK_FILE
} from './collaboration-repository'

function fixtureRun(
  input: KnowledgeMaintainerRunInput | KnowledgeReviewerRunInput,
  agentId: 'knowledge_maintenance_agent' | 'knowledge_reviewer_agent',
  toolCalls: string[]
): AgentRunRecord {
  const timestamp = new Date().toISOString()
  return {
    formatVersion: AGENT_RUN_FORMAT_VERSION,
    id: input.runId,
    agentId,
    status: 'completed',
    startedAt: timestamp,
    completedAt: timestamp,
    durationMs: 0,
    turns: [],
    messages: [],
    modelCalls: [],
    toolCalls: toolCalls.map((name, index) => ({
      id: `${input.runId}:tool:${index + 1}`,
      sequence: index + 1,
      turnId: `${input.runId}:turn:1`,
      assistantMessageId: `${input.runId}:message:1`,
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

async function commit(worktreePath: string, message: string): Promise<void> {
  await runArtifactGit(['add', '-A'], worktreePath)
  await runArtifactGit(['commit', '--quiet', '--no-gpg-sign', '-m', message], worktreePath)
}

export class FixtureKnowledgeMaintainerRuntime implements KnowledgeMaintainerRuntime {
  async run(input: KnowledgeMaintainerRunInput): Promise<RepositoryAgentRunResult> {
    input.signal.throwIfAborted()
    const workPath = join(input.workspace.worktreePath, COLLABORATION_WORK_FILE)
    await writeFile(
      workPath,
      (await readFile(workPath, 'utf8')).replaceAll('- [ ]', '- [x]'),
      'utf8'
    )
    await Promise.all([
      writeFile(
        join(input.workspace.worktreePath, 'knowledge', 'knowledge-processing.md'),
        '# 知识加工链路\n\n知识加工链路在真实 Git worktree 中由 [[Knowledge Maintenance Agent|知识维护 Agent]] 与 [[Knowledge Reviewer|知识审阅 Agent]] 通过文件和 commit 协作。\n',
        'utf8'
      ),
      writeFile(
        join(input.workspace.worktreePath, 'knowledge', 'knowledge-maintainer.md'),
        '# Knowledge Maintenance Agent\n\nKnowledge Maintenance Agent 读取文件工作清单与 Canonical Activity，并直接维护 [[知识加工链路]] 的 Repository tree。\n',
        'utf8'
      ),
      writeFile(
        join(input.workspace.worktreePath, 'knowledge', 'knowledge-reviewer.md'),
        '# Knowledge Reviewer\n\nKnowledge Reviewer 在没有 Raw Evidence 的独立上下文中审阅 collaboration branch，并通过普通 commit 交接反馈或批准。\n',
        'utf8'
      )
    ])
    await commit(input.workspace.worktreePath, 'maintain: fixture repository knowledge')
    const run = fixtureRun(input, 'knowledge_maintenance_agent', [
      'read',
      'read_activity',
      'write',
      'bash'
    ])
    input.onRunUpdate?.(run)
    return { run, modelCallCount: 0, toolCalls: run.toolCalls.map((call) => call.name) }
  }
}

export class FixtureKnowledgeReviewerRuntime implements KnowledgeReviewerRuntime {
  async run(input: KnowledgeReviewerRunInput): Promise<RepositoryAgentRunResult> {
    input.signal.throwIfAborted()
    await rm(join(input.workspace.worktreePath, COLLABORATION_WORK_FILE))
    await commit(input.workspace.worktreePath, 'review: approve fixture collaboration')
    const run = fixtureRun(input, 'knowledge_reviewer_agent', ['read', 'bash'])
    input.onRunUpdate?.(run)
    return { run, modelCallCount: 0, toolCalls: run.toolCalls.map((call) => call.name) }
  }
}

export function createFixtureKnowledgeProcessingService(
  aiBackendService: AiBackendService,
  collaborations: CollaborationRepository
): KnowledgeProcessingService {
  return new KnowledgeProcessingService(
    new InMemoryKnowledgeProcessingRepository({
      stages: [
        { stageId: 'knowledge_maintenance_agent' },
        { stageId: 'knowledge_reviewer_agent' }
      ]
    }),
    aiBackendService,
    collaborations,
    new FixtureKnowledgeMaintainerRuntime(),
    new FixtureKnowledgeReviewerRuntime()
  )
}

export function fixtureProcessingRunId(): string {
  return randomUUID()
}

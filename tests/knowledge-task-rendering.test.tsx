import { renderToString } from 'solid-js/web'
import { describe, expect, it, vi } from 'vitest'
import type {
  KnowledgeTaskDetail,
  KnowledgeTaskResult,
  KnowledgeTaskSummary
} from '../src/shared/knowledge-processing'
import { KnowledgeTaskResultDetail, knowledgeTaskResultView } from '../src/renderer/src/components/KnowledgeTaskDetails'
import { KnowledgeTaskHistory } from '../src/renderer/src/components/KnowledgeTaskHistory'

const integratedRevision = 'f'.repeat(40)

function result(): KnowledgeTaskResult {
  return {
    taskId: 'task-completed',
    sourceConversation: {
      sourceConversationId: 'conversation-1',
      sourceId: 'source-1',
      agentType: 'codex',
      sourceDisplayName: 'Codex',
      providerConversationId: 'provider-conversation-1',
      title: 'Completed task',
      sizeBytes: 100
    },
    sourceRef: 'raw:conversation-1@sha256:test',
    worktree: {
      taskId: 'task-completed',
      repositoryPath: '/repository',
      worktreePath: '/worktrees/task-completed',
      runtimePath: '/runtime/task-completed',
      taskPath: '/worktrees/task-completed/tasks/task-completed',
      inputPath: '/worktrees/task-completed/tasks/task-completed/inputs',
      branchName: 'task/task-completed',
      targetBranch: 'main',
      baseRepositoryRevision: 'a'.repeat(40)
    },
    approvedRepositoryRevision: 'b'.repeat(40),
    integratedRepositoryRevision: integratedRevision,
    changedPaths: ['knowledge/topic.md', 'artifacts/report.md'],
    durationMs: 1_500,
    completedAt: '2026-08-12T00:00:00.000Z'
  }
}

function summary(
  taskId: string,
  status: KnowledgeTaskSummary['status']
): KnowledgeTaskSummary {
  return {
    taskId,
    status,
    updatedAt: '2026-08-12T00:00:00.000Z',
    durationMs: 1_500,
    sourceConversationTitle: `${status} task`,
    sourceDisplayName: 'Codex',
    changedPathCount: status === 'completed' ? 2 : 1,
    maintainerModel: 'fixture-model'
  }
}

describe('Knowledge Task result rendering', () => {
  it('renders only integrated revision, changed paths, and duration as result data', () => {
    const html = renderToString(() => KnowledgeTaskResultDetail({
      result: knowledgeTaskResultView(result()),
      detailTestId: 'result-detail'
    }))

    expect(html).toContain(integratedRevision)
    expect(html).toContain('knowledge/topic.md')
    expect(html).toContain('artifacts/report.md')
    expect(html).toContain('1.5 s')
    expect(html).toContain('知识库或工作台')
    expect(html).not.toContain('Statements')
    expect(html).not.toContain('Collaboration Rounds')
    expect(html).not.toContain('未合并')
  })

  it('marks open Tasks as branch-local and only enables completed results', () => {
    const tasks = [summary('task-open', 'open'), summary('task-completed', 'completed')]
    const html = renderToString(() => KnowledgeTaskHistory({
      tasks,
      loading: false,
      onOpen: vi.fn(async () => undefined)
    }))

    expect(html).toContain('仍在 Task 分支')
    expect(html).toContain('已合并')
    expect(html).toMatch(/<button[^>]*disabled[^>]*data-testid="open-history-result-task-open"/)
    expect(html).not.toContain('open-history-activity')
    expect(html).not.toContain('Invocation 详情')
  })

  it('renders a completed historical result without an Invocation inspector', () => {
    const completedResult = result()
    const selected: KnowledgeTaskDetail = {
      formatVersion: 3,
      taskId: completedResult.taskId,
      status: 'completed',
      startedAt: '2026-08-12T00:00:00.000Z',
      updatedAt: completedResult.completedAt,
      completedAt: completedResult.completedAt,
      durationMs: completedResult.durationMs,
      input: { sourceConversationId: 'conversation-1' },
      sourceConversation: completedResult.sourceConversation,
      sourceRef: completedResult.sourceRef,
      configuration: {
        maintainer: { connectionId: 'fixture', modelId: 'fixture-model' },
        reviewer: { connectionId: 'fixture', modelId: 'fixture-model' }
      },
      result: completedResult
    }

    const html = renderToString(() => KnowledgeTaskHistory({
      tasks: [summary('task-completed', 'completed')],
      loading: false,
      selected,
      onOpen: vi.fn(async () => selected)
    }))

    expect(html).not.toContain('history-task-activity-detail')
    expect(html).not.toContain('Historical Agent Invocations')
  })
})

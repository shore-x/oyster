import type { AiBackendService } from '../ai-backends/ai-backend-service'
import type { AgentRunRecord, SerializableJsonValue } from '../../shared/agent-runtime'
import { AgentTodoStore } from '../agent-runtime/agent-todos'
import type { KnowledgeAgentRunInput, KnowledgeAgentRunResult, KnowledgeAgentRuntime } from './model'
import { InMemoryKnowledgeProcessingRepository } from './repository'
import { KnowledgeProcessingService } from './knowledge-processing-service'

export class FixtureKnowledgeAgentRuntime implements KnowledgeAgentRuntime {
  async run(input: KnowledgeAgentRunInput): Promise<KnowledgeAgentRunResult> {
    input.signal.throwIfAborted()
    const todoStore = new AgentTodoStore(input.initialTodos)
    const pendingTodos = todoStore.list()
    input.onWorkspaceStatus?.({
      todos: {
        total: pendingTodos.length,
        pending: pendingTodos.length,
        completed: 0
      },
      draftStatementCount: 0
    })
    todoStore.complete(pendingTodos.map((todo) => todo.id))
    input.onWorkspaceStatus?.({
      todos: {
        total: pendingTodos.length,
        pending: 0,
        completed: pendingTodos.length
      },
      draftStatementCount: 2
    })
    const startedAt = new Date().toISOString()
    const modelId = input.runtime.model.id
    const userMessageId = `${input.runId}:message:1`
    const assistantMessageId = `${input.runId}:message:2`
    const evidenceCallId = 'fixture-read'
    const todoCallId = 'fixture-complete'
    const assistantOutput: SerializableJsonValue = {
      role: 'assistant' as const,
      content: [
        { type: 'toolCall' as const, id: evidenceCallId, name: 'read_evidence', arguments: { line: 1, offset: 0, limit: 48 } },
        { type: 'toolCall' as const, id: todoCallId, name: 'complete_todos', arguments: { ids: pendingTodos.map((todo) => todo.id) } }
      ],
      api: input.runtime.model.api,
      provider: input.runtime.model.provider,
      model: modelId,
      usage: {
        input: 32,
        output: 16,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 48,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      stopReason: 'toolUse' as const,
      timestamp: Date.now()
    }
    const run: AgentRunRecord = {
      id: input.runId,
      status: 'completed' as const,
      startedAt,
      completedAt: startedAt,
      durationMs: 0,
      turns: [{
        id: `${input.runId}:turn:1`,
        sequence: 1,
        status: 'completed' as const,
        startedAt,
        completedAt: startedAt,
        durationMs: 0,
        messageIds: [userMessageId, assistantMessageId],
        toolCallIds: [evidenceCallId, todoCallId]
      }],
      messages: [{
        id: userMessageId,
        sequence: 2,
        turnId: `${input.runId}:turn:1`,
        status: 'completed' as const,
        role: 'user' as const,
        message: { role: 'user', content: 'Fixture knowledge maintenance task.', timestamp: Date.now() }
      }, {
        id: assistantMessageId,
        sequence: 4,
        turnId: `${input.runId}:turn:1`,
        status: 'completed' as const,
        role: 'assistant' as const,
        message: assistantOutput
      }],
      modelCalls: [{
        id: `${input.runId}:model:1`,
        sequence: 3,
        turnId: `${input.runId}:turn:1`,
        outputMessageId: assistantMessageId,
        purpose: 'agent' as const,
        status: 'completed' as const,
        startedAt,
        completedAt: startedAt,
        durationMs: 0,
        model: {
          id: modelId,
          name: input.runtime.model.name,
          provider: input.runtime.model.provider,
          api: input.runtime.model.api,
          reasoning: input.runtime.model.reasoning,
          contextWindow: input.runtime.model.contextWindow,
          maxTokens: input.runtime.model.maxTokens
        },
        context: {
          systemPrompt: input.systemPrompt,
          messages: [{ role: 'user', content: 'Fixture knowledge maintenance task.', timestamp: Date.now() }],
          tools: [{ name: 'read_evidence', description: 'Read Raw Evidence.', parameters: { type: 'object' } }]
        },
        output: assistantOutput
      }],
      toolCalls: [{
        id: evidenceCallId,
        sequence: 5,
        turnId: `${input.runId}:turn:1`,
        assistantMessageId,
        name: 'read_evidence',
        status: 'completed' as const,
        startedAt,
        completedAt: startedAt,
        durationMs: 0,
        input: { line: 1, offset: 0, limit: 48 },
        result: { content: [{ type: 'text', text: 'Fixture raw evidence for knowledge processing.' }] },
        isError: false
      }, {
        id: todoCallId,
        sequence: 6,
        turnId: `${input.runId}:turn:1`,
        assistantMessageId,
        name: 'complete_todos',
        status: 'completed' as const,
        startedAt,
        completedAt: startedAt,
        durationMs: 0,
        input: { ids: pendingTodos.map((todo) => todo.id) },
        result: { content: [{ type: 'text', text: `Completed ${pendingTodos.length} Todos.` }] },
        isError: false
      }]
    }
    input.onRunUpdate?.(run)
    return {
      contribution: {
        runRef: input.contributionRunRef,
        statements: [
          {
            title: '知识加工链路',
            content: '知识加工链路应保持简洁，由 [[Knowledge Maintenance Agent|知识维护 Agent]] 覆盖完整证据并维护知识，同时保留可回溯的来源。'
          },
          {
            title: 'Knowledge Maintenance Agent',
            content: 'Knowledge Maintenance Agent 通过通用 Todo 组织调查并读取原始证据，为 [[知识加工链路]] 维护相互可解释的 Statement。'
          }
        ]
      },
      todos: todoStore.list(),
      run,
      modelCallCount: 1,
      toolCalls: ['read_evidence', 'complete_todos']
    }
  }
}

export function createFixtureKnowledgeProcessingService(
  aiBackendService: AiBackendService
): KnowledgeProcessingService {
  return new KnowledgeProcessingService(
    new InMemoryKnowledgeProcessingRepository({
      stages: [
        { stageId: 'knowledge_maintenance_agent' }
      ]
    }),
    aiBackendService,
    new FixtureKnowledgeAgentRuntime()
  )
}

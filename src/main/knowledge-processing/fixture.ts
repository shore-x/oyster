import type { AiBackendService } from '../ai-backends/ai-backend-service'
import { AgentTodoStore } from '../agent-runtime/agent-todos'
import type { KnowledgeAgentRunInput, KnowledgeAgentRunResult, KnowledgeAgentRuntime } from './model'
import { InMemoryKnowledgeProcessingRepository } from './repository'
import { KnowledgeProcessingService } from './knowledge-processing-service'

export class FixtureKnowledgeAgentRuntime implements KnowledgeAgentRuntime {
  async run(input: KnowledgeAgentRunInput): Promise<KnowledgeAgentRunResult> {
    input.signal.throwIfAborted()
    const todoStore = new AgentTodoStore(input.initialTodos)
    const pendingTodos = todoStore.list()
    input.onTrace?.({
      type: 'workspace_status',
      todos: {
        total: pendingTodos.length,
        pending: pendingTodos.length,
        completed: 0
      },
      draftStatementCount: 0
    })
    input.onTrace?.({ type: 'model_started', callNumber: 1 })
    input.onTrace?.({
      type: 'model_completed',
      callNumber: 1,
      status: 'completed',
      detail: 'stop=toolUse · tokens=48 · tools=list_todos, read_evidence, complete_todos',
      output: 'Tool call · read_evidence\n{"line":1,"offset":0,"limit":48}'
    })
    input.onTrace?.({
      type: 'tool_started',
      toolCallId: 'fixture-read',
      toolName: 'read_evidence',
      input: '{"line":1,"offset":0,"limit":48}'
    })
    input.onTrace?.({
      type: 'tool_completed',
      toolCallId: 'fixture-read',
      toolName: 'read_evidence',
      status: 'completed',
      detail: 'L000001:C0-L000001:C48 · 48 字符 · EOF',
      output: 'Fixture raw evidence for knowledge processing.'
    })
    input.onTrace?.({
      type: 'tool_started',
      toolCallId: 'fixture-complete',
      toolName: 'complete_todos',
      input: JSON.stringify({ ids: pendingTodos.map((todo) => todo.id) })
    })
    todoStore.complete(pendingTodos.map((todo) => todo.id))
    input.onTrace?.({
      type: 'tool_completed',
      toolCallId: 'fixture-complete',
      toolName: 'complete_todos',
      status: 'completed',
      detail: 'Todo · 0 个待处理',
      output: `Completed ${pendingTodos.length} Todos.`
    })
    input.onTrace?.({
      type: 'workspace_status',
      todos: {
        total: pendingTodos.length,
        pending: 0,
        completed: pendingTodos.length
      },
      draftStatementCount: 2
    })
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
        { stageId: 'knowledge_maintenance_agent', connectionId: 'model:fixture', modelId: 'fixture-model' }
      ]
    }),
    aiBackendService,
    new FixtureKnowledgeAgentRuntime()
  )
}

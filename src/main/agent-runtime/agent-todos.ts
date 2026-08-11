import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { AgentTodo } from '../../shared/agent-runtime'

export type { AgentTodo } from '../../shared/agent-runtime'

const MAX_TODO_CONTENT_LENGTH = 64 * 1_024

export const addTodosParameters = Type.Object({
  todos: Type.Array(Type.String({ minLength: 1, maxLength: MAX_TODO_CONTENT_LENGTH }), {
    minItems: 1
  })
}, { additionalProperties: false })

export const completeTodosParameters = Type.Object({
  ids: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { minItems: 1 })
}, { additionalProperties: false })

export const listTodosParameters = Type.Object({}, { additionalProperties: false })

export const AGENT_TODO_TOOL_CATALOG = [
  {
    name: 'add_todos',
    label: '增加待办事项',
    description: 'Add one or more items to this Agent Invocation\'s general-purpose Todo list. The Host assigns stable IDs and keeps the list outside the conversation transcript.',
    parameters: addTodosParameters
  },
  {
    name: 'complete_todos',
    label: '完成待办事项',
    description: 'Mark one or more Todo IDs as completed. Completing an already completed item is safe and has no additional effect.',
    parameters: completeTodosParameters
  },
  {
    name: 'list_todos',
    label: '查看待办事项',
    description: 'Read the complete Todo list bound to this Agent Invocation, including pending and completed items.',
    parameters: listTodosParameters
  }
] as const

export type AgentTodoToolName = (typeof AGENT_TODO_TOOL_CATALOG)[number]['name']

export function agentTodoToolDefinition<TName extends AgentTodoToolName>(name: TName): Extract<
  (typeof AGENT_TODO_TOOL_CATALOG)[number],
  { name: TName }
> {
  const definition = AGENT_TODO_TOOL_CATALOG.find((tool) => tool.name === name)
  if (!definition) throw new Error(`未知的通用 Agent Todo 工具：${name}`)
  return definition as Extract<(typeof AGENT_TODO_TOOL_CATALOG)[number], { name: TName }>
}

function normalizedContent(content: string): string {
  const value = content.trim()
  if (!value) throw new Error('Todo 内容去除空白后不能为空')
  if (value.length > MAX_TODO_CONTENT_LENGTH) {
    throw new Error(`Todo 内容超出长度上限 ${MAX_TODO_CONTENT_LENGTH}`)
  }
  return value
}

export class AgentTodoStore {
  private readonly items: AgentTodo[] = []
  private nextId = 1

  constructor(initialTodos: readonly string[] = []) {
    if (initialTodos.length) this.add(initialTodos)
  }

  add(contents: readonly string[]): AgentTodo[] {
    const normalized = contents.map(normalizedContent)
    const added = normalized.map((content) => ({
      id: `T${String(this.nextId++).padStart(6, '0')}`,
      content,
      status: 'pending' as const
    }))
    this.items.push(...added)
    return added.map((todo) => ({ ...todo }))
  }

  complete(ids: readonly string[]): AgentTodo[] {
    const normalizedIds = ids.map((id) => id.trim())
    const byId = new Map(this.items.map((todo) => [todo.id, todo]))
    for (const id of normalizedIds) {
      if (!id || !byId.has(id)) throw new Error(`Todo 不存在：${id || '(empty)'}`)
    }
    const completed: AgentTodo[] = []
    for (const id of new Set(normalizedIds)) {
      const todo = byId.get(id)!
      todo.status = 'completed'
      completed.push({ ...todo })
    }
    return completed
  }

  list(): AgentTodo[] {
    return this.items.map((todo) => ({ ...todo }))
  }

  get pendingCount(): number {
    return this.items.filter((todo) => todo.status === 'pending').length
  }
}

function todoListText(todos: readonly AgentTodo[]): string {
  if (!todos.length) return 'No Todos are bound to this Agent Invocation.'
  return todos.map((todo) => `- ${todo.id} [${todo.status}] ${todo.content}`).join('\n')
}

export function createAgentTodoTools(store: AgentTodoStore): AgentTool[] {
  return [
    {
      ...agentTodoToolDefinition('add_todos'),
      executionMode: 'sequential',
      execute: async (_toolCallId, parameters, signal) => {
        signal?.throwIfAborted()
        const added = store.add(parameters.todos)
        return {
          content: [{
            type: 'text',
            text: [
              `Added ${added.length} Todos.`,
              ...added.map((todo) => `- ${todo.id}: ${todo.content}`),
              `Pending Todos: ${store.pendingCount}.`
            ].join('\n')
          }],
          details: { added, pendingCount: store.pendingCount }
        }
      }
    } as AgentTool<typeof addTodosParameters>,
    {
      ...agentTodoToolDefinition('complete_todos'),
      executionMode: 'sequential',
      execute: async (_toolCallId, parameters, signal) => {
        signal?.throwIfAborted()
        const completed = store.complete(parameters.ids)
        return {
          content: [{
            type: 'text',
            text: [
              `Completed ${completed.length} Todos.`,
              ...completed.map((todo) => `- ${todo.id}: ${todo.content}`),
              `Pending Todos: ${store.pendingCount}.`
            ].join('\n')
          }],
          details: { completed, pendingCount: store.pendingCount }
        }
      }
    } as AgentTool<typeof completeTodosParameters>,
    {
      ...agentTodoToolDefinition('list_todos'),
      executionMode: 'sequential',
      execute: async (_toolCallId, _parameters, signal) => {
        signal?.throwIfAborted()
        const todos = store.list()
        return {
          content: [{ type: 'text', text: todoListText(todos) }],
          details: { todos, pendingCount: store.pendingCount }
        }
      }
    } as AgentTool<typeof listTodosParameters>
  ]
}

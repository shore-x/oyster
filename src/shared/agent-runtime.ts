export type AgentTodoStatus = 'pending' | 'completed'

/** Host-owned work item for one Agent run. It is not a domain record. */
export interface AgentTodo {
  id: string
  content: string
  status: AgentTodoStatus
}

export interface AgentTodoCounts {
  total: number
  pending: number
  completed: number
}

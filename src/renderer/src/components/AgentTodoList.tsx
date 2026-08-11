import { For, Show } from 'solid-js'
import type { AgentTodo } from '../../../shared/agent-runtime'

export interface AgentTodoListProps {
  todos: AgentTodo[]
  emptyText?: string
}

export function AgentTodoList(props: AgentTodoListProps) {
  return (
    <Show
      when={props.todos.length}
      fallback={(
        <div class="statement-candidates__empty">
          {props.emptyText ?? '当前 Agent Invocation 没有 Todo。'}
        </div>
      )}
    >
      <div class="statement-candidates" data-testid="agent-todo-list">
        <For each={props.todos}>{(todo, index) => (
          <article
            class={`statement-candidate statement-candidate--${todo.status === 'completed' ? 'resolved' : 'open'}`}
            data-testid={`agent-todo-${index() + 1}`}
          >
            <div class="statement-candidate__heading">
              <strong>{todo.id}</strong>
              <span>{todo.status === 'completed' ? '已完成' : '待处理'}</span>
            </div>
            <p>{todo.content}</p>
          </article>
        )}</For>
      </div>
    </Show>
  )
}

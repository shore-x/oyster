import { For, Show } from 'solid-js'
import type { StatementCandidateSeed } from '../../../shared/knowledge-processing'

export interface StatementCandidateListProps {
  candidates: StatementCandidateSeed[]
  emptyText?: string
}

export function StatementCandidateList(props: StatementCandidateListProps) {
  return (
    <Show
      when={props.candidates.length}
      fallback={(
        <div class="statement-candidates__empty">
          {props.emptyText ?? '没有发现需要知识维护 Agent 裁决的 Statement 候选。'}
        </div>
      )}
    >
      <div class="statement-candidates" data-testid="statement-candidate-list">
        <For each={props.candidates}>{(candidate, index) => (
            <article
              class="statement-candidate statement-candidate--open"
              data-testid={`statement-candidate-${index() + 1}`}
            >
              <div class="statement-candidate__heading">
                <strong>{candidate.expression}</strong>
                <span>待调查</span>
              </div>
              <p>{candidate.question}</p>
            </article>
        )}</For>
      </div>
    </Show>
  )
}

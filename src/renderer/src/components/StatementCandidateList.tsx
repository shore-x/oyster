import { For, Show } from 'solid-js'
import type {
  StatementCandidateSeed,
  StatementCandidateView
} from '../../../shared/knowledge-processing'

export type DisplayStatementCandidate = StatementCandidateSeed | StatementCandidateView

export interface StatementCandidateListProps {
  candidates: DisplayStatementCandidate[]
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
        <For each={props.candidates}>{(candidate, index) => {
          const status = () => 'status' in candidate ? candidate.status : 'open'
          const resolution = () => 'resolution' in candidate ? candidate.resolution : undefined
          return (
            <article
              class={`statement-candidate statement-candidate--${status()}`}
              data-testid={`statement-candidate-${index() + 1}`}
            >
              <div class="statement-candidate__heading">
                <strong>{candidate.expression}</strong>
                <span>{status() === 'resolved' ? '已裁决' : '待裁决'}</span>
              </div>
              <p>{candidate.question}</p>
              <Show when={resolution()}>
                {(value) => (
                  <div class="statement-candidate__resolution">
                    <span>裁决</span>
                    <p>{value()}</p>
                  </div>
                )}
              </Show>
            </article>
          )
        }}</For>
      </div>
    </Show>
  )
}

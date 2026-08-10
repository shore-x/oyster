import { For, Show } from 'solid-js'
import type { AvailableSessionSummary } from '../../../shared/discovery'
import { Button } from '../ui'
import { sessionOptionLabel } from './SessionMetadata'

export interface SessionPickerProps {
  sessions: AvailableSessionSummary[]
  selected?: AvailableSessionSummary
  loading: boolean
  disabled: boolean
  label: string
  selectTestId: string
  refreshTestId: string
  error?: string
  onSelect(session?: AvailableSessionSummary): void
  onRefresh(): void
}

export function SessionPicker(props: SessionPickerProps) {
  return (
    <div class="session-picker ai-field--wide">
      <label class="ai-field">
        <span>{props.label}</span>
        <select
          data-testid={props.selectTestId}
          value={props.selected?.sourceRecordId || ''}
          disabled={props.loading || props.disabled || props.sessions.length === 0}
          onChange={(event) => props.onSelect(
            props.sessions.find((session) => session.sourceRecordId === event.currentTarget.value)
          )}
        >
          <option value="">
            {props.loading
              ? '正在刷新本机 Session…'
              : props.sessions.length
                ? '选择一个 Session'
                : '暂无可用 Session'}
          </option>
          <For each={props.sessions}>{(session) => (
            <option value={session.sourceRecordId}>{sessionOptionLabel(session)}</option>
          )}</For>
        </select>
      </label>
      <Button
        variant="secondary"
        icon="refresh"
        data-testid={props.refreshTestId}
        disabled={props.loading || props.disabled}
        onClick={props.onRefresh}
      >{props.loading ? '刷新中…' : '刷新本机 Session'}</Button>
      <Show when={props.error}>{(error) => (
        <p class="session-picker__error">{error()}</p>
      )}</Show>
    </div>
  )
}

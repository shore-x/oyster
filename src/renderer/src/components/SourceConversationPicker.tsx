import { For, Show } from 'solid-js'
import type { SourceConversationSummary } from '../../../shared/discovery'
import { Button } from '../ui'
import { sourceConversationOptionLabel } from './SourceConversationMetadata'

export interface SourceConversationPickerProps {
  conversations: SourceConversationSummary[]
  selected?: SourceConversationSummary
  loading: boolean
  disabled: boolean
  label: string
  selectTestId: string
  refreshTestId: string
  error?: string
  onSelect(conversation?: SourceConversationSummary): void
  onRefresh(): void
}

export function SourceConversationPicker(props: SourceConversationPickerProps) {
  return (
    <div class="source-conversation-picker ai-field--wide">
      <label class="ai-field">
        <span>{props.label}</span>
        <select
          data-testid={props.selectTestId}
          value={props.selected?.sourceConversationId || ''}
          disabled={props.loading || props.disabled || props.conversations.length === 0}
          onChange={(event) => props.onSelect(
            props.conversations.find(
              (conversation) => conversation.sourceConversationId === event.currentTarget.value
            )
          )}
        >
          <option value="">
            {props.loading
              ? '正在刷新 Source Conversations…'
              : props.conversations.length
                ? '选择一个 Source Conversation'
                : '暂无可用 Source Conversation'}
          </option>
          <For each={props.conversations}>{(conversation) => (
            <option value={conversation.sourceConversationId}>
              {sourceConversationOptionLabel(conversation)}
            </option>
          )}</For>
        </select>
      </label>
      <Button
        variant="secondary"
        icon="refresh"
        data-testid={props.refreshTestId}
        disabled={props.loading || props.disabled}
        onClick={props.onRefresh}
      >{props.loading ? '刷新中…' : '刷新来源对话'}</Button>
      <Show when={props.error}>{(error) => (
        <p class="source-conversation-picker__error">{error()}</p>
      )}</Show>
    </div>
  )
}

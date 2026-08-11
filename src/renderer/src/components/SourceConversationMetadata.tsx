import type { SourceConversationSummary } from '../../../shared/discovery'
import { appLanguage, uiText } from '../i18n'

function formatTime(value?: string): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(appLanguage())
}

function formatDate(value?: string): string {
  if (!value) return uiText('时间未知', 'Unknown time')
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(appLanguage())
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`
  if (bytes < 1_024 * 1_024 * 1_024) return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`
  return `${(bytes / (1_024 * 1_024 * 1_024)).toFixed(1)} GB`
}

function projectName(projectPath?: string): string {
  const normalized = projectPath?.replace(/[\\/]+$/, '')
  return normalized?.split(/[\\/]/).pop() || uiText('项目未知', 'Unknown project')
}

export function sourceConversationTitle(conversation: SourceConversationSummary): string {
  return conversation.title?.trim() || conversation.providerConversationId
}

export function sourceConversationOptionLabel(conversation: SourceConversationSummary): string {
  return [
    sourceConversationTitle(conversation),
    projectName(conversation.projectPath),
    conversation.sourceDisplayName,
    formatDate(conversation.startedAt),
    `${formatBytes(conversation.sizeBytes)} ${uiText('原始记录', 'raw history')}`
  ].join(' · ')
}

function timeRange(conversation: SourceConversationSummary): string {
  if (conversation.startedAt && conversation.endedAt) {
    return `${formatTime(conversation.startedAt)} → ${formatTime(conversation.endedAt)}`
  }
  if (conversation.startedAt) {
    return conversation.updatedAt
      ? `${formatTime(conversation.startedAt)} → ${formatTime(conversation.updatedAt)} ${uiText('（文件更新）', '(file updated)')}`
      : `${formatTime(conversation.startedAt)} → ${uiText('结束时间未知', 'unknown end time')}`
  }
  if (conversation.endedAt) return `${uiText('开始时间未知', 'Unknown start time')} → ${formatTime(conversation.endedAt)}`
  return '—'
}

export function SourceConversationMetadata(props: {
  conversation: SourceConversationSummary
  class: string
  testId: string
}) {
  return (
    <dl class={`${props.class} source-conversation-metadata`} data-testid={props.testId}>
      <div class="source-conversation-metadata__wide">
        <dt>{uiText('标题', 'Title')}</dt>
        <dd title={sourceConversationTitle(props.conversation)} data-testid={`${props.testId}-title`}>
          {sourceConversationTitle(props.conversation)}
        </dd>
      </div>
      <div>
        <dt>{uiText('来源', 'Source')}</dt>
        <dd>{props.conversation.sourceDisplayName}</dd>
      </div>
      <div>
        <dt>{uiText('原始记录大小', 'Raw History Size')}</dt>
        <dd data-testid={`${props.testId}-size`}>{formatBytes(props.conversation.sizeBytes)}</dd>
      </div>
      <div class="source-conversation-metadata__wide">
        <dt>{uiText('时间范围', 'Time Range')}</dt>
        <dd data-testid={`${props.testId}-time-range`}>
          {timeRange(props.conversation)}
        </dd>
      </div>
      <div class="source-conversation-metadata__wide">
        <dt>{uiText('所属项目', 'Project')}</dt>
        <dd title={props.conversation.projectPath} data-testid={`${props.testId}-project`}>
          {props.conversation.projectPath || '—'}
        </dd>
      </div>
    </dl>
  )
}

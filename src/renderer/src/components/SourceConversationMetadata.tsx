import type { SourceConversationSummary } from '../../../shared/discovery'

function formatTime(value?: string): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN')
}

function formatDate(value?: string): string {
  if (!value) return '时间未知'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('zh-CN')
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`
  if (bytes < 1_024 * 1_024 * 1_024) return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`
  return `${(bytes / (1_024 * 1_024 * 1_024)).toFixed(1)} GB`
}

function projectName(projectPath?: string): string {
  const normalized = projectPath?.replace(/[\\/]+$/, '')
  return normalized?.split(/[\\/]/).pop() || '项目未知'
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
    `${formatBytes(conversation.sizeBytes)} 原始记录`
  ].join(' · ')
}

function timeRange(conversation: SourceConversationSummary): string {
  if (conversation.startedAt && conversation.endedAt) {
    return `${formatTime(conversation.startedAt)} → ${formatTime(conversation.endedAt)}`
  }
  if (conversation.startedAt) {
    return conversation.updatedAt
      ? `${formatTime(conversation.startedAt)} → ${formatTime(conversation.updatedAt)}（文件更新）`
      : `${formatTime(conversation.startedAt)} → 结束时间未知`
  }
  if (conversation.endedAt) return `开始时间未知 → ${formatTime(conversation.endedAt)}`
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
        <dt>标题</dt>
        <dd title={sourceConversationTitle(props.conversation)} data-testid={`${props.testId}-title`}>
          {sourceConversationTitle(props.conversation)}
        </dd>
      </div>
      <div>
        <dt>来源</dt>
        <dd>{props.conversation.sourceDisplayName}</dd>
      </div>
      <div>
        <dt>原始记录大小</dt>
        <dd data-testid={`${props.testId}-size`}>{formatBytes(props.conversation.sizeBytes)}</dd>
      </div>
      <div class="source-conversation-metadata__wide">
        <dt>时间范围</dt>
        <dd data-testid={`${props.testId}-time-range`}>
          {timeRange(props.conversation)}
        </dd>
      </div>
      <div class="source-conversation-metadata__wide">
        <dt>所属项目</dt>
        <dd title={props.conversation.projectPath} data-testid={`${props.testId}-project`}>
          {props.conversation.projectPath || '—'}
        </dd>
      </div>
    </dl>
  )
}

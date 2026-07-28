import type { AvailableSessionSummary } from '../../../shared/discovery'

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

export function sessionTitle(session: AvailableSessionSummary): string {
  return session.title?.trim() || session.externalId
}

export function sessionOptionLabel(session: AvailableSessionSummary): string {
  return [
    sessionTitle(session),
    projectName(session.projectPath),
    session.sourceDisplayName,
    formatDate(session.startedAt),
    `${formatBytes(session.sizeBytes)} 原始记录`
  ].join(' · ')
}

function timeRange(session: AvailableSessionSummary): string {
  if (session.startedAt && session.endedAt) {
    return `${formatTime(session.startedAt)} → ${formatTime(session.endedAt)}`
  }
  if (session.startedAt) {
    return session.updatedAt
      ? `${formatTime(session.startedAt)} → ${formatTime(session.updatedAt)}（文件更新）`
      : `${formatTime(session.startedAt)} → 结束时间未知`
  }
  if (session.endedAt) return `开始时间未知 → ${formatTime(session.endedAt)}`
  return '—'
}

export function SessionMetadata(props: {
  session: AvailableSessionSummary
  class: string
  testId: string
}) {
  return (
    <dl class={`${props.class} session-metadata`} data-testid={props.testId}>
      <div class="session-metadata__wide">
        <dt>标题</dt>
        <dd title={sessionTitle(props.session)} data-testid={`${props.testId}-title`}>
          {sessionTitle(props.session)}
        </dd>
      </div>
      <div>
        <dt>来源</dt>
        <dd>{props.session.sourceDisplayName}</dd>
      </div>
      <div>
        <dt>原始记录大小</dt>
        <dd data-testid={`${props.testId}-size`}>{formatBytes(props.session.sizeBytes)}</dd>
      </div>
      <div class="session-metadata__wide">
        <dt>时间范围</dt>
        <dd data-testid={`${props.testId}-time-range`}>
          {timeRange(props.session)}
        </dd>
      </div>
      <div class="session-metadata__wide">
        <dt>所属项目</dt>
        <dd title={props.session.projectPath} data-testid={`${props.testId}-project`}>
          {props.session.projectPath || '—'}
        </dd>
      </div>
      <div>
        <dt>Session</dt>
        <dd title={props.session.externalId}>{props.session.externalId}</dd>
      </div>
      <div>
        <dt>文件更新</dt>
        <dd>{formatTime(props.session.updatedAt)}</dd>
      </div>
      <div>
        <dt>扫描版本</dt>
        <dd title={props.session.revision}>{props.session.revision.slice(0, 12)}</dd>
      </div>
    </dl>
  )
}

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
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`
}

function projectName(projectPath?: string): string {
  const normalized = projectPath?.replace(/[\\/]+$/, '')
  return normalized?.split(/[\\/]/).pop() || '项目未知'
}

export function sessionTitle(session: AvailableSessionSummary): string {
  return session.title?.trim() || session.externalId
}

export function sessionOptionLabel(session: AvailableSessionSummary): string {
  const count = session.messageCount === undefined
    ? '消息数待读取'
    : `${session.messageCount} 条消息`
  return [
    sessionTitle(session),
    projectName(session.projectPath),
    session.sourceDisplayName,
    formatDate(session.startedAt),
    count
  ].join(' · ')
}

function timeRange(session: AvailableSessionSummary, loading: boolean): string {
  if (session.startedAt && session.endedAt) {
    return `${formatTime(session.startedAt)} → ${formatTime(session.endedAt)}`
  }
  if (session.startedAt) {
    return `${formatTime(session.startedAt)} → ${loading ? '正在读取…' : '结束时间未知'}`
  }
  if (session.endedAt) return `开始时间未知 → ${formatTime(session.endedAt)}`
  return loading ? '正在读取…' : '—'
}

function messageCount(
  session: AvailableSessionSummary,
  loading: boolean,
  error?: string
): string {
  if (session.messageCount !== undefined) return `${session.messageCount} 条`
  if (loading) return '正在统计…'
  return error ? '读取失败' : '尚未读取'
}

export function SessionMetadata(props: {
  session: AvailableSessionSummary
  class: string
  testId: string
  loading?: boolean
  error?: string
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
        <dt>消息条数</dt>
        <dd data-testid={`${props.testId}-message-count`}>
          {messageCount(props.session, Boolean(props.loading), props.error)}
        </dd>
      </div>
      <div>
        <dt>大小</dt>
        <dd>{formatBytes(props.session.sizeBytes)}</dd>
      </div>
      <div class="session-metadata__wide">
        <dt>时间范围</dt>
        <dd data-testid={`${props.testId}-time-range`}>
          {timeRange(props.session, Boolean(props.loading))}
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
      {props.error ? (
        <div class="session-metadata__wide session-metadata__error">
          <dt>详情读取</dt>
          <dd title={props.error}>{props.error}</dd>
        </div>
      ) : null}
    </dl>
  )
}

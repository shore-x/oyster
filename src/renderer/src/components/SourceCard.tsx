import { Show, createMemo } from 'solid-js'
import type { AgentSource, SyncRun } from '../../../shared/discovery'
import { Icon } from './Icon'

interface SourceCardProps {
  source: AgentSource
  run?: SyncRun
  onScan(): void
  onImport(): void
  onCancel(): void
  onChooseRoot(): void
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** unit
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

function formatDate(value?: string): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(new Date(value))
}

function status(source: AgentSource): { label: string; tone: string } {
  if (source.discoveryState === 'needs_permission') return { label: '需要权限', tone: 'warning' }
  if (source.discoveryState === 'error' || source.scanState === 'error') return { label: '出现错误', tone: 'danger' }
  if (source.discoveryState === 'not_found') return { label: '未发现', tone: 'muted' }
  if (source.scanState === 'scanning') return { label: '扫描中', tone: 'active' }
  if (source.scanState === 'ready') return { label: '已就绪', tone: 'success' }
  return { label: '已发现', tone: 'active' }
}

export function SourceCard(props: SourceCardProps) {
  const importRun = createMemo(() => (props.run?.kind === 'import' ? props.run : undefined))
  const scanRun = createMemo(() => (props.run?.kind === 'scan' ? props.run : undefined))
  const isRunning = createMemo(() => props.run?.state === 'running' || props.run?.state === 'queued')
  const state = createMemo(() =>
    isRunning() && importRun() ? { label: '导入中', tone: 'active' } : status(props.source)
  )
  const syncPercent = createMemo(() => {
    const run = importRun()
    if (run && run.totalBytes > 0) return Math.min(100, (run.processedBytes / run.totalBytes) * 100)
    if (props.source.totalBytes === 0) return 0
    return Math.min(100, (props.source.syncedBytes / props.source.totalBytes) * 100)
  })
  const pendingSessions = createMemo(() => props.source.sessionCount - props.source.syncedSessionCount)

  return (
    <article class="source-card" data-testid="source-card">
      <div class="source-card__header">
        <div class={`agent-mark agent-mark--${props.source.agentType}`} aria-hidden="true">
          {props.source.displayName.slice(0, 1)}
        </div>
        <div class="source-card__identity">
          <h2>{props.source.displayName}</h2>
          <div class="path" title={props.source.rootPath}>{props.source.rootPath}</div>
        </div>
        <div class={`status status--${state().tone}`}>
          <span class="status__dot" />{state().label}
        </div>
      </div>

      <Show when={props.source.discoveryState === 'found'} fallback={
        <div class="empty-source">
          <div>
            <div class="empty-source__title">
              {props.source.discoveryState === 'needs_permission' ? '无法读取历史记录' : '默认目录中没有可用数据'}
            </div>
            <Show when={props.source.errorMessage}>
              <div class="empty-source__hint">{props.source.errorMessage}</div>
            </Show>
          </div>
          <button class="button button--secondary" onClick={props.onChooseRoot}>
            <Icon name="folder" />选择目录
          </button>
        </div>
      }>
        <div class="metrics">
          <div><span class="metric__label">会话</span><strong>{props.source.sessionCount}</strong></div>
          <div><span class="metric__label">文件</span><strong>{props.source.fileCount}</strong></div>
          <div><span class="metric__label">数据量</span><strong>{formatBytes(props.source.totalBytes)}</strong></div>
          <div><span class="metric__label">时间范围</span><strong>{formatDate(props.source.oldestSessionAt)} – {formatDate(props.source.latestSessionAt)}</strong></div>
        </div>

        <div class="sync-block">
          <div class="sync-block__row">
            <span>{scanRun() && isRunning() ? '正在扫描历史记录' : importRun() && isRunning() ? '正在导入原始记录' : '导入覆盖'}</span>
            <span class="sync-block__value">
              {scanRun() && isRunning()
                ? `${scanRun()!.processedFiles} 个文件 · ${formatBytes(scanRun()!.processedBytes)}`
                : importRun() && isRunning()
                ? `${importRun()!.processedFiles} / ${importRun()!.totalFiles} 个会话`
                : `${props.source.syncedSessionCount} / ${props.source.sessionCount} 个会话`}
            </span>
          </div>
          <div
            class={`progress ${scanRun() && isRunning() ? 'progress--indeterminate' : ''}`}
            aria-label={scanRun() && isRunning() ? '扫描进度' : '导入进度'}
            aria-valuenow={scanRun() && isRunning() ? undefined : Math.round(syncPercent())}
            role="progressbar"
          >
            <span style={{ width: scanRun() && isRunning() ? '32%' : `${syncPercent()}%` }} />
          </div>
          <div class="sync-block__meta">
            <Show when={scanRun() && isRunning()} fallback={
              <>
                <span>{formatBytes(importRun() && isRunning() ? importRun()!.processedBytes : props.source.syncedBytes)} 已导入</span>
                <Show when={props.source.invalidFileCount > 0}>
                  <span>{props.source.invalidFileCount} 个文件无法识别</span>
                </Show>
              </>
            }>
              <span>总量将在扫描完成后确认</span>
            </Show>
          </div>
        </div>

        <div class="source-card__actions">
          <Show when={isRunning()} fallback={
            <>
              <button class="button button--ghost" onClick={props.onChooseRoot}>
                <Icon name="folder" />更改目录
              </button>
              <button class="button button--secondary" onClick={props.onScan}>
                <Icon name="refresh" />{props.source.scanState === 'ready' ? '重新扫描' : '扫描记录'}
              </button>
              <Show when={props.source.scanState === 'ready' && pendingSessions() > 0}>
                <button class="button button--primary" onClick={props.onImport}>
                  <Icon name="download" />导入 {pendingSessions()} 个会话
                </button>
              </Show>
              <Show when={props.source.scanState === 'ready' && pendingSessions() === 0 && props.source.sessionCount > 0}>
                <span class="complete-label"><Icon name="check" />已全部导入</span>
              </Show>
            </>
          }>
            <button class="button button--danger-quiet" onClick={props.onCancel}>
              <Icon name="stop" />取消
            </button>
          </Show>
        </div>
      </Show>
    </article>
  )
}

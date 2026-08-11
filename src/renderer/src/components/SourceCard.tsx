import { Show, createMemo } from 'solid-js'
import type { AgentSource, DiscoveryScan } from '../../../shared/discovery'
import { Button, Icon } from '../ui'

interface SourceCardProps {
  source: AgentSource
  scan?: DiscoveryScan
  onScan(): void
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
  const isScanning = createMemo(() => (
    props.scan?.status === 'in_progress' || props.scan?.status === 'queued'
  ))
  const state = createMemo(() => status(props.source))

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
          <Button variant="secondary" icon="folder" onClick={props.onChooseRoot}>选择目录</Button>
        </div>
      }>
        <details class="source-card__details ui-disclosure">
          <summary>
            {props.source.conversationCount} 个对话 · {formatBytes(props.source.totalBytes)} ·
            {' '}{formatDate(props.source.oldestConversationAt)} – {formatDate(props.source.latestConversationAt)}
          </summary>
          <div class="ui-disclosure__content">
            <div class="metrics">
              <div>
                <span class="metric__label">对话 · 文件</span>
                <strong>{props.source.conversationCount} · {props.source.fileCount}</strong>
              </div>
              <div><span class="metric__label">指令</span><strong>{props.source.instructionFileCount}</strong></div>
              <div><span class="metric__label">数据量</span><strong>{formatBytes(props.source.totalBytes)}</strong></div>
              <div><span class="metric__label">时间范围</span><strong>{formatDate(props.source.oldestConversationAt)} – {formatDate(props.source.latestConversationAt)}</strong></div>
            </div>

            <Show when={isScanning()} fallback={
              <div class="catalog-block">
                <div class="catalog-block__row">
                  <span>本地记录目录</span>
                  <span class="catalog-block__value">{props.source.conversationCount} 个 Source Conversations</span>
                </div>
                <div class="catalog-block__meta">
                  <span>内容将在使用时从原始位置读取</span>
                  <Show when={props.source.invalidFileCount > 0}>
                    <span>{props.source.invalidFileCount} 个文件无法识别</span>
                  </Show>
                </div>
              </div>
            }>
              <div class="catalog-block">
                <div class="catalog-block__row">
                  <span>正在扫描历史记录</span>
                  <span class="catalog-block__value">
                    {props.scan!.processedFiles} 个文件 · {formatBytes(props.scan!.processedBytes)}
                  </span>
                </div>
                <div class="progress progress--indeterminate" aria-label="扫描进度" role="progressbar">
                  <span style={{ width: '32%' }} />
                </div>
                <div class="catalog-block__meta"><span>总量将在扫描完成后确认</span></div>
              </div>
            </Show>

            <div class="source-card__actions">
              <Show when={isScanning()} fallback={
                <>
                  <Button variant="ghost" icon="folder" onClick={props.onChooseRoot}>更改目录</Button>
                  <Button variant="secondary" icon="refresh" onClick={props.onScan}>
                    {props.source.scanState === 'ready' ? '重新扫描' : '扫描记录'}
                  </Button>
                  <Show when={props.source.scanState === 'ready'}>
                    <span class="complete-label"><Icon name="check" />目录已扫描</span>
                  </Show>
                </>
              }>
                <Button variant="danger" icon="stop" onClick={props.onCancel}>取消</Button>
              </Show>
            </div>
          </div>
        </details>
      </Show>
    </article>
  )
}

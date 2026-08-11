import { Show, createMemo, createSignal, onMount } from 'solid-js'
import {
  DEFAULT_PI_AGENT_SETTINGS,
  type PiAgentSettingsView,
  type PiAgentTransport
} from '../../../shared/pi-agent-settings'
import { Button, Icon } from '../ui'
import { uiText } from '../i18n'

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function seconds(milliseconds: number): string {
  return String(milliseconds / 1_000)
}

export function PiAgentSettingsPanel() {
  const [settings, setSettings] = createSignal<PiAgentSettingsView>()
  const [autoCompactionEnabled, setAutoCompactionEnabled] = createSignal(
    DEFAULT_PI_AGENT_SETTINGS.autoCompactionEnabled
  )
  const [transport, setTransport] = createSignal<PiAgentTransport>(
    DEFAULT_PI_AGENT_SETTINGS.transport
  )
  const [httpIdleTimeoutSeconds, setHttpIdleTimeoutSeconds] = createSignal(
    seconds(DEFAULT_PI_AGENT_SETTINGS.httpIdleTimeoutMs)
  )
  const [pending, setPending] = createSignal(true)
  const [error, setError] = createSignal<string>()

  function apply(value: PiAgentSettingsView): void {
    setSettings(value)
    setAutoCompactionEnabled(value.autoCompactionEnabled)
    setTransport(value.transport)
    setHttpIdleTimeoutSeconds(seconds(value.httpIdleTimeoutMs))
  }

  async function load(): Promise<void> {
    try {
      setPending(true)
      setError(undefined)
      apply(await window.oyster.piAgentSettings.getSettings())
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setPending(false)
    }
  }

  onMount(() => { void load() })

  const timeoutMs = createMemo(() => Number(httpIdleTimeoutSeconds()) * 1_000)
  const timeoutValid = createMemo(() => (
    Number.isSafeInteger(timeoutMs()) && timeoutMs() >= 0
  ))
  const dirty = createMemo(() => {
    const current = settings()
    return Boolean(current) && (
      autoCompactionEnabled() !== current?.autoCompactionEnabled
      || transport() !== current?.transport
      || timeoutMs() !== current?.httpIdleTimeoutMs
    )
  })

  async function save(): Promise<void> {
    if (!timeoutValid()) return
    try {
      setPending(true)
      setError(undefined)
      apply(await window.oyster.piAgentSettings.saveSettings({
        autoCompactionEnabled: autoCompactionEnabled(),
        transport: transport(),
        httpIdleTimeoutMs: timeoutMs()
      }))
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setPending(false)
    }
  }

  function restoreDefaults(): void {
    setAutoCompactionEnabled(DEFAULT_PI_AGENT_SETTINGS.autoCompactionEnabled)
    setTransport(DEFAULT_PI_AGENT_SETTINGS.transport)
    setHttpIdleTimeoutSeconds(seconds(DEFAULT_PI_AGENT_SETTINGS.httpIdleTimeoutMs))
  }

  return (
    <div class="pi-agent-settings" data-testid="pi-agent-settings-panel">
      <div class="agent-config-section-heading">
        <div>
          <h3>Pi Coding Agent Runtime</h3>
          <p>{uiText(
            '写入 Pi 原生 settings.json，从下一次通用 Agent Invocation 起生效。',
            'Writes to Pi’s native settings.json and takes effect with the next General Agent Invocation.'
          )}</p>
        </div>
        <span>{uiText('通用 Agent', 'General Agent')}</span>
      </div>

      <Show when={error() || settings()?.error}>{(message) => (
        <div class="page-error" role="status"><Icon name="warning" />{message()}</div>
      )}</Show>

      <div class="pi-agent-settings__fields">
        <label class="pi-agent-setting pi-agent-setting--switch">
          <span>
            <strong>{uiText('自动上下文压缩', 'Automatic context compaction')}</strong>
            <small>
              {uiText(
                `接近模型上下文上限时总结较早历史。当前预留 ${settings()?.compactionReserveTokens.toLocaleString() ?? '—'} tokens，保留最近约 ${settings()?.compactionKeepRecentTokens.toLocaleString() ?? '—'} tokens。`,
                `Summarizes older history near the model context limit. Currently reserves ${settings()?.compactionReserveTokens.toLocaleString() ?? '—'} tokens, keeping about ${settings()?.compactionKeepRecentTokens.toLocaleString() ?? '—'} tokens.`
              )}
            </small>
          </span>
          <input
            type="checkbox"
            checked={autoCompactionEnabled()}
            disabled={pending()}
            data-testid="pi-agent-auto-compaction"
            onChange={(event) => setAutoCompactionEnabled(event.currentTarget.checked)}
          />
        </label>

        <label class="pi-agent-setting">
          <span>
            <strong>{uiText('Provider 传输方式', 'Provider transport')}</strong>
            <small>{uiText(
              'Auto 由 Pi 根据 Provider 能力选择；固定方式仅用于诊断或特定网络环境。',
              'Auto lets Pi choose based on Provider capabilities; fixed modes are intended for diagnostics or specific network environments.'
            )}</small>
          </span>
          <select
            value={transport()}
            disabled={pending()}
            data-testid="pi-agent-transport"
            onChange={(event) => setTransport(event.currentTarget.value as PiAgentTransport)}
          >
            <option value="auto">Auto</option>
            <option value="sse">SSE</option>
            <option value="websocket">WebSocket</option>
            <option value="websocket-cached">WebSocket Cached</option>
          </select>
        </label>

        <label class="pi-agent-setting">
          <span>
            <strong>{uiText('HTTP 空闲超时', 'HTTP idle timeout')}</strong>
            <small>{uiText(
              '等待响应数据期间允许的最长静默时间；设置为 0 表示不限制。',
              'Maximum silence while waiting for response data; set to 0 for no limit.'
            )}</small>
          </span>
          <span class="pi-agent-setting__number">
            <input
              type="number"
              min="0"
              step="1"
              value={httpIdleTimeoutSeconds()}
              disabled={pending()}
              aria-invalid={!timeoutValid()}
              data-testid="pi-agent-http-idle-timeout"
              onInput={(event) => setHttpIdleTimeoutSeconds(event.currentTarget.value)}
            />
            <em>{uiText('秒', 'sec')}</em>
          </span>
        </label>
      </div>

      <p class="pi-agent-settings__path" title={settings()?.settingsPath}>
        {settings()?.settingsPath || uiText('正在读取 Pi 配置…', 'Reading Pi settings…')}
      </p>
      <div class="pi-agent-settings__notice">
        {uiText(
          'Agent Turn 瞬时错误重试由 Oyster 固定为最多 3 次，不受此页面设置影响。Knowledge Maintainer 与 Reviewer 使用各自的隔离运行时设置。',
          'Oyster fixes transient Agent Turn retries at a maximum of 3; this page does not change that. Knowledge Maintainer and Reviewer use their own isolated runtime settings.'
        )}
      </div>
      <div class="pi-agent-settings__actions">
        <Button
          variant="ghost"
          icon="refresh"
          disabled={pending()}
          onClick={restoreDefaults}
        >{uiText('恢复 Pi 默认值', 'Restore Pi Defaults')}</Button>
        <Button
          variant="primary"
          icon="check"
          data-testid="save-pi-agent-settings"
          disabled={pending() || !settings() || !dirty() || !timeoutValid()}
          onClick={() => void save()}
        >{pending() ? uiText('保存中…', 'Saving…') : uiText('保存 Runtime 设置', 'Save Runtime Settings')}</Button>
      </div>
    </div>
  )
}

import { For, Show, createMemo, createSignal, onMount } from 'solid-js'
import type {
  PiExtensionConfigurationView,
  PiExtensionSourceKind,
  PiExtensionSourceView
} from '../../../shared/pi-extensions'
import { Button, Icon } from '../ui'
import { uiText } from '../i18n'

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

export function PiExtensionsPage() {
  const [configuration, setConfiguration] = createSignal<PiExtensionConfigurationView>()
  const [kind, setKind] = createSignal<PiExtensionSourceKind>('package')
  const [source, setSource] = createSignal('')
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const sources = createMemo(() => configuration()?.sources ?? [])

  async function load(): Promise<void> {
    try {
      setPending(true)
      setError(undefined)
      setConfiguration(await window.oyster.piExtensions.getConfiguration())
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setPending(false)
    }
  }

  onMount(() => { void load() })

  async function mutate(operation: () => Promise<PiExtensionConfigurationView>): Promise<void> {
    try {
      setPending(true)
      setError(undefined)
      setConfiguration(await operation())
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setPending(false)
    }
  }

  async function add(): Promise<void> {
    const value = source().trim()
    if (!value) return
    await mutate(() => window.oyster.piExtensions.addSource({ kind: kind(), source: value }))
    setSource('')
  }

  function toggle(item: PiExtensionSourceView): void {
    void mutate(() => window.oyster.piExtensions.setSourceEnabled({
      kind: item.kind,
      source: item.source,
      enabled: !item.enabled
    }))
  }

  function remove(item: PiExtensionSourceView): void {
    void mutate(() => window.oyster.piExtensions.removeSource({
      kind: item.kind,
      source: item.source
    }))
  }

  return (
    <div class="pi-extensions" data-testid="pi-extensions-page">
      <section class="pi-extensions__notice">
        <Icon name="warning" />
        <div>
          <strong>{uiText('Extension 安装即表示信任其代码', 'Installing an Extension means trusting its code')}</strong>
          <p>{uiText(
            'Headless Pi Extension 在 Electron 主进程中运行，拥有完整系统访问能力。Oyster 不会自动加载 Repository 内的 Extension。',
            'Headless Pi Extensions run in Electron’s main process with full system access. Oyster does not automatically load Extensions from the Repository.'
          )}</p>
        </div>
      </section>

      <Show when={error() || configuration()?.error}>{(message) => (
        <div class="page-error" role="status"><Icon name="warning" />{message()}</div>
      )}</Show>

      <section class="pi-extensions__add">
        <div>
          <h2>{uiText('添加 Extension', 'Add Extension')}</h2>
          <p>{uiText('配置写入 Pi 原生', 'Configuration is written to Pi’s native')} <code>settings.json</code>{uiText('，对下一次通用 Agent Invocation 生效。', ' and takes effect with the next General Agent Invocation.')}</p>
        </div>
        <div class="pi-extensions__add-controls">
          <select value={kind()} onChange={(event) => setKind(event.currentTarget.value as PiExtensionSourceKind)} aria-label={uiText('Extension 来源类型', 'Extension source type')}>
            <option value="package">Pi Package</option>
            <option value="local">{uiText('本地 Extension', 'Local Extension')}</option>
          </select>
          <input
            value={source()}
            onInput={(event) => setSource(event.currentTarget.value)}
            placeholder={kind() === 'package'
              ? 'npm:@scope/package 或 git:github.com/org/repo@ref'
              : '/absolute/path/to/extension.ts'}
            data-testid="pi-extension-source"
          />
          <Button variant="primary" icon="plus" disabled={pending() || !source().trim()} onClick={() => void add()}>
            {uiText('添加', 'Add')}
          </Button>
        </div>
      </section>

      <section class="pi-extensions__list">
        <div class="pi-extensions__list-heading">
          <div><h2>{uiText('通用 Agent Extension', 'General Agent Extensions')}</h2><p>{configuration()?.settingsPath || uiText('正在读取 Pi 配置…', 'Reading Pi settings…')}</p></div>
          <strong>{sources().length}</strong>
        </div>
        <Show when={!pending() || configuration()} fallback={<div class="pi-extensions__empty">{uiText('正在读取 Extension 配置…', 'Reading Extension configuration…')}</div>}>
          <Show when={sources().length} fallback={<div class="pi-extensions__empty">{uiText('尚未配置 Pi Package 或本地 Extension。', 'No Pi Package or local Extension is configured.')}</div>}>
            <For each={sources()}>{(item) => (
              <article class={`pi-extension-source${item.enabled ? '' : ' pi-extension-source--disabled'}`}>
                <span class="pi-extension-source__kind">{item.kind === 'package' ? 'Package' : 'Local'}</span>
                <code title={item.source}>{item.source}</code>
                <span class="pi-extension-source__status">{item.enabled ? uiText('已启用', 'Enabled') : uiText('已停用', 'Disabled')}</span>
                <Button variant="secondary" icon={item.enabled ? 'stop' : 'play'} disabled={pending()} onClick={() => toggle(item)}>
                  {item.enabled ? uiText('停用', 'Disable') : uiText('启用', 'Enable')}
                </Button>
                <Button variant="ghost" icon="trash" disabled={pending()} onClick={() => remove(item)}>{uiText('移除', 'Remove')}</Button>
              </article>
            )}</For>
          </Show>
        </Show>
      </section>
    </div>
  )
}

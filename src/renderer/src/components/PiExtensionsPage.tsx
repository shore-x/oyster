import { For, Show, createMemo, createSignal, onMount } from 'solid-js'
import type {
  PiExtensionConfigurationView,
  PiExtensionSourceKind,
  PiExtensionSourceView
} from '../../../shared/pi-extensions'
import { Button, Icon } from '../ui'

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
          <strong>Extension 安装即表示信任其代码</strong>
          <p>Headless Pi Extension 在 Electron 主进程中运行，拥有完整系统访问能力。Oyster 不会自动加载 Repository 内的 Extension。</p>
        </div>
      </section>

      <Show when={error() || configuration()?.error}>{(message) => (
        <div class="page-error" role="status"><Icon name="warning" />{message()}</div>
      )}</Show>

      <section class="pi-extensions__add">
        <div>
          <h2>添加 Extension</h2>
          <p>配置写入 Pi 原生 <code>settings.json</code>，对下一次通用 Agent Invocation 生效。</p>
        </div>
        <div class="pi-extensions__add-controls">
          <select value={kind()} onChange={(event) => setKind(event.currentTarget.value as PiExtensionSourceKind)} aria-label="Extension 来源类型">
            <option value="package">Pi Package</option>
            <option value="local">本地 Extension</option>
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
            添加
          </Button>
        </div>
      </section>

      <section class="pi-extensions__list">
        <div class="pi-extensions__list-heading">
          <div><h2>通用 Agent Extension</h2><p>{configuration()?.settingsPath || '正在读取 Pi 配置…'}</p></div>
          <strong>{sources().length}</strong>
        </div>
        <Show when={!pending() || configuration()} fallback={<div class="pi-extensions__empty">正在读取 Extension 配置…</div>}>
          <Show when={sources().length} fallback={<div class="pi-extensions__empty">尚未配置 Pi Package 或本地 Extension。</div>}>
            <For each={sources()}>{(item) => (
              <article class={`pi-extension-source${item.enabled ? '' : ' pi-extension-source--disabled'}`}>
                <span class="pi-extension-source__kind">{item.kind === 'package' ? 'Package' : 'Local'}</span>
                <code title={item.source}>{item.source}</code>
                <span class="pi-extension-source__status">{item.enabled ? '已启用' : '已停用'}</span>
                <Button variant="secondary" icon={item.enabled ? 'stop' : 'play'} disabled={pending()} onClick={() => toggle(item)}>
                  {item.enabled ? '停用' : '启用'}
                </Button>
                <Button variant="ghost" icon="trash" disabled={pending()} onClick={() => remove(item)}>移除</Button>
              </article>
            )}</For>
          </Show>
        </Show>
      </section>
    </div>
  )
}

import { For, Show, createEffect, createMemo, createSignal } from 'solid-js'
import {
  createAgentConfigurationController,
  type AgentConfigurationRoleId
} from '../agent-configuration-controller'
import { runtimeLabel } from '../processing-configuration'
import { Button, Icon } from '../ui'

export function AgentConfigurationPage() {
  const controller = createAgentConfigurationController()
  const [selectedRoleId, setSelectedRoleId] = createSignal<AgentConfigurationRoleId>()
  const [detailView, setDetailView] = createSignal<'prompt' | 'tools'>('prompt')
  const [promptDraft, setPromptDraft] = createSignal('')
  const selectedRole = createMemo(() => controller.roles().find(
    (role) => role.id === selectedRoleId()
  ) ?? controller.roles()[0])

  createEffect(() => {
    if (controller.loading()) return
    const first = controller.roles()[0]
    if (!selectedRoleId() && first) setSelectedRoleId(first.id)
  })

  let previousPromptKey: string | undefined
  createEffect(() => {
    const role = selectedRole()
    if (!role) return
    const key = `${role.id}\0${role.defaultInstructions}`
    if (key === previousPromptKey) return
    previousPromptKey = key
    setPromptDraft(role.defaultInstructions)
  })

  const dirty = createMemo(() => {
    const role = selectedRole()
    return role ? promptDraft() !== role.defaultInstructions : false
  })

  async function saveDefault(): Promise<void> {
    const role = selectedRole()
    if (!role) return
    const draft = promptDraft().trim()
    if (!draft) return
    await controller.saveDefaultInstructions(
      role.id,
      draft === role.builtInInstructions ? null : draft
    )
  }

  async function restoreBuiltIn(): Promise<void> {
    const role = selectedRole()
    if (!role) return
    if (await controller.saveDefaultInstructions(role.id, null)) {
      setPromptDraft(role.builtInInstructions)
    }
  }

  return (
    <>
      <header class="page-header">
        <div>
          <h1>Agent 配置</h1>
          <div class="page-summary">
            <span><strong>{controller.roles().length}</strong> 个 AI 运行角色</span>
            <span class="page-summary__separator">·</span>
            <span>默认 Prompt 可配置，工具由代码提供</span>
          </div>
        </div>
      </header>

      <Show when={controller.error()}>
        <div class="page-error"><Icon name="warning" />{controller.error()}</div>
      </Show>
      <For each={controller.configurationErrors()}>{(message) => (
        <div class="page-error"><Icon name="warning" />{message}</div>
      )}</For>

      <div class="agent-config-layout" data-testid="agent-configuration-workspace">
        <aside class="agent-config-roles" aria-label="AI 运行角色">
          <div class="agent-config-roles__heading">
            <span>运行角色</span>
            <strong>{controller.roles().length}</strong>
          </div>
          <Show
            when={!controller.loading()}
            fallback={<div class="agent-config-roles__empty">正在读取配置…</div>}
          >
            <For each={controller.roles()}>{(role) => (
              <button
                type="button"
                class="agent-config-role"
                data-testid={`agent-config-role-${role.id}`}
                aria-selected={selectedRole()?.id === role.id}
                onClick={() => {
                  setSelectedRoleId(role.id)
                  setDetailView('prompt')
                }}
              >
                <span class="agent-config-role__mark">{role.runtime === 'pi_agent_core' ? 'A' : 'M'}</span>
                <span>
                  <strong>{role.displayName}</strong>
                  <small>{runtimeLabel(role.runtime)} · {role.tools.length} 个工具</small>
                </span>
                <em>{role.isDefaultCustomized ? '自定义默认' : '代码默认'}</em>
              </button>
            )}</For>
          </Show>
        </aside>

        <Show when={selectedRole()}>
          {(role) => (
            <section class="agent-config-detail" data-testid={`agent-config-detail-${role().id}`}>
              <div class="agent-config-detail__header">
                <div>
                  <div class="agent-config-detail__identity">
                    <h2>{role().displayName}</h2>
                    <span class="processing-runtime">{runtimeLabel(role().runtime)}</span>
                  </div>
                  <p>{role().description}</p>
                </div>
                <span class={`processing-mode-badge${role().isDefaultCustomized ? ' processing-mode-badge--custom' : ''}`}>
                  {role().isDefaultCustomized ? 'Configured default' : 'Built-in default'}
                </span>
              </div>

              <div class="agent-config-tabs" role="tablist" aria-label="角色配置内容">
                <button
                  type="button"
                  role="tab"
                  data-testid="agent-config-tab-prompt"
                  aria-selected={detailView() === 'prompt'}
                  onClick={() => setDetailView('prompt')}
                >System Prompt</button>
                <button
                  type="button"
                  role="tab"
                  data-testid="agent-config-tab-tools"
                  aria-selected={detailView() === 'tools'}
                  onClick={() => setDetailView('tools')}
                >Tools <span>{role().tools.length}</span></button>
              </div>

              <Show when={detailView() === 'prompt'}>
                <div class="agent-config-prompt" data-testid="agent-config-prompt-panel">
                  <div class="agent-config-section-heading">
                    <div>
                      <h3>默认 System Prompt</h3>
                      <p>{role().promptUsageDescription}</p>
                    </div>
                    <span>{role().promptUsageStatus}</span>
                  </div>
                  <textarea
                    class="processing-prompt__editor"
                    data-testid="agent-default-prompt-editor"
                    value={promptDraft()}
                    rows={22}
                    spellcheck={false}
                    disabled={controller.isSaving(role().id)}
                    onInput={(event) => setPromptDraft(event.currentTarget.value)}
                  />
                  <Show when={controller.wasSaved(role().id) && !dirty()}>
                    <div class="knowledge-browser__notice" role="status" data-testid="agent-default-prompt-saved">
                      已保存 {role().displayName} 的默认 System Prompt。
                    </div>
                  </Show>
                  <div class="agent-config-prompt__actions">
                    <Button
                      variant="ghost"
                      icon="refresh"
                      data-testid="restore-built-in-agent-prompt"
                      disabled={controller.isSaving(role().id) || (!role().isDefaultCustomized && !dirty())}
                      onClick={() => void restoreBuiltIn()}
                    >恢复代码默认</Button>
                    <Button
                      variant="primary"
                      icon="check"
                      data-testid="save-agent-default-prompt"
                      disabled={controller.isSaving(role().id) || !dirty() || !promptDraft().trim()}
                      onClick={() => void saveDefault()}
                    >{controller.isSaving(role().id) ? '保存中…' : '保存默认 Prompt'}</Button>
                  </div>
                  <details class="agent-config-built-in ui-disclosure">
                    <summary>查看代码内置 Prompt</summary>
                    <pre>{role().builtInInstructions}</pre>
                  </details>
                </div>
              </Show>

              <Show when={detailView() === 'tools'}>
                <div class="agent-config-tools" data-testid="agent-config-tools-panel">
                  <div class="agent-config-section-heading">
                    <div>
                      <h3>Tools</h3>
                      <p>以下清单与 Agent 运行时使用同一份代码定义，只读展示。</p>
                    </div>
                    <span>{role().tools.length} 个工具</span>
                  </div>
                  <Show
                    when={role().tools.length}
                    fallback={(
                      <div class="agent-config-tools__empty">
                        该角色直接调用模型，不向模型提供工具。
                      </div>
                    )}
                  >
                    <div class="agent-config-tool-list">
                      <For each={role().tools}>{(tool) => (
                        <article class="agent-config-tool" data-testid={`agent-tool-${tool.name}`}>
                          <div class="agent-config-tool__identity">
                            <strong>{tool.label}</strong><code>{tool.name}</code>
                          </div>
                          <p>{tool.description}</p>
                          <details
                            class="agent-config-tool__schema ui-disclosure"
                            data-testid={`agent-tool-schema-${tool.name}`}
                          >
                            <summary>
                              <span>参数定义</span>
                              <small>JSON Schema</small>
                            </summary>
                            <pre>{JSON.stringify(tool.parameters, null, 2)}</pre>
                          </details>
                        </article>
                      )}</For>
                    </div>
                  </Show>
                </div>
              </Show>
            </section>
          )}
        </Show>
      </div>
    </>
  )
}

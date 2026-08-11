import { For, Show, createEffect, createMemo, createSignal } from 'solid-js'
import {
  createAgentConfigurationController,
  type AgentConfigurationRoleId
} from '../agent-configuration-controller'
import { CHAT_AGENT_ID } from '../../../shared/chat'
import { runtimeLabel } from '../processing-configuration'
import { Button, Icon } from '../ui'
import { PiAgentSettingsPanel } from './PiAgentSettingsPanel'
import { uiText } from '../i18n'

function roleDisplayName(roleId: AgentConfigurationRoleId, fallback: string): string {
  if (roleId === CHAT_AGENT_ID) return uiText('通用 Agent', 'General Agent')
  if (roleId === 'knowledge_maintainer') return uiText('知识维护 Agent', 'Knowledge Maintainer')
  if (roleId === 'knowledge_reviewer') return uiText('知识审阅 Agent', 'Knowledge Reviewer')
  return fallback
}

function roleDescription(roleId: AgentConfigurationRoleId, fallback: string): string {
  if (roleId === CHAT_AGENT_ID) return uiText(
    '理解和维护 Oyster 的 Knowledge 与 Artifact。',
    'Understands and maintains Oyster Knowledge and Artifacts.'
  )
  if (roleId === 'knowledge_maintainer') return uiText(
    '在统一 Repository 中按 Task 工作清单检查活动并直接维护 Knowledge 与 Artifact。',
    'Checks activities from the Task checklist and directly maintains Knowledge and Artifacts in the unified Repository.'
  )
  if (roleId === 'knowledge_reviewer') return uiText(
    '在同一 Task branch 上独立审阅文件 tree，并通过 Task 记录反馈或批准。',
    'Independently reviews the file tree on the same Task branch and records feedback or approval through the Task.'
  )
  return fallback
}

export function AgentConfigurationPage(props: { embedded?: boolean } = {}) {
  const controller = createAgentConfigurationController()
  const [selectedRoleId, setSelectedRoleId] = createSignal<AgentConfigurationRoleId>()
  const [detailView, setDetailView] = createSignal<'prompt' | 'tools' | 'runtime'>('prompt')
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
      <Show when={!props.embedded}>
        <header class="page-header">
          <div>
            <h1>{uiText('Agent 配置', 'Agent Configuration')}</h1>
            <div class="page-summary">
              <span><strong>{controller.roles().length}</strong> {uiText('个 Agent', 'Agents')}</span>
              <span class="page-summary__separator">·</span>
              <span>{uiText('默认 Prompt 与通用 Agent Runtime 可配置', 'Configure default Prompts and the General Agent Runtime')}</span>
            </div>
          </div>
        </header>
      </Show>

      <Show when={controller.error()}>
        <div class="page-error"><Icon name="warning" />{controller.error()}</div>
      </Show>
      <For each={controller.configurationErrors()}>{(message) => (
        <div class="page-error"><Icon name="warning" />{message}</div>
      )}</For>

      <div class="agent-config-layout" data-testid="agent-configuration-workspace">
        <aside class="agent-config-roles" aria-label="Agent">
          <div class="agent-config-roles__heading">
            <span>Agents</span>
            <strong>{controller.roles().length}</strong>
          </div>
          <Show
            when={!controller.loading()}
            fallback={<div class="agent-config-roles__empty">{uiText('正在读取配置…', 'Reading configuration…')}</div>}
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
                <span class="agent-config-role__mark">A</span>
                <span>
                  <strong>{roleDisplayName(role.id, role.displayName)}</strong>
                  <small>{runtimeLabel(role.runtime)} · {role.tools.length} {uiText('个工具', 'tools')}</small>
                </span>
                <em>{role.isDefaultCustomized ? uiText('自定义默认', 'Custom default') : uiText('代码默认', 'Code default')}</em>
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
                    <h2>{roleDisplayName(role().id, role().displayName)}</h2>
                    <span class="agent-runtime-label">{runtimeLabel(role().runtime)}</span>
                  </div>
                  <p>{roleDescription(role().id, role().description)}</p>
                </div>
                <span class={`processing-mode-badge${role().isDefaultCustomized ? ' processing-mode-badge--custom' : ''}`}>
                  {role().isDefaultCustomized
                    ? uiText('已配置默认值', 'Configured default')
                    : uiText('内置默认值', 'Built-in default')}
                </span>
              </div>

              <div class="agent-config-tabs" role="tablist" aria-label={uiText('Agent 配置内容', 'Agent configuration content')}>
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
                <Show when={role().id === CHAT_AGENT_ID}>
                  <button
                    type="button"
                    role="tab"
                    data-testid="agent-config-tab-runtime"
                    aria-selected={detailView() === 'runtime'}
                    onClick={() => setDetailView('runtime')}
                  >Pi Runtime</button>
                </Show>
              </div>

              <Show when={detailView() === 'prompt'}>
                <div class="agent-config-prompt" data-testid="agent-config-prompt-panel">
                  <div class="agent-config-section-heading">
                    <div>
                      <h3>{uiText('默认 System Prompt', 'Default System Prompt')}</h3>
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
                      {uiText('已保存', 'Saved')} {roleDisplayName(role().id, role().displayName)} {uiText('的默认 System Prompt。', 'default System Prompt.')}
                    </div>
                  </Show>
                  <div class="agent-config-prompt__actions">
                    <Button
                      variant="ghost"
                      icon="refresh"
                      data-testid="restore-built-in-agent-prompt"
                      disabled={controller.isSaving(role().id) || (!role().isDefaultCustomized && !dirty())}
                      onClick={() => void restoreBuiltIn()}
                    >{uiText('恢复代码默认', 'Restore Code Default')}</Button>
                    <Button
                      variant="primary"
                      icon="check"
                      data-testid="save-agent-default-prompt"
                      disabled={controller.isSaving(role().id) || !dirty() || !promptDraft().trim()}
                      onClick={() => void saveDefault()}
                    >{controller.isSaving(role().id) ? uiText('保存中…', 'Saving…') : uiText('保存默认 Prompt', 'Save Default Prompt')}</Button>
                  </div>
                  <details class="agent-config-built-in ui-disclosure">
                    <summary>{uiText('查看代码内置 Prompt', 'View Built-in Prompt')}</summary>
                    <pre>{role().builtInInstructions}</pre>
                  </details>
                </div>
              </Show>

              <Show when={detailView() === 'tools'}>
                <div class="agent-config-tools" data-testid="agent-config-tools-panel">
                  <div class="agent-config-section-heading">
                    <div>
                      <h3>Tools</h3>
                      <p>{uiText(
                        '以下清单与 Agent Invocation 实际使用同一份代码定义，只读展示。',
                        'This read-only list uses the same code definitions as the actual Agent Invocation.'
                      )}</p>
                    </div>
                    <span>{role().tools.length} {uiText('个工具', 'tools')}</span>
                  </div>
                  <Show
                    when={role().tools.length}
                    fallback={(
                      <div class="agent-config-tools__empty">
                        {uiText('该 Agent 当前没有工具。', 'This Agent currently has no tools.')}
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
                              <span>{uiText('参数定义', 'Parameters')}</span>
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

              <Show when={detailView() === 'runtime' && role().id === CHAT_AGENT_ID}>
                <PiAgentSettingsPanel />
              </Show>
            </section>
          )}
        </Show>
      </div>
    </>
  )
}

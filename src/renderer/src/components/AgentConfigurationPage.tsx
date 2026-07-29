import { For, Show, createEffect, createMemo, createSignal } from 'solid-js'
import type { ProcessingStageId } from '../../../shared/knowledge-processing'
import { createAgentConfigurationController } from '../agent-configuration-controller'
import { runtimeLabel } from '../processing-configuration'
import { Button, Icon } from '../ui'

export function AgentConfigurationPage() {
  const controller = createAgentConfigurationController()
  const [selectedStageId, setSelectedStageId] = createSignal<ProcessingStageId>()
  const [detailView, setDetailView] = createSignal<'prompt' | 'tools'>('prompt')
  const [promptDraft, setPromptDraft] = createSignal('')
  const selectedStage = createMemo(() => controller.snapshot().stages.find(
    (stage) => stage.id === selectedStageId()
  ) ?? controller.snapshot().stages[0])

  createEffect(() => {
    const first = controller.snapshot().stages[0]
    if (!selectedStageId() && first) setSelectedStageId(first.id)
  })

  let previousPromptKey: string | undefined
  createEffect(() => {
    const stage = selectedStage()
    if (!stage) return
    const key = `${stage.id}\0${stage.defaultInstructions}`
    if (key === previousPromptKey) return
    previousPromptKey = key
    setPromptDraft(stage.defaultInstructions)
  })

  const dirty = createMemo(() => {
    const stage = selectedStage()
    return stage ? promptDraft() !== stage.defaultInstructions : false
  })

  async function saveDefault(): Promise<void> {
    const stage = selectedStage()
    if (!stage) return
    const draft = promptDraft().trim()
    if (!draft) return
    await controller.saveDefaultInstructions(
      stage.id,
      draft === stage.builtInInstructions ? null : draft
    )
  }

  async function restoreBuiltIn(): Promise<void> {
    const stage = selectedStage()
    if (!stage) return
    if (await controller.saveDefaultInstructions(stage.id, null)) {
      setPromptDraft(stage.builtInInstructions)
    }
  }

  return (
    <>
      <header class="page-header">
        <div>
          <h1>Agent 配置</h1>
          <div class="page-summary">
            <span><strong>{controller.snapshot().stages.length}</strong> 个 AI 运行角色</span>
            <span class="page-summary__separator">·</span>
            <span>默认 Prompt 可配置，工具由代码提供</span>
          </div>
        </div>
      </header>

      <Show when={controller.error()}>
        <div class="page-error"><Icon name="warning" />{controller.error()}</div>
      </Show>
      <Show when={controller.snapshot().configurationError}>
        <div class="page-error"><Icon name="warning" />{controller.snapshot().configurationError}</div>
      </Show>

      <div class="agent-config-layout" data-testid="agent-configuration-workspace">
        <aside class="agent-config-roles" aria-label="AI 运行角色">
          <div class="agent-config-roles__heading">
            <span>运行角色</span>
            <strong>{controller.snapshot().stages.length}</strong>
          </div>
          <Show
            when={!controller.loading()}
            fallback={<div class="agent-config-roles__empty">正在读取配置…</div>}
          >
            <For each={controller.snapshot().stages}>{(stage) => (
              <button
                type="button"
                class="agent-config-role"
                data-testid={`agent-config-role-${stage.id}`}
                aria-selected={selectedStage()?.id === stage.id}
                onClick={() => {
                  setSelectedStageId(stage.id)
                  setDetailView('prompt')
                }}
              >
                <span class="agent-config-role__mark">{stage.runtime === 'pi_agent_core' ? 'A' : 'M'}</span>
                <span>
                  <strong>{stage.displayName}</strong>
                  <small>{runtimeLabel(stage.runtime)} · {stage.tools.length} 个工具</small>
                </span>
                <em>{stage.isDefaultCustomized ? '自定义默认' : '代码默认'}</em>
              </button>
            )}</For>
          </Show>
        </aside>

        <Show when={selectedStage()}>
          {(stage) => (
            <section class="agent-config-detail" data-testid={`agent-config-detail-${stage().id}`}>
              <div class="agent-config-detail__header">
                <div>
                  <div class="agent-config-detail__identity">
                    <h2>{stage().displayName}</h2>
                    <span class="processing-runtime">{runtimeLabel(stage().runtime)}</span>
                  </div>
                  <p>{stage().description}</p>
                </div>
                <span class={`processing-mode-badge${stage().isDefaultCustomized ? ' processing-mode-badge--custom' : ''}`}>
                  {stage().isDefaultCustomized ? 'Configured default' : 'Built-in default'}
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
                >Tools <span>{stage().tools.length}</span></button>
              </div>

              <Show when={detailView() === 'prompt'}>
                <div class="agent-config-prompt" data-testid="agent-config-prompt-panel">
                  <div class="agent-config-section-heading">
                    <div>
                      <h3>默认 System Prompt</h3>
                      <p>没有阶段覆盖的运行使用此值；加工测试页的阶段覆盖优先级更高。</p>
                    </div>
                    <span>{stage().isCustomized ? '加工测试存在覆盖' : '当前运行使用默认'}</span>
                  </div>
                  <textarea
                    class="processing-prompt__editor"
                    data-testid="agent-default-prompt-editor"
                    value={promptDraft()}
                    rows={22}
                    spellcheck={false}
                    disabled={controller.isSaving(stage().id)}
                    onInput={(event) => setPromptDraft(event.currentTarget.value)}
                  />
                  <Show when={controller.wasSaved(stage().id) && !dirty()}>
                    <div class="knowledge-browser__notice" role="status" data-testid="agent-default-prompt-saved">
                      已保存 {stage().displayName} 的默认 System Prompt。
                    </div>
                  </Show>
                  <div class="agent-config-prompt__actions">
                    <Button
                      variant="ghost"
                      icon="refresh"
                      data-testid="restore-built-in-agent-prompt"
                      disabled={controller.isSaving(stage().id) || (!stage().isDefaultCustomized && !dirty())}
                      onClick={() => void restoreBuiltIn()}
                    >恢复代码默认</Button>
                    <Button
                      variant="primary"
                      icon="check"
                      data-testid="save-agent-default-prompt"
                      disabled={controller.isSaving(stage().id) || !dirty() || !promptDraft().trim()}
                      onClick={() => void saveDefault()}
                    >{controller.isSaving(stage().id) ? '保存中…' : '保存默认 Prompt'}</Button>
                  </div>
                  <details class="agent-config-built-in">
                    <summary>查看代码内置 Prompt</summary>
                    <pre>{stage().builtInInstructions}</pre>
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
                    <span>{stage().tools.length} 个工具</span>
                  </div>
                  <Show
                    when={stage().tools.length}
                    fallback={(
                      <div class="agent-config-tools__empty">
                        该角色直接调用模型，不向模型提供工具。
                      </div>
                    )}
                  >
                    <div class="agent-config-tool-list">
                      <For each={stage().tools}>{(tool) => (
                        <article class="agent-config-tool" data-testid={`agent-tool-${tool.name}`}>
                          <div><strong>{tool.label}</strong><code>{tool.name}</code></div>
                          <p>{tool.description}</p>
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

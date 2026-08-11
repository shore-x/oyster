import { createSignal } from 'solid-js'
import { AgentConfigurationPage } from './AgentConfigurationPage'
import { AiBackendsPage } from './AiBackendsPage'
import { PiExtensionsPage } from './PiExtensionsPage'

type SettingsTab = 'ai-backends' | 'agents' | 'extensions'

export function SettingsPage() {
  const [tab, setTab] = createSignal<SettingsTab>('ai-backends')

  return (
    <div class="settings-page" data-testid="settings-page">
      <header class="page-header">
        <div>
          <h1>设置</h1>
          <div class="page-summary">
            <span>模型连接与 Agent 行为</span>
          </div>
        </div>
      </header>

      <div class="page-tabs" role="tablist" aria-label="设置分类">
        <button
          type="button"
          role="tab"
          aria-selected={tab() === 'ai-backends'}
          data-testid="settings-tab-ai-backends"
          onClick={() => setTab('ai-backends')}
        >AI 后端</button>
        <button
          type="button"
          role="tab"
          aria-selected={tab() === 'agents'}
          data-testid="nav-agent-configuration"
          onClick={() => setTab('agents')}
        ><span data-testid="settings-tab-agents">Agent 配置</span></button>
        <button
          type="button"
          role="tab"
          aria-selected={tab() === 'extensions'}
          data-testid="settings-tab-extensions"
          onClick={() => setTab('extensions')}
        >Pi Extensions</button>
      </div>

      <section
        class="settings-page__panel"
        role="tabpanel"
        data-testid="page-ai-backends"
        hidden={tab() !== 'ai-backends'}
      >
        <AiBackendsPage embedded />
      </section>
      <section
        class="settings-page__panel"
        role="tabpanel"
        data-testid="page-pi-extensions"
        hidden={tab() !== 'extensions'}
      >
        <PiExtensionsPage />
      </section>
      <section
        class="settings-page__panel settings-page__panel--workspace"
        role="tabpanel"
        data-testid="page-agent-configuration"
        hidden={tab() !== 'agents'}
      >
        <AgentConfigurationPage embedded />
      </section>
    </div>
  )
}

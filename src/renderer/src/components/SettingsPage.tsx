import { createSignal } from 'solid-js'
import { AgentConfigurationPage } from './AgentConfigurationPage'
import { AiBackendsPage } from './AiBackendsPage'
import { PiExtensionsPage } from './PiExtensionsPage'
import { GeneralSettingsPage } from './GeneralSettingsPage'
import { uiText } from '../i18n'

type SettingsTab = 'general' | 'ai-backends' | 'agents' | 'extensions'

export function SettingsPage() {
  const [tab, setTab] = createSignal<SettingsTab>('general')

  return (
    <div class="settings-page" data-testid="settings-page">
      <header class="page-header">
        <div>
          <h1>{uiText('设置', 'Settings')}</h1>
          <div class="page-summary">
            <span>{uiText('应用偏好、模型连接与 Agent 行为', 'Application preferences, model connections, and Agent behavior')}</span>
          </div>
        </div>
      </header>

      <div class="page-tabs" role="tablist" aria-label={uiText('设置分类', 'Settings categories')}>
        <button
          type="button"
          role="tab"
          aria-selected={tab() === 'general'}
          data-testid="settings-tab-general"
          onClick={() => setTab('general')}
        >{uiText('通用', 'General')}</button>
        <button
          type="button"
          role="tab"
          aria-selected={tab() === 'ai-backends'}
          data-testid="settings-tab-ai-backends"
          onClick={() => setTab('ai-backends')}
        >{uiText('AI 后端', 'AI Backends')}</button>
        <button
          type="button"
          role="tab"
          aria-selected={tab() === 'agents'}
          data-testid="nav-agent-configuration"
          onClick={() => setTab('agents')}
        ><span data-testid="settings-tab-agents">{uiText('Agent 配置', 'Agent Configuration')}</span></button>
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
        data-testid="page-general-settings"
        hidden={tab() !== 'general'}
      >
        <GeneralSettingsPage />
      </section>

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

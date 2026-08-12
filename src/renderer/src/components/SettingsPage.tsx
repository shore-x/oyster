import { Show, createSignal } from 'solid-js'
import { AgentConfigurationPage } from './AgentConfigurationPage'
import { AiBackendsPage } from './AiBackendsPage'
import { PiExtensionsPage } from './PiExtensionsPage'
import { GeneralSettingsPage } from './GeneralSettingsPage'
import { FolderBrowserPage } from './FolderBrowserPage'
import { uiText } from '../i18n'
import { Tab, TabList } from '../ui'

type SettingsTab = 'general' | 'ai-backends' | 'agents' | 'extensions'

export function SettingsPage() {
  const [tab, setTab] = createSignal<SettingsTab>('general')
  const [designDocumentsPath, setDesignDocumentsPath] = createSignal<string>()
  const [designDocumentsBusy, setDesignDocumentsBusy] = createSignal<'browse' | 'open'>()
  const [designDocumentsError, setDesignDocumentsError] = createSignal<string>()

  async function browseDesignDocuments(): Promise<void> {
    try {
      setDesignDocumentsBusy('browse')
      setDesignDocumentsError(undefined)
      setDesignDocumentsPath(await window.oyster.folderBrowser.getDesignDocumentsPath())
    } catch (error) {
      setDesignDocumentsError(error instanceof Error ? error.message : String(error))
    } finally {
      setDesignDocumentsBusy(undefined)
    }
  }

  async function openDesignDocuments(): Promise<void> {
    try {
      setDesignDocumentsBusy('open')
      setDesignDocumentsError(undefined)
      const folderPath = await window.oyster.folderBrowser.getDesignDocumentsPath()
      await window.oyster.folderBrowser.openFolder(folderPath)
    } catch (error) {
      setDesignDocumentsError(error instanceof Error ? error.message : String(error))
    } finally {
      setDesignDocumentsBusy(undefined)
    }
  }

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

      <TabList class="page-tabs" ariaLabel={uiText('设置分类', 'Settings categories')}>
        <Tab
          selected={tab() === 'general'}
          data-testid="settings-tab-general"
          onClick={() => setTab('general')}
        >{uiText('通用', 'General')}</Tab>
        <Tab
          selected={tab() === 'ai-backends'}
          data-testid="settings-tab-ai-backends"
          onClick={() => setTab('ai-backends')}
        >{uiText('AI 后端', 'AI Backends')}</Tab>
        <Tab
          selected={tab() === 'agents'}
          data-testid="nav-agent-configuration"
          onClick={() => setTab('agents')}
        ><span data-testid="settings-tab-agents">{uiText('Agent 配置', 'Agent Configuration')}</span></Tab>
        <Tab
          selected={tab() === 'extensions'}
          data-testid="settings-tab-extensions"
          onClick={() => setTab('extensions')}
        >Pi Extensions</Tab>
      </TabList>

      <section
        class={`settings-page__panel${designDocumentsPath() ? ' settings-page__panel--workspace' : ''}`}
        role="tabpanel"
        data-testid="page-general-settings"
        hidden={tab() !== 'general'}
      >
        <Show
          when={designDocumentsPath()}
          fallback={(
            <GeneralSettingsPage
              designDocumentsBusy={designDocumentsBusy()}
              designDocumentsError={designDocumentsError()}
              onBrowseDesignDocuments={() => void browseDesignDocuments()}
              onOpenDesignDocuments={() => void openDesignDocuments()}
            />
          )}
        >
          {(folderPath) => (
            <div class="settings-page__folder-browser" data-testid="settings-design-documents-browser">
              <FolderBrowserPage
                embedded
                folderPath={folderPath()}
                label={uiText('Oyster 设计文档', 'Oyster Design Documents')}
                onBack={() => setDesignDocumentsPath(undefined)}
              />
            </div>
          )}
        </Show>
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

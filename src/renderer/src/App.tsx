import { For, Show, createMemo, createSignal } from 'solid-js'
import { createDiscoveryController } from './discovery-controller'
import { ChatPage } from './components/ChatPage'
import { ArtifactsPage, type ArtifactBrowserTarget } from './components/ArtifactsPage'
import { KnowledgeProcessingPage } from './components/KnowledgeProcessingPage'
import { KnowledgeBrowserPage } from './components/KnowledgeBrowserPage'
import { SettingsPage } from './components/SettingsPage'
import { SkillsPage, type SkillsNavigationRequest } from './components/SkillsPage'
import { SourceCard } from './components/SourceCard'
import { Button, Icon } from './ui'

type PageId = 'chat' | 'knowledge' | 'artifacts' | 'sources' | 'skills' | 'settings' | 'knowledge-processing'

export function App() {
  const controller = createDiscoveryController()
  const [page, setPage] = createSignal<PageId>('chat')
  const [knowledgeResetVersion, setKnowledgeResetVersion] = createSignal(0)
  const [skillsNavigation, setSkillsNavigation] = createSignal<SkillsNavigationRequest>()
  const [artifactBrowserTarget, setArtifactBrowserTarget] = createSignal<ArtifactBrowserTarget>()
  const [navigationError, setNavigationError] = createSignal<string>()
  const foundCount = createMemo(
    () => controller.state().sources.filter((source) => source.discoveryState === 'found').length
  )
  const totalConversations = createMemo(() =>
    controller.state().sources.reduce((total, source) => total + source.conversationCount, 0)
  )
  const navigateTo = (nextPage: PageId): void => {
    setNavigationError(undefined)
    setPage(nextPage)
  }

  const browseFolder = (target: ArtifactBrowserTarget): void => {
    setArtifactBrowserTarget(target)
  }

  const browseDesignDocuments = async (): Promise<void> => {
    try {
      browseFolder({
        folderPath: await window.oyster.folderBrowser.getDesignDocumentsPath(),
        label: 'Oyster 设计文档'
      })
    } catch (error) {
      setNavigationError(error instanceof Error ? error.message : String(error))
    }
  }

  const openDesignDocuments = async (): Promise<void> => {
    try {
      setNavigationError(undefined)
      const folderPath = await window.oyster.folderBrowser.getDesignDocumentsPath()
      await window.oyster.folderBrowser.openFolder(folderPath)
    } catch (error) {
      setNavigationError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand"><span class="brand__mark">O</span><span>Oyster</span></div>
        <nav class="sidebar__navigation" aria-label="主导航">
          <div class="nav-primary">
          <a
            href="#chat"
            data-testid="nav-chat"
            class={`nav-item${page() === 'chat' ? ' nav-item--active' : ''}`}
            onClick={(event) => { event.preventDefault(); navigateTo('chat') }}
          ><Icon name="chat" /><span>对话</span></a>
          <a
            href="#knowledge"
            data-testid="nav-knowledge"
            class={`nav-item${page() === 'knowledge' ? ' nav-item--active' : ''}`}
            onClick={(event) => { event.preventDefault(); navigateTo('knowledge') }}
          ><Icon name="layers" /><span>知识库</span></a>
          <a
            href="#artifacts"
            data-testid="nav-artifacts"
            class={`nav-item${page() === 'artifacts' ? ' nav-item--active' : ''}`}
            onClick={(event) => { event.preventDefault(); navigateTo('artifacts') }}
          ><Icon name="folder" /><span>产物</span></a>
          <a
            href="#sources"
            data-testid="nav-sources"
            class={`nav-item${page() === 'sources' ? ' nav-item--active' : ''}`}
            onClick={(event) => { event.preventDefault(); navigateTo('sources') }}
          ><Icon name="archive" /><span>数据来源</span></a>
          <a
            href="#skills"
            data-testid="nav-skills"
            class={`nav-item${page() === 'skills' ? ' nav-item--active' : ''}`}
            onClick={(event) => { event.preventDefault(); navigateTo('skills') }}
          ><Icon name="skill" /><span>Skills</span></a>
          </div>
          <div class="nav-system">
            <a
              href="#settings"
              data-testid="nav-ai-backends"
              class={`nav-item${page() === 'settings' ? ' nav-item--active' : ''}`}
              onClick={(event) => { event.preventDefault(); navigateTo('settings') }}
            ><Icon name="spark" /><span data-testid="nav-settings">设置</span></a>
            <details class="nav-advanced" open={page() === 'knowledge-processing'}>
              <summary><Icon name="play" /><span>高级功能</span></summary>
              <a
            href="#knowledge-processing"
            data-testid="nav-knowledge-processing"
            class={`nav-item${page() === 'knowledge-processing' ? ' nav-item--active' : ''}`}
            onClick={(event) => { event.preventDefault(); navigateTo('knowledge-processing') }}
          ><Icon name="play" /><span>加工测试</span></a>
            </details>
          </div>
        </nav>
      </aside>

      <main class={`content${page() !== 'sources' ? ' content--wide' : ''}`}>
        <div class="window-drag-region" data-testid="window-drag-region" aria-hidden="true" />
        <div class="content__viewport">
          <Show when={navigationError()}>
            {(message) => <div class="page-error app-navigation-error" role="alert"><Icon name="warning" />{message()}</div>}
          </Show>
          {/* Navigation changes visibility; mounted page state and active invocations remain intact. */}
        <div class="ui-page ui-page--flow" data-testid="page-sources" hidden={page() !== 'sources'}>
          <header class="page-header">
            <div>
              <h1>Agent 数据来源</h1>
              <div class="page-summary">
                <span><strong>{foundCount()}</strong> 个来源</span>
                <span class="page-summary__separator">·</span>
                <span><strong>{totalConversations()}</strong> 个对话</span>
              </div>
            </div>
            <div class="page-header__actions">
              <Button
                variant="primary"
                size="wide"
                icon="refresh"
                onClick={controller.detectAgents}
                disabled={controller.detecting()}
              >
                {controller.detecting() ? '探测中…' : '探测本机 Agent'}
              </Button>
            </div>
          </header>

          <Show when={controller.error()}>
            <div class="page-error"><Icon name="warning" />{controller.error()}</div>
          </Show>

          <section class="source-list" aria-label="Agent 数据来源">
            <For each={controller.state().sources}>{(source) => {
              const activeScan = () => controller.state().scans.find(
                (scan) => scan.sourceId === source.id
                  && (scan.status === 'in_progress' || scan.status === 'queued')
              )
              return (
                <SourceCard
                  source={source}
                  scan={activeScan()}
                  onScan={() => void controller.scanSource(source.id)}
                  onCancel={() => activeScan() && void controller.cancelScan(activeScan()!.scanId)}
                  onChooseRoot={() => void controller.chooseSourceRoot(source.id)}
                />
              )
            }}</For>
          </section>
        </div>
        <div class="ui-page ui-page--workspace" data-testid="page-skills" hidden={page() !== 'skills'}>
          <SkillsPage navigationRequest={skillsNavigation()} />
        </div>
        <div class="ui-page ui-page--workspace knowledge-page" data-testid="page-knowledge" hidden={page() !== 'knowledge'}>
          <KnowledgeBrowserPage
            active={page() === 'knowledge'}
            onKnowledgeCleared={() => setKnowledgeResetVersion((version) => version + 1)}
          />
        </div>
        <div class="ui-page ui-page--workspace" data-testid="page-artifacts" hidden={page() !== 'artifacts'}>
          <ArtifactsPage
            browserTarget={artifactBrowserTarget()}
            onBrowseDesignDocuments={() => void browseDesignDocuments()}
            onOpenDesignDocuments={openDesignDocuments}
            onBrowseArtifact={(artifact) => browseFolder({
              folderPath: artifact.directoryPath,
              label: artifact.directoryName
            })}
            onCloseBrowser={() => setArtifactBrowserTarget(undefined)}
            onManageSkill={(artifactDirectoryName) => {
              setSkillsNavigation((current) => ({
                artifactDirectoryName,
                version: (current?.version ?? 0) + 1
              }))
              navigateTo('skills')
            }}
          />
        </div>
        <div class="ui-page ui-page--workspace" data-testid="page-chat" hidden={page() !== 'chat'}>
          <ChatPage />
        </div>
        <div class="ui-page ui-page--flow" data-testid="page-knowledge-processing" hidden={page() !== 'knowledge-processing'}>
          <KnowledgeProcessingPage knowledgeResetVersion={knowledgeResetVersion()} />
        </div>
        <div class="ui-page ui-page--workspace" data-testid="page-settings" hidden={page() !== 'settings'}>
          <SettingsPage />
        </div>
        </div>
      </main>
    </div>
  )
}

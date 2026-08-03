import { For, Show, createMemo, createSignal } from 'solid-js'
import { createDiscoveryController } from './discovery-controller'
import { AiBackendsPage } from './components/AiBackendsPage'
import { AgentConfigurationPage } from './components/AgentConfigurationPage'
import { ChatPage } from './components/ChatPage'
import { ArtifactsPage } from './components/ArtifactsPage'
import { KnowledgeProcessingPage } from './components/KnowledgeProcessingPage'
import { KnowledgeBrowserPage } from './components/KnowledgeBrowserPage'
import { SkillsPage, type SkillsNavigationRequest } from './components/SkillsPage'
import { SourceCard } from './components/SourceCard'
import { Button, Icon } from './ui'

type PageId = 'sources' | 'skills' | 'knowledge' | 'artifacts' | 'chat' | 'knowledge-processing' | 'agent-configuration' | 'ai-backends'

export function App() {
  const controller = createDiscoveryController()
  const [page, setPage] = createSignal<PageId>('sources')
  const [knowledgeResetVersion, setKnowledgeResetVersion] = createSignal(0)
  const [knowledgeNavigation, setKnowledgeNavigation] = createSignal<{ title: string; version: number }>()
  const [skillsNavigation, setSkillsNavigation] = createSignal<SkillsNavigationRequest>()
  const foundCount = createMemo(
    () => controller.snapshot().sources.filter((source) => source.discoveryState === 'found').length
  )
  const totalSessions = createMemo(() =>
    controller.snapshot().sources.reduce((total, source) => total + source.sessionCount, 0)
  )
  const navigateTo = (nextPage: PageId): void => {
    setPage(nextPage)
    requestAnimationFrame(() => window.scrollTo({ top: 0, left: 0 }))
  }

  return (
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand"><span class="brand__mark">O</span><span>Oyster</span></div>
        <nav aria-label="主导航">
          <a
            href="#sources"
            class={`nav-item${page() === 'sources' ? ' nav-item--active' : ''}`}
            onClick={(event) => { event.preventDefault(); navigateTo('sources') }}
          ><Icon name="archive" /><span>数据来源</span></a>
          <a
            href="#skills"
            data-testid="nav-skills"
            class={`nav-item${page() === 'skills' ? ' nav-item--active' : ''}`}
            onClick={(event) => { event.preventDefault(); navigateTo('skills') }}
          ><Icon name="skill" /><span>Skills</span></a>
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
          ><Icon name="folder" /><span>协作产物</span></a>
          <a
            href="#chat"
            data-testid="nav-chat"
            class={`nav-item${page() === 'chat' ? ' nav-item--active' : ''}`}
            onClick={(event) => { event.preventDefault(); navigateTo('chat') }}
          ><Icon name="chat" /><span>对话</span></a>
          <a
            href="#knowledge-processing"
            data-testid="nav-knowledge-processing"
            class={`nav-item${page() === 'knowledge-processing' ? ' nav-item--active' : ''}`}
            onClick={(event) => { event.preventDefault(); navigateTo('knowledge-processing') }}
          ><Icon name="play" /><span>加工测试</span></a>
          <a
            href="#agent-configuration"
            data-testid="nav-agent-configuration"
            class={`nav-item${page() === 'agent-configuration' ? ' nav-item--active' : ''}`}
            onClick={(event) => { event.preventDefault(); navigateTo('agent-configuration') }}
          ><Icon name="agent" /><span>Agent 配置</span></a>
          <a
            href="#ai-backends"
            data-testid="nav-ai-backends"
            class={`nav-item${page() === 'ai-backends' ? ' nav-item--active' : ''}`}
            onClick={(event) => { event.preventDefault(); navigateTo('ai-backends') }}
          ><Icon name="spark" /><span>AI 后端</span></a>
        </nav>
      </aside>

      <main class={`content${page() === 'skills' || page() === 'knowledge-processing' || page() === 'knowledge' || page() === 'chat' || page() === 'agent-configuration' ? ' content--wide' : ''}`}>
        <div class="window-drag-region" data-testid="window-drag-region" aria-hidden="true" />
        {/* Navigation changes visibility; mounted page state and active runs remain intact. */}
        <div data-testid="page-sources" hidden={page() !== 'sources'}>
          <header class="page-header">
            <div>
              <h1>Agent 数据来源</h1>
              <div class="page-summary">
                <span><strong>{foundCount()}</strong> 个来源</span>
                <span class="page-summary__separator">·</span>
                <span><strong>{totalSessions()}</strong> 个会话</span>
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
            <For each={controller.snapshot().sources}>{(source) => {
              const activeRun = () => controller.snapshot().runs.find(
                (run) => run.sourceId === source.id && (run.state === 'running' || run.state === 'queued')
              )
              return (
                <SourceCard
                  source={source}
                  run={activeRun()}
                  onScan={() => void controller.scanSource(source.id)}
                  onCancel={() => activeRun() && void controller.cancelRun(activeRun()!.id)}
                  onChooseRoot={() => void controller.chooseSourceRoot(source.id)}
                />
              )
            }}</For>
          </section>
        </div>
        <div data-testid="page-skills" hidden={page() !== 'skills'}>
          <SkillsPage navigationRequest={skillsNavigation()} />
        </div>
        <div data-testid="page-knowledge" hidden={page() !== 'knowledge'}>
          <KnowledgeBrowserPage
            active={page() === 'knowledge'}
            navigationRequest={knowledgeNavigation()}
            onKnowledgeCleared={() => setKnowledgeResetVersion((version) => version + 1)}
          />
        </div>
        <div data-testid="page-artifacts" hidden={page() !== 'artifacts'}>
          <ArtifactsPage onManageSkill={(artifactDirectoryName) => {
            setSkillsNavigation((current) => ({
              artifactDirectoryName,
              version: (current?.version ?? 0) + 1
            }))
            navigateTo('skills')
          }} />
        </div>
        <div data-testid="page-chat" hidden={page() !== 'chat'}>
          <ChatPage onOpenKnowledge={(title) => {
            setKnowledgeNavigation((current) => ({ title, version: (current?.version ?? 0) + 1 }))
            navigateTo('knowledge')
          }} />
        </div>
        <div data-testid="page-knowledge-processing" hidden={page() !== 'knowledge-processing'}>
          <KnowledgeProcessingPage knowledgeResetVersion={knowledgeResetVersion()} />
        </div>
        <div data-testid="page-ai-backends" hidden={page() !== 'ai-backends'}>
          <AiBackendsPage />
        </div>
        <div data-testid="page-agent-configuration" hidden={page() !== 'agent-configuration'}>
          <AgentConfigurationPage />
        </div>
      </main>
    </div>
  )
}

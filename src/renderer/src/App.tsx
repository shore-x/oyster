import { For, Match, Show, Switch, createMemo, createSignal } from 'solid-js'
import { createDiscoveryController } from './discovery-controller'
import { AiBackendsPage } from './components/AiBackendsPage'
import { KnowledgeProcessingPage } from './components/KnowledgeProcessingPage'
import { SourceCard } from './components/SourceCard'
import { Button, Icon } from './ui'

export function App() {
  const controller = createDiscoveryController()
  const [page, setPage] = createSignal<'sources' | 'knowledge-processing' | 'ai-backends'>('sources')
  const foundCount = createMemo(
    () => controller.snapshot().sources.filter((source) => source.discoveryState === 'found').length
  )
  const totalSessions = createMemo(() =>
    controller.snapshot().sources.reduce((total, source) => total + source.sessionCount, 0)
  )

  return (
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand"><span class="brand__mark">O</span><span>Oyster</span></div>
        <nav aria-label="主导航">
          <a
            href="#sources"
            class={`nav-item${page() === 'sources' ? ' nav-item--active' : ''}`}
            onClick={(event) => { event.preventDefault(); setPage('sources') }}
          ><Icon name="archive" /><span>数据来源</span></a>
          <a
            href="#knowledge-processing"
            data-testid="nav-knowledge-processing"
            class={`nav-item${page() === 'knowledge-processing' ? ' nav-item--active' : ''}`}
            onClick={(event) => { event.preventDefault(); setPage('knowledge-processing') }}
          ><Icon name="layers" /><span>知识加工</span></a>
          <a
            href="#ai-backends"
            data-testid="nav-ai-backends"
            class={`nav-item${page() === 'ai-backends' ? ' nav-item--active' : ''}`}
            onClick={(event) => { event.preventDefault(); setPage('ai-backends') }}
          ><Icon name="spark" /><span>AI 后端</span></a>
        </nav>
      </aside>

      <main class={`content${page() === 'knowledge-processing' ? ' content--wide' : ''}`}>
        <div class="window-drag-region" data-testid="window-drag-region" aria-hidden="true" />
        <Switch>
          <Match when={page() === 'sources'}>
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
          </Match>
          <Match when={page() === 'knowledge-processing'}>
            <KnowledgeProcessingPage />
          </Match>
          <Match when={page() === 'ai-backends'}>
            <AiBackendsPage />
          </Match>
        </Switch>
      </main>
    </div>
  )
}

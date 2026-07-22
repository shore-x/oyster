import { For, Show, createMemo } from 'solid-js'
import { createDiscoveryController } from './discovery-controller'
import { SourceCard } from './components/SourceCard'
import { Button, Icon } from './ui'

export function App() {
  const controller = createDiscoveryController()
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
          <div class="nav-item nav-item--active"><Icon name="archive" /><span>数据来源</span></div>
        </nav>
      </aside>

      <main class="content">
        <div class="window-drag-region" data-testid="window-drag-region" aria-hidden="true" />
        <header class="page-header">
          <div>
            <h1>Agent 数据来源</h1>
            <div class="page-summary">
              <span><strong>{foundCount()}</strong> 个来源</span>
              <span class="page-summary__separator">·</span>
              <span><strong>{totalSessions()}</strong> 个会话</span>
            </div>
          </div>
          <Button
            variant="primary"
            size="wide"
            icon="refresh"
            onClick={controller.detectAgents}
            disabled={controller.detecting()}
          >
            {controller.detecting() ? '探测中…' : '探测本机 Agent'}
          </Button>
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
                onImport={() => void controller.importSource(source.id)}
                onCancel={() => activeRun() && void controller.cancelRun(activeRun()!.id)}
                onChooseRoot={() => void controller.chooseSourceRoot(source.id)}
              />
            )
          }}</For>
        </section>
      </main>
    </div>
  )
}

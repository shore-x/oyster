import { For, Show, createMemo } from 'solid-js'
import { createDiscoveryController } from './discovery-controller'
import { Icon } from './components/Icon'
import { SourceCard } from './components/SourceCard'

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
        <div class="sidebar__footer">Local knowledge hub</div>
      </aside>

      <main class="content">
        <div class="window-drag-region" data-testid="window-drag-region" aria-hidden="true" />
        <header class="page-header">
          <div>
            <div class="eyebrow">KNOWLEDGE SOURCES</div>
            <h1>Agent 数据来源</h1>
            <p>发现本机 Agent，扫描历史记录并导入到本地知识库。</p>
          </div>
          <button class="button button--primary button--detect" onClick={controller.detectAgents} disabled={controller.detecting()}>
            <Icon name="refresh" />{controller.detecting() ? '探测中…' : '探测本机 Agent'}
          </button>
        </header>

        <div class="summary-line">
          <span><strong>{foundCount()}</strong> 个来源已发现</span>
          <span class="summary-line__divider" />
          <span><strong>{totalSessions()}</strong> 个历史会话</span>
          <span class="summary-line__note">数据仅保存在本机</span>
        </div>

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

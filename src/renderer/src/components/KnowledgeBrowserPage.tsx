import { Show, createEffect, createSignal, onCleanup } from 'solid-js'
import { createKnowledgeController } from '../knowledge-controller'
import { Button, Icon } from '../ui'
import { KnowledgeStatementBrowser } from './KnowledgeStatementBrowser'

export function KnowledgeBrowserPage(props: { active: boolean; onKnowledgeCleared(): void }) {
  const controller = createKnowledgeController()
  const [query, setQuery] = createSignal('')
  const [clearDialogOpen, setClearDialogOpen] = createSignal(false)

  createEffect(() => {
    const value = query()
    if (!props.active) return
    const timer = setTimeout(() => void controller.browse(value), 180)
    onCleanup(() => clearTimeout(timer))
  })

  async function confirmClear(): Promise<void> {
    if (await controller.clear()) {
      setClearDialogOpen(false)
      props.onKnowledgeCleared()
    }
  }

  return (
    <>
      <header class="page-header">
        <div>
          <h1>知识库</h1>
          <div class="page-summary">
            <span><strong>{controller.result().total}</strong> 条知识</span>
            <span class="page-summary__separator">·</span>
            <span>当前持久知识</span>
          </div>
        </div>
        <div class="page-header__actions">
          <Button
            variant="danger"
            icon="trash"
            data-testid="clear-knowledge"
            disabled={controller.clearing() || controller.result().total === 0}
            onClick={() => setClearDialogOpen(true)}
          >{controller.clearing() ? '正在清空…' : '清空知识'}</Button>
        </div>
      </header>

      <Show when={controller.error()}>
        <div class="page-error"><Icon name="warning" />{controller.error()}</div>
      </Show>
      <Show when={controller.clearResult()}>
        {(result) => (
          <div class="knowledge-browser__notice" role="status" data-testid="clear-knowledge-result">
            已清空 {result().deletedStatementCount} 条知识。
          </div>
        )}
      </Show>

      <section class="knowledge-browser" aria-label="当前知识库">
        <div class="knowledge-browser__toolbar">
          <label>
            <Icon name="search" />
            <input
              type="search"
              value={query()}
              data-testid="knowledge-search"
              placeholder="搜索标题或正文"
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
          <span>{controller.loading() ? '正在读取…' : `${controller.result().total} 条结果`}</span>
        </div>

        <KnowledgeStatementBrowser
          items={controller.result().statements}
          total={controller.result().total}
          selectedTitle={controller.selectedTitle()}
          selectedStatement={controller.statement()}
          emptyListText={controller.loading()
            ? '正在读取知识…'
            : query().trim()
              ? '没有匹配的知识。'
              : '知识库目前为空。知识写入后会显示在这里。'}
          navigationKey={query()}
          loadingMore={controller.loadingMore()}
          hasMore={controller.result().nextOffset !== undefined}
          onSelect={(title) => controller.select(title)}
          onRead={(title) => window.oyster.knowledge.read(title)}
          onLoadMore={() => void controller.browse(query(), true)}
        />
      </section>

      <Show when={clearDialogOpen()}>
        <div
          class="confirmation-dialog-backdrop"
          data-testid="clear-knowledge-dialog"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget && !controller.clearing()) setClearDialogOpen(false)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !controller.clearing()) setClearDialogOpen(false)
          }}
        >
          <section
            class="confirmation-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="clear-knowledge-dialog-title"
            aria-describedby="clear-knowledge-dialog-description"
          >
            <div class="confirmation-dialog__body">
              <h2 id="clear-knowledge-dialog-title">清空知识？</h2>
              <p id="clear-knowledge-dialog-description">
                将删除知识库中的全部知识。此操作无法撤销。
              </p>
            </div>
            <div class="confirmation-dialog__actions">
              <Button
                variant="secondary"
                icon="stop"
                data-testid="cancel-clear-knowledge"
                disabled={controller.clearing()}
                autofocus
                onClick={() => setClearDialogOpen(false)}
              >取消</Button>
              <Button
                variant="danger"
                icon="trash"
                data-testid="confirm-clear-knowledge"
                disabled={controller.clearing()}
                onClick={() => void confirmClear()}
              >{controller.clearing() ? '正在清空…' : '清空知识'}</Button>
            </div>
          </section>
        </div>
      </Show>
    </>
  )
}

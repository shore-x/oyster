import { Show, createEffect, createSignal, onCleanup } from 'solid-js'
import { createKnowledgeController } from '../knowledge-controller'
import { Button, Icon } from '../ui'
import { KnowledgeStatementBrowser } from './KnowledgeStatementBrowser'
import { uiText } from '../i18n'

export function KnowledgeBrowserPage(props: {
  active: boolean
  navigationRequest?: { title: string; version: number }
  onKnowledgeCleared(): void
}) {
  const controller = createKnowledgeController()
  const [query, setQuery] = createSignal('')
  const [clearDialogOpen, setClearDialogOpen] = createSignal(false)

  let handledNavigationVersion = 0
  createEffect(() => {
    const request = props.navigationRequest
    if (!props.active || !request || request.version === handledNavigationVersion) return
    handledNavigationVersion = request.version
    setQuery(request.title)
    void controller.select(request.title)
  })

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
          <h1>{uiText('知识库', 'Knowledge')}</h1>
          <div class="page-summary">
            <span><strong>{controller.result().total}</strong> {uiText('条知识', 'Statements')}</span>
            <span class="page-summary__separator">·</span>
            <span>{uiText('当前持久知识', 'Current durable Knowledge')}</span>
          </div>
        </div>
        <div class="page-header__actions">
          <Button
            variant="danger"
            icon="trash"
            data-testid="clear-knowledge"
            disabled={controller.clearing() || controller.result().total === 0}
            onClick={() => setClearDialogOpen(true)}
          >{controller.clearing() ? uiText('正在清空…', 'Clearing…') : uiText('清空知识', 'Clear Knowledge')}</Button>
        </div>
      </header>

      <Show when={controller.error()}>
        <div class="page-error"><Icon name="warning" />{controller.error()}</div>
      </Show>
      <Show when={controller.clearResult()}>
        {(result) => (
          <div class="knowledge-browser__notice" role="status" data-testid="clear-knowledge-result">
            {uiText('已清空', 'Cleared')} {result().deletedStatementCount} {uiText('条知识。', 'Knowledge Statements.')}
          </div>
        )}
      </Show>

      <section class="knowledge-browser" aria-label={uiText('当前知识库', 'Current Knowledge')}>
        <div class="knowledge-browser__toolbar">
          <label>
            <Icon name="search" />
            <input
              type="search"
              value={query()}
              data-testid="knowledge-search"
              placeholder={uiText('搜索标题或正文', 'Search titles or content')}
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
          <span>{controller.loading()
            ? uiText('正在读取…', 'Reading…')
            : `${controller.result().total} ${uiText('条结果', 'results')}`}</span>
        </div>

        <KnowledgeStatementBrowser
          items={controller.result().statements}
          total={controller.result().total}
          selectedTitle={controller.selectedTitle()}
          selectedStatement={controller.statement()}
          neighborhood={controller.neighborhood()}
          emptyListText={controller.loading()
            ? uiText('正在读取知识…', 'Reading Knowledge…')
            : query().trim()
              ? uiText('没有匹配的知识。', 'No matching Knowledge found.')
              : uiText('知识库目前为空。知识写入后会显示在这里。', 'The Knowledge Store is empty. Knowledge will appear here after it is written.')}
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
              <h2 id="clear-knowledge-dialog-title">{uiText('清空知识？', 'Clear Knowledge?')}</h2>
              <p id="clear-knowledge-dialog-description">
                {uiText(
                  '将删除知识库中的全部知识。此操作无法撤销。',
                  'This deletes all Knowledge from the Knowledge Store. This action cannot be undone.'
                )}
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
              >{uiText('取消', 'Cancel')}</Button>
              <Button
                variant="danger"
                icon="trash"
                data-testid="confirm-clear-knowledge"
                disabled={controller.clearing()}
                onClick={() => void confirmClear()}
              >{controller.clearing() ? uiText('正在清空…', 'Clearing…') : uiText('清空知识', 'Clear Knowledge')}</Button>
            </div>
          </section>
        </div>
      </Show>
    </>
  )
}

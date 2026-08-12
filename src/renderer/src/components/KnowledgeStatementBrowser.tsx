import {
  For,
  Show,
  createEffect,
  createSignal,
  createUniqueId,
  onCleanup,
  onMount,
  untrack
} from 'solid-js'
import { Portal } from 'solid-js/web'
import type {
  KnowledgeNeighborhoodProjection,
  KnowledgeStatement,
  KnowledgeStatementSummary
} from '../../../shared/knowledge'
import { knowledgeStatementExcerpt } from '../../../shared/knowledge-reference'
import {
  KnowledgeExplorerNavigation,
  type KnowledgeExplorerNavigationSnapshot
} from '../knowledge-explorer-navigation'
import { Button, Markdown } from '../ui'
import { KnowledgeReferenceExplorer } from './KnowledgeReferenceExplorer'
import { uiText } from '../i18n'

interface StatementPreviewState {
  status: 'loading' | 'ready' | 'missing' | 'failed'
  statement?: KnowledgeStatement
}

interface StatementPreviewOverlay {
  target: string
  left: number
  width: number
  top?: number
  bottom?: number
}

const PREVIEW_MAX_WIDTH = 310
const PREVIEW_EDGE_GAP = 12
const PREVIEW_ESTIMATED_HEIGHT = 170

export interface KnowledgeStatementBrowserProps {
  items: KnowledgeStatementSummary[]
  total: number
  selectedTitle?: string
  selectedStatement?: KnowledgeStatement
  neighborhood?: KnowledgeNeighborhoodProjection
  listLabel?: string
  emptyListText: string
  navigationKey?: string
  loadingMore?: boolean
  hasMore?: boolean
  onSelect(title: string): void | Promise<void>
  onRead(title: string): Promise<KnowledgeStatement | undefined>
  onLoadMore?(): void
}

export function statementPreview(content: string, limit = 220): string {
  return knowledgeStatementExcerpt(content, limit)
}

export function KnowledgeStatementBrowser(props: KnowledgeStatementBrowserProps) {
  const previewId = `knowledge-statement-preview-${createUniqueId()}`
  const navigation = new KnowledgeExplorerNavigation(props.selectedTitle)
  const [navigationState, setNavigationState] = createSignal<KnowledgeExplorerNavigationSnapshot>(navigation.snapshot())
  const [previews, setPreviews] = createSignal<Record<string, StatementPreviewState>>({})
  const [previewOverlay, setPreviewOverlay] = createSignal<StatementPreviewOverlay>()
  const previewLoads = new Map<string, Promise<KnowledgeStatement | undefined>>()
  let previousNavigationKey: string | undefined

  createEffect(() => {
    const navigationKey = props.navigationKey
    const selectedTitle = props.selectedTitle
    const currentTitle = untrack(() => navigationState().currentTitle)
    if (navigationKey !== previousNavigationKey) {
      previousNavigationKey = navigationKey
      previewLoads.clear()
      setPreviews({})
      setNavigationState(navigation.reset(selectedTitle))
      return
    }
    if (selectedTitle !== currentTitle) {
      setNavigationState(navigation.reset(selectedTitle))
    }
  })

  onMount(() => {
    const dismissPreview = () => setPreviewOverlay(undefined)
    window.addEventListener('resize', dismissPreview)
    window.addEventListener('scroll', dismissPreview, true)
    window.addEventListener('blur', dismissPreview)
    document.addEventListener('pointerdown', dismissPreview)
    document.addEventListener('visibilitychange', dismissPreview)
    onCleanup(() => {
      window.removeEventListener('resize', dismissPreview)
      window.removeEventListener('scroll', dismissPreview, true)
      window.removeEventListener('blur', dismissPreview)
      document.removeEventListener('pointerdown', dismissPreview)
      document.removeEventListener('visibilitychange', dismissPreview)
    })
  })

  function showPreview(title: string, anchor: HTMLElement): void {
    const bounds = anchor.getBoundingClientRect()
    const width = Math.min(PREVIEW_MAX_WIDTH, window.innerWidth - PREVIEW_EDGE_GAP * 2)
    const left = Math.max(
      PREVIEW_EDGE_GAP,
      Math.min(bounds.left - PREVIEW_EDGE_GAP, window.innerWidth - width - PREVIEW_EDGE_GAP)
    )
    const placeAbove = bounds.bottom + PREVIEW_ESTIMATED_HEIGHT > window.innerHeight
      && bounds.top > PREVIEW_ESTIMATED_HEIGHT
    setPreviewOverlay({
      target: title,
      left,
      width,
      top: placeAbove ? undefined : bounds.bottom + 8,
      bottom: placeAbove ? window.innerHeight - bounds.top + 8 : undefined
    })
    void loadPreview(title)
  }

  function previewOverlayStyle(overlay: StatementPreviewOverlay): string {
    return [
      `left:${overlay.left}px`,
      `width:${overlay.width}px`,
      overlay.top === undefined ? undefined : `top:${overlay.top}px`,
      overlay.bottom === undefined ? undefined : `bottom:${overlay.bottom}px`
    ].filter(Boolean).join(';')
  }

  function navigate(title: string): void {
    setPreviewOverlay(undefined)
    if (navigationState().currentTitle === title) return
    setNavigationState(navigation.navigate(title))
    void props.onSelect(title)
  }

  function moveHistory(offset: -1 | 1): void {
    const next = navigation.move(offset)
    const title = next.currentTitle
    if (!title) return
    setPreviewOverlay(undefined)
    setNavigationState(next)
    void props.onSelect(title)
  }

  function hoverGraphNode(title?: string): void {
    setNavigationState(navigation.hover(title))
  }

  async function loadPreview(title: string): Promise<KnowledgeStatement | undefined> {
    const existing = previews()[title]
    if (existing?.status === 'ready') return existing.statement
    if (existing?.status === 'missing' || existing?.status === 'failed') return undefined
    if (existing?.status === 'loading') return previewLoads.get(title)
    setPreviews((current) => ({ ...current, [title]: { status: 'loading' } }))
    const load = props.onRead(title)
      .then((statement) => {
        setPreviews((current) => ({
          ...current,
          [title]: statement
            ? { status: 'ready', statement }
            : { status: 'missing' }
        }))
        return statement
      })
      .catch(() => {
        setPreviews((current) => ({ ...current, [title]: { status: 'failed' } }))
        return undefined
      })
      .finally(() => previewLoads.delete(title))
    previewLoads.set(title, load)
    return load
  }

  async function followLink(title: string): Promise<void> {
    const statement = await loadPreview(title)
    if (statement) navigate(title)
  }

  function previewCopy(title: string): string {
    const preview = previews()[title]
    if (!preview || preview.status === 'loading') return uiText('正在读取简介…', 'Reading preview…')
    if (preview.status === 'missing') return uiText('当前知识空间中没有找到这个 Statement。', 'This Statement was not found in the current Knowledge space.')
    if (preview.status === 'failed') return uiText('暂时无法读取这个 Statement。', 'This Statement cannot be read right now.')
    return statementPreview(preview.statement?.content || '') || uiText('这个 Statement 暂无正文。', 'This Statement has no content yet.')
  }

  return (
    <div class="knowledge-browser__body" data-testid="knowledge-statement-browser">
      <aside class="knowledge-browser__list" aria-label="Knowledge Statements">
        <div class="knowledge-browser__list-heading">
          <span>{props.listLabel || 'Statements'}</span>
          <strong>{props.total}</strong>
        </div>
        <div
          class="knowledge-browser__list-scroll"
          data-testid="knowledge-statement-list-scroll"
        >
          <Show
            when={props.items.length}
            fallback={<div class="knowledge-browser__empty-list">{props.emptyListText}</div>}
          >
            <For each={props.items}>{(item) => (
              <button
                type="button"
                class="knowledge-browser__item"
                aria-selected={props.selectedTitle === item.title}
                onClick={() => navigate(item.title)}
              >
                <strong>{item.title}</strong>
                <span>{statementPreview(item.preview, 150)}</span>
              </button>
            )}</For>
            <Show when={props.hasMore}>
              <button
                type="button"
                class="knowledge-browser__more"
                disabled={props.loadingMore}
                onClick={props.onLoadMore}
              >{props.loadingMore ? uiText('正在加载…', 'Loading…') : uiText('加载更多', 'Load More')}</button>
            </Show>
          </Show>
        </div>
      </aside>

      <div
        class="knowledge-browser__detail"
        data-testid="knowledge-statement-detail-scroll"
      >
        <Show
          when={props.selectedStatement}
          fallback={<div class="knowledge-browser__empty-detail">{uiText('选择一条知识查看完整内容。', 'Select a Knowledge Statement to view its full content.')}</div>}
        >
          {(statement) => (
            <>
              <div class="knowledge-browser__navigation" aria-label={uiText('Statement 浏览历史', 'Statement navigation history')}>
                <div>
                  <Button
                    variant="ghost"
                    icon="back"
                    data-testid="statement-nav-back"
                    aria-label={uiText('后退到上一个 Statement', 'Go back to the previous Statement')}
                    title={uiText('后退', 'Back')}
                    disabled={navigationState().historyIndex <= 0}
                    onClick={() => moveHistory(-1)}
                  >{uiText('后退', 'Back')}</Button>
                  <Button
                    variant="ghost"
                    icon="forward"
                    data-testid="statement-nav-forward"
                    aria-label={uiText('前进到下一个 Statement', 'Go forward to the next Statement')}
                    title={uiText('前进', 'Forward')}
                    disabled={navigationState().historyIndex < 0 || navigationState().historyIndex >= navigationState().history.length - 1}
                    onClick={() => moveHistory(1)}
                  >{uiText('前进', 'Forward')}</Button>
                </div>
                <span>{navigationState().historyIndex >= 0 ? `${navigationState().historyIndex + 1} / ${navigationState().history.length}` : ''}</span>
              </div>
              <Show when={props.neighborhood}>
                {(projection) => (
                  <KnowledgeReferenceExplorer
                    projection={projection()}
                    hoveredTitle={navigationState().hoveredTitle}
                    onSelect={navigate}
                    onHover={hoverGraphNode}
                  />
                )}
              </Show>
              <article data-testid="knowledge-statement-detail">
                <h2>{statement().title}</h2>
                <Markdown
                  class="knowledge-browser__content"
                  text={statement().content}
                  onOpenKnowledge={(title) => void followLink(title)}
                  onPreviewKnowledge={(title, anchor) => {
                    if (title && anchor) showPreview(title, anchor)
                    else setPreviewOverlay(undefined)
                  }}
                />
              </article>
            </>
          )}
        </Show>
      </div>
      <Portal>
        <Show when={previewOverlay()}>
          {(overlay) => (
            <div
              id={previewId}
              class="knowledge-statement-preview"
              role="tooltip"
              style={previewOverlayStyle(overlay())}
            >
              <strong>{overlay().target}</strong>
              <span>{previewCopy(overlay().target)}</span>
            </div>
          )}
        </Show>
      </Portal>
    </div>
  )
}

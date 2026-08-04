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
import {
  knowledgeStatementExcerpt,
  parseKnowledgeStatementContent
} from '../../../shared/knowledge-reference'
import {
  KnowledgeExplorerSession,
  type KnowledgeExplorerSessionSnapshot
} from '../knowledge-explorer-session'
import { Button } from '../ui'
import { KnowledgeReferenceExplorer } from './KnowledgeReferenceExplorer'

type StatementContentPart =
  | { kind: 'text'; value: string }
  | { kind: 'link'; target: string; label: string }

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
  onReadNeighborhood?(title: string): Promise<KnowledgeNeighborhoodProjection | undefined>
  onLoadMore?(): void
}

export function statementPreview(content: string, limit = 220): string {
  return knowledgeStatementExcerpt(content, limit)
}

export function parseStatementContent(content: string): StatementContentPart[] {
  return parseKnowledgeStatementContent(content).map((part) => part.kind === 'text'
    ? part
    : { kind: 'link', target: part.targetTitle, label: part.label })
}

export function KnowledgeStatementBrowser(props: KnowledgeStatementBrowserProps) {
  const previewId = `knowledge-statement-preview-${createUniqueId()}`
  const explorerSession = new KnowledgeExplorerSession(props.selectedTitle)
  const [session, setSession] = createSignal<KnowledgeExplorerSessionSnapshot>(explorerSession.snapshot())
  const [previews, setPreviews] = createSignal<Record<string, StatementPreviewState>>({})
  const [previewOverlay, setPreviewOverlay] = createSignal<StatementPreviewOverlay>()
  const [hoverNeighborhood, setHoverNeighborhood] = createSignal<KnowledgeNeighborhoodProjection>()
  const [hoverNeighborhoodLoading, setHoverNeighborhoodLoading] = createSignal(false)
  const previewLoads = new Map<string, Promise<KnowledgeStatement | undefined>>()
  const neighborhoodCache = new Map<string, KnowledgeNeighborhoodProjection>()
  let hoverGeneration = 0
  let previousNavigationKey: string | undefined

  createEffect(() => {
    const navigationKey = props.navigationKey
    const selectedTitle = props.selectedTitle
    const currentTitle = untrack(() => session().currentTitle)
    if (navigationKey !== previousNavigationKey) {
      previousNavigationKey = navigationKey
      previewLoads.clear()
      neighborhoodCache.clear()
      setPreviews({})
      setHoverNeighborhood(undefined)
      setSession(explorerSession.reset(selectedTitle))
      return
    }
    if (selectedTitle !== currentTitle) {
      setHoverNeighborhood(undefined)
      setSession(explorerSession.reset(selectedTitle))
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

  function showPreview(title: string, anchor: HTMLAnchorElement): void {
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
    if (session().currentTitle === title) return
    setHoverNeighborhood(undefined)
    setSession(explorerSession.navigate(title))
    void props.onSelect(title)
  }

  function moveHistory(offset: -1 | 1): void {
    const next = explorerSession.move(offset)
    const title = next.currentTitle
    if (!title) return
    setPreviewOverlay(undefined)
    setHoverNeighborhood(undefined)
    setSession(next)
    void props.onSelect(title)
  }

  async function hoverGraphNode(title?: string): Promise<void> {
    const generation = ++hoverGeneration
    setSession(explorerSession.hover(title))
    if (!title) {
      setHoverNeighborhood(undefined)
      setHoverNeighborhoodLoading(false)
      return
    }
    if (title === props.neighborhood?.centerTitle) {
      setHoverNeighborhood(props.neighborhood)
      setHoverNeighborhoodLoading(false)
      return
    }
    const cached = neighborhoodCache.get(title)
    if (cached) {
      setHoverNeighborhood(cached)
      setHoverNeighborhoodLoading(false)
      return
    }
    if (!props.onReadNeighborhood) return
    setHoverNeighborhood(undefined)
    setHoverNeighborhoodLoading(true)
    try {
      const projection = await props.onReadNeighborhood(title)
      if (projection) neighborhoodCache.set(title, projection)
      if (generation === hoverGeneration && session().hoveredTitle === title) {
        setHoverNeighborhood(projection)
      }
    } catch {
      if (generation === hoverGeneration) setHoverNeighborhood(undefined)
    } finally {
      if (generation === hoverGeneration) setHoverNeighborhoodLoading(false)
    }
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
    if (!preview || preview.status === 'loading') return '正在读取简介…'
    if (preview.status === 'missing') return '当前知识空间中没有找到这个 Statement。'
    if (preview.status === 'failed') return '暂时无法读取这个 Statement。'
    return statementPreview(preview.statement?.content || '') || '这个 Statement 暂无正文。'
  }

  return (
    <div class="knowledge-browser__body" data-testid="knowledge-statement-browser">
      <aside class="knowledge-browser__list" aria-label="Knowledge Statements">
        <div class="knowledge-browser__list-heading">
          <span>{props.listLabel || 'Statements'}</span>
          <strong>{props.total}</strong>
        </div>
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
            >{props.loadingMore ? '正在加载…' : '加载更多'}</button>
          </Show>
        </Show>
      </aside>

      <div class="knowledge-browser__detail">
        <Show
          when={props.selectedStatement}
          fallback={<div class="knowledge-browser__empty-detail">选择一条知识查看完整内容。</div>}
        >
          {(statement) => (
            <>
              <div class="knowledge-browser__navigation" aria-label="Statement 浏览历史">
                <div>
                  <Button
                    variant="ghost"
                    icon="back"
                    data-testid="statement-nav-back"
                    aria-label="后退到上一个 Statement"
                    title="后退"
                    disabled={session().historyIndex <= 0}
                    onClick={() => moveHistory(-1)}
                  >后退</Button>
                  <Button
                    variant="ghost"
                    icon="forward"
                    data-testid="statement-nav-forward"
                    aria-label="前进到下一个 Statement"
                    title="前进"
                    disabled={session().historyIndex < 0 || session().historyIndex >= session().history.length - 1}
                    onClick={() => moveHistory(1)}
                  >前进</Button>
                </div>
                <span>{session().historyIndex >= 0 ? `${session().historyIndex + 1} / ${session().history.length}` : ''}</span>
              </div>
              <Show when={props.neighborhood}>
                {(projection) => (
                  <KnowledgeReferenceExplorer
                    projection={projection()}
                    hoveredTitle={session().hoveredTitle}
                    hoverProjection={hoverNeighborhood()}
                    hoverLoading={hoverNeighborhoodLoading()}
                    onSelect={navigate}
                    onHover={(title) => void hoverGraphNode(title)}
                  />
                )}
              </Show>
              <article data-testid="knowledge-statement-detail">
                <h2>{statement().title}</h2>
                <div class="knowledge-browser__content">
                  <For each={parseStatementContent(statement().content)}>{(part) => (
                    <Show when={part.kind === 'link' ? part : undefined} fallback={part.kind === 'text' ? part.value : ''}>
                      {(link) => (
                        <span class="knowledge-statement-link">
                          <a
                            href={`#statement-${encodeURIComponent(link().target)}`}
                            aria-describedby={previewOverlay()?.target === link().target ? previewId : undefined}
                            onMouseEnter={(event) => showPreview(link().target, event.currentTarget)}
                            onMouseLeave={() => setPreviewOverlay(undefined)}
                            onFocus={(event) => showPreview(link().target, event.currentTarget)}
                            onBlur={() => setPreviewOverlay(undefined)}
                            onClick={(event) => {
                              event.preventDefault()
                              setPreviewOverlay(undefined)
                              void followLink(link().target)
                            }}
                          >{link().label}</a>
                        </span>
                      )}
                    </Show>
                  )}</For>
                </div>
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

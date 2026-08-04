import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import type { KnowledgeNeighborhoodProjection } from '../../../shared/knowledge'
import {
  buildKnowledgeLocalGraphScene,
  type KnowledgeLocalGraphSceneNode
} from '../knowledge-local-graph-scene'

export interface KnowledgeReferenceExplorerProps {
  projection: KnowledgeNeighborhoodProjection
  hoveredTitle?: string
  onSelect(title: string): void
  onHover(title?: string): void
}

function clusterColor(clusterIndex?: number): string {
  return clusterIndex === undefined
    ? 'var(--text-muted)'
    : `var(--graph-cluster-${clusterIndex % 4 + 1})`
}

const PREVIEW_MAX_WIDTH = 228
const PREVIEW_HEIGHT = 82
const PREVIEW_GAP = 10
const PREVIEW_PADDING = 12

export function KnowledgeReferenceExplorer(props: KnowledgeReferenceExplorerProps) {
  const [graphWidth, setGraphWidth] = createSignal(720)
  let graphViewportElement: HTMLDivElement | undefined
  const scene = createMemo(() => buildKnowledgeLocalGraphScene(
    props.projection,
    { width: graphWidth() }
  ))
  const hoveredNode = () => scene().nodes.find((node) => node.title === props.hoveredTitle)
  const isRelatedToHovered = (title: string): boolean => {
    const hovered = hoveredNode()
    return !hovered || hovered.title === title || hovered.neighborTitles.includes(title)
  }
  const nodeClass = (node: KnowledgeLocalGraphSceneNode): string => [
    'knowledge-local-graph__node',
    node.title === props.projection.centerTitle ? 'knowledge-local-graph__node--center' : '',
    node.distance >= 2 ? 'knowledge-local-graph__node--second-hop' : '',
    props.hoveredTitle === node.title ? 'knowledge-local-graph__node--active' : '',
    !isRelatedToHovered(node.title) ? 'knowledge-local-graph__node--dimmed' : ''
  ].filter(Boolean).join(' ')
  const previewPlacement = createMemo(() => {
    const node = hoveredNode()
    if (!node) return undefined
    const currentScene = scene()
    const width = Math.min(PREVIEW_MAX_WIDTH, currentScene.width - PREVIEW_PADDING * 2)
    const leftSpace = node.x - node.width / 2
    const rightSpace = currentScene.width - node.x - node.width / 2
    const topSpace = node.y - node.height / 2
    const bottomSpace = currentScene.height - node.y - node.height / 2
    let left = node.x - width / 2
    let top = node.y - PREVIEW_HEIGHT / 2
    if (rightSpace >= width + PREVIEW_GAP) left = node.x + node.width / 2 + PREVIEW_GAP
    else if (leftSpace >= width + PREVIEW_GAP) left = node.x - node.width / 2 - PREVIEW_GAP - width
    else if (bottomSpace >= PREVIEW_HEIGHT + PREVIEW_GAP) top = node.y + node.height / 2 + PREVIEW_GAP
    else if (topSpace >= PREVIEW_HEIGHT + PREVIEW_GAP) top = node.y - node.height / 2 - PREVIEW_GAP - PREVIEW_HEIGHT
    else top += node.y < currentScene.height / 2 ? node.height : -node.height
    return {
      width,
      left: Math.max(PREVIEW_PADDING, Math.min(currentScene.width - width - PREVIEW_PADDING, left)),
      top: Math.max(PREVIEW_PADDING, Math.min(currentScene.height - PREVIEW_HEIGHT - PREVIEW_PADDING, top))
    }
  })

  onMount(() => {
    const updateWidth = (): void => {
      const width = Math.round(graphViewportElement?.clientWidth ?? 0)
      if (width > 0) setGraphWidth(width)
    }
    updateWidth()
    if (!graphViewportElement || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(updateWidth)
    observer.observe(graphViewportElement)
    onCleanup(() => observer.disconnect())
  })

  return (
    <section class="knowledge-reference-explorer" aria-label="Statement 局部引用图">
      <Show
        when={scene().nodes.length > 1}
        fallback={<p class="knowledge-local-graph__empty">当前 Statement 暂无可解析的相邻引用。</p>}
      >
        <div
          ref={(element) => { graphViewportElement = element }}
          class="knowledge-local-graph__viewport"
          data-scene-height={scene().height}
          onMouseLeave={() => props.onHover(undefined)}
        >
          <div
            class="knowledge-local-graph"
            data-cluster-count={scene().clusterCount}
            style={`height:${scene().height}px`}
          >
            <svg
              class="knowledge-local-graph__edges"
              viewBox={`0 0 ${scene().width} ${scene().height}`}
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <For each={scene().edges}>{(edge) => {
                const active = () => props.hoveredTitle === edge.sourceTitle
                  || props.hoveredTitle === edge.targetTitle
                const firstHop = edge.sourceTitle === props.projection.centerTitle
                  || edge.targetTitle === props.projection.centerTitle
                return (
                  <path
                    class={`knowledge-local-graph__edge ${firstHop
                      ? 'knowledge-local-graph__edge--first-hop'
                      : 'knowledge-local-graph__edge--contextual'} ${active()
                      ? 'knowledge-local-graph__edge--active'
                      : ''}`}
                    d={edge.path}
                    data-source-title={edge.sourceTitle}
                    data-target-title={edge.targetTitle}
                    data-edge-tier={firstHop ? 'first-hop' : 'contextual'}
                    data-curved={edge.curved ? 'true' : 'false'}
                    style={`--knowledge-cluster-color:${clusterColor(edge.clusterIndex)}`}
                  />
                )
              }}</For>
            </svg>

            <For each={scene().nodes}>{(node) => (
              <button
                type="button"
                class={nodeClass(node)}
                data-distance={node.distance}
                data-title={node.title}
                style={`left:${node.x}px;top:${node.y}px;width:${node.width}px;height:${node.height}px;--knowledge-cluster-color:${node.title === props.projection.centerTitle
                  ? 'var(--text-primary)'
                  : clusterColor(node.clusterIndex)}`}
                aria-label={`${node.title}，距中心 ${node.distance} 跳，${node.neighborTitles.length} 个相邻 Statement`}
                aria-current={node.title === props.projection.centerTitle ? 'true' : undefined}
                aria-describedby={props.hoveredTitle === node.title ? 'knowledge-local-graph-preview' : undefined}
                onMouseEnter={() => props.onHover(node.title)}
                onFocusIn={() => props.onHover(node.title)}
                onFocusOut={() => props.onHover(undefined)}
                onClick={() => props.onSelect(node.title)}
              >
                <span class="knowledge-local-graph__label">{node.title}</span>
              </button>
            )}</For>

            <Show when={hoveredNode() && previewPlacement()}>
              <aside
                id="knowledge-local-graph-preview"
                class="knowledge-local-graph__preview"
                role="tooltip"
                aria-live="polite"
                style={`left:${previewPlacement()!.left}px;top:${previewPlacement()!.top}px;width:${previewPlacement()!.width}px`}
              >
                <strong>{hoveredNode()!.title}</strong>
                <p>{hoveredNode()!.excerpt || '这个 Statement 暂无正文摘要。'}</p>
              </aside>
            </Show>
          </div>
        </div>
      </Show>

      <Show when={props.projection.unresolvedReferences.length}>
        <details class="knowledge-reference-explorer__unresolved ui-disclosure">
          <summary>{props.projection.unresolvedReferences.length} 个引用在当前知识视图中没有目标</summary>
          <div class="ui-disclosure__content">
            <ul>
              <For each={props.projection.unresolvedReferences}>{(reference) => (
                <li>
                  <code>{reference.targetTitle}</code>
                  <span>{reference.occurrenceCount > 1 ? `${reference.occurrenceCount} 次` : '1 次'}</span>
                </li>
              )}</For>
            </ul>
          </div>
        </details>
      </Show>
    </section>
  )
}

import { For, Show, createMemo } from 'solid-js'
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

function truncatedTitle(title: string): string {
  return title.length > 24 ? `${title.slice(0, 23)}…` : title
}

function directionalSummary(projection: KnowledgeNeighborhoodProjection, title: string): string {
  const outgoing = [...new Set(projection.edges
    .filter((edge) => edge.sourceTitle === title && edge.targetTitle !== title)
    .map((edge) => edge.targetTitle))]
  const incoming = [...new Set(projection.edges
    .filter((edge) => edge.targetTitle === title && edge.sourceTitle !== title)
    .map((edge) => edge.sourceTitle))]
  const parts: string[] = []
  if (outgoing.length) parts.push(`它引用 ${outgoing.join('、')}`)
  if (incoming.length) parts.push(`${incoming.join('、')} 引用它`)
  return parts.length ? `在当前局部图中，${parts.join('；')}。` : '当前局部图中没有其他直接引用。'
}

export function KnowledgeReferenceExplorer(props: KnowledgeReferenceExplorerProps) {
  const scene = createMemo(() => buildKnowledgeLocalGraphScene(props.projection))
  const hoveredNode = () => scene().nodes.find((node) => node.title === props.hoveredTitle)
  const isRelatedToHovered = (title: string): boolean => {
    const hovered = hoveredNode()
    return !hovered || hovered.title === title || hovered.neighborTitles.includes(title)
  }
  const nodeClass = (node: KnowledgeLocalGraphSceneNode): string => [
    'knowledge-local-graph__node',
    node.title === props.projection.centerTitle ? 'knowledge-local-graph__node--center' : '',
    props.hoveredTitle === node.title ? 'knowledge-local-graph__node--active' : '',
    !isRelatedToHovered(node.title) ? 'knowledge-local-graph__node--dimmed' : ''
  ].filter(Boolean).join(' ')

  return (
    <section class="knowledge-reference-explorer" aria-label="Statement 局部引用图">
      <header class="knowledge-reference-explorer__header">
        <div>
          <span>局部引用图 · {props.projection.depth} 跳</span>
          <h2>{props.projection.centerTitle}</h2>
        </div>
        <p>连线不区分方向；位置和颜色仅根据当前引用结构排列。</p>
      </header>

      <Show
        when={scene().nodes.length > 1}
        fallback={<p class="knowledge-local-graph__empty">当前 Statement 暂无可解析的相邻引用。</p>}
      >
        <div
          class="knowledge-local-graph"
          data-cluster-count={scene().clusterCount}
          style={`height:${scene().height}px`}
          onMouseLeave={() => props.onHover(undefined)}
        >
          <svg
            class="knowledge-local-graph__edges"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <For each={scene().edges}>{(edge) => {
              const active = () => props.hoveredTitle === edge.sourceTitle
                || props.hoveredTitle === edge.targetTitle
              return (
                <line
                  class={`knowledge-local-graph__edge ${props.hoveredTitle && !active()
                    ? 'knowledge-local-graph__edge--dimmed'
                    : active() ? 'knowledge-local-graph__edge--active' : ''}`}
                  x1={edge.sourceX}
                  y1={edge.sourceY}
                  x2={edge.targetX}
                  y2={edge.targetY}
                  style={`--knowledge-cluster-color:${clusterColor(edge.clusterIndex)}`}
                />
              )
            }}</For>
          </svg>

          <For each={scene().nodes}>{(node) => (
            <button
              type="button"
              class={nodeClass(node)}
              style={`left:${node.x}%;top:${node.y}%;--knowledge-cluster-color:${node.title === props.projection.centerTitle
                ? 'var(--text-primary)'
                : clusterColor(node.clusterIndex)}`}
              aria-label={`${node.title}，距中心 ${node.distance} 跳，${node.neighborTitles.length} 个相邻 Statement`}
              aria-current={node.title === props.projection.centerTitle ? 'true' : undefined}
              title={node.title}
              onMouseEnter={() => props.onHover(node.title)}
              onFocus={() => props.onHover(node.title)}
              onBlur={() => props.onHover(undefined)}
              onClick={() => props.onSelect(node.title)}
            >
              <span class="knowledge-local-graph__marker" aria-hidden="true" />
              <span class="knowledge-local-graph__label">{truncatedTitle(node.title)}</span>
            </button>
          )}</For>
        </div>
      </Show>

      <Show when={hoveredNode()}>
        {(node) => (
          <aside class="knowledge-local-graph__preview" aria-live="polite">
            <div>
              <strong>{node().title}</strong>
              <span>{node().distance === 0 ? '当前 Statement' : `距中心 ${node().distance} 跳`} · {node().neighborTitles.length} 个相邻节点</span>
            </div>
            <p>{node().excerpt || '这个 Statement 暂无正文摘要。'}</p>
            <p>{directionalSummary(props.projection, node().title)}</p>
          </aside>
        )}
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

import type {
  Core,
  ElementDefinition,
  EventObject
} from 'cytoscape'
import { For, Show, createEffect, onCleanup, onMount } from 'solid-js'
import type {
  KnowledgeNeighborhoodGroup,
  KnowledgeNeighborhoodProjection,
  KnowledgeNeighborhoodRole
} from '../../../shared/knowledge'

export interface KnowledgeReferenceGraphProps {
  projection: KnowledgeNeighborhoodProjection
  hoveredTitle?: string
  hoverProjection?: KnowledgeNeighborhoodProjection
  hoverLoading?: boolean
  onSelect(title: string): void
  onHover(title?: string): void
}

function group(
  projection: KnowledgeNeighborhoodProjection,
  kind: KnowledgeNeighborhoodRole
): KnowledgeNeighborhoodGroup {
  return projection.groups.find((candidate) => candidate.kind === kind)
    ?? { kind, memberTitles: [] }
}

const COMPACT_LAYOUT_WIDTH = 560
const MINIMUM_READABLE_AUTO_ZOOM = 0.86
const MAXIMUM_AUTO_ZOOM = 1
const MAXIMUM_LABEL_UNITS = 32

export function referenceGraphLabel(title: string): string {
  let units = 0
  let label = ''
  for (const character of title) {
    const characterUnits = /[\u1100-\u115f\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe10-\ufe6f\uff00-\uffef]/u
      .test(character) ? 2 : 1
    if (units + characterUnits > MAXIMUM_LABEL_UNITS - 1) return `${label.trimEnd()}…`
    units += characterUnits
    label += character
  }
  return label
}

export function referenceGraphPositions(
  projection: KnowledgeNeighborhoodProjection,
  viewportWidth = 800
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>()
  const incoming = group(projection, 'incoming').memberTitles
  const outgoing = group(projection, 'outgoing').memberTitles
  const incomingSet = new Set(incoming)
  const outgoingSet = new Set(outgoing)
  const mutual = incoming.filter((title) => outgoingSet.has(title))
  const incomingOnly = incoming.filter((title) => !outgoingSet.has(title))
  const outgoingOnly = outgoing.filter((title) => !incomingSet.has(title))
  const center = { x: 0, y: 0 }

  const placeSector = (titles: string[], centerAngle: number, baseRadius: number): void => {
    let offset = 0
    let ringIndex = 0
    while (offset < titles.length) {
      const capacity = 3 + ringIndex
      const ringTitles = titles.slice(offset, offset + capacity)
      const radius = baseRadius + ringIndex * 78
      const maximumAngle = ringTitles.length === 1
        ? 0
        : ringTitles.length === 2
          ? 0.5
          : Math.min(1.05, 0.58 + ringTitles.length * 0.13)
      ringTitles.forEach((title, index) => {
        const progress = ringTitles.length === 1 ? 0 : index / (ringTitles.length - 1) * 2 - 1
        const angle = centerAngle + progress * maximumAngle
        positions.set(title, {
          x: center.x + Math.cos(angle) * radius,
          y: center.y + Math.sin(angle) * radius
        })
      })
      offset += ringTitles.length
      ringIndex += 1
    }
  }

  if (viewportWidth < COMPACT_LAYOUT_WIDTH) {
    placeSector(incomingOnly, -Math.PI / 2, 170)
    placeSector(outgoingOnly, Math.PI / 2, 170)
    placeSector(mutual, Math.PI, 145)
  } else {
    placeSector(incomingOnly, Math.PI, 185)
    placeSector(outgoingOnly, 0, 185)
    placeSector(mutual, -Math.PI / 2, 145)
  }
  positions.set(projection.centerTitle, center)
  return positions
}

function elementsFor(
  projection: KnowledgeNeighborhoodProjection,
  viewportWidth: number
): ElementDefinition[] {
  const positions = referenceGraphPositions(projection, viewportWidth)
  const nodeIds = new Map<string, string>()
  const nodes: ElementDefinition[] = projection.nodes.map((node, index) => {
    const id = `node-${index}`
    nodeIds.set(node.title, id)
    const classes = node.title === projection.centerTitle
      ? 'center'
      : node.roles.length === 2
        ? 'mutual'
        : node.roles[0] ?? ''
    return {
      group: 'nodes',
      data: { id, title: node.title, label: referenceGraphLabel(node.title) },
      position: positions.get(node.title),
      classes
    }
  })
  const edgePairs = new Set(projection.edges.map((edge) => JSON.stringify([
    edge.sourceTitle,
    edge.targetTitle
  ])))
  const routeIndexes = { incoming: 0, outgoing: 0 }
  const edges: ElementDefinition[] = projection.edges.flatMap((edge, index) => {
    const source = nodeIds.get(edge.sourceTitle)
    const target = nodeIds.get(edge.targetTitle)
    if (!source || !target) return []
    const role = edge.sourceTitle === projection.centerTitle ? 'outgoing' : 'incoming'
    const routeIndex = routeIndexes[role]++
    const hasReverseEdge = edgePairs.has(JSON.stringify([edge.targetTitle, edge.sourceTitle]))
    const alternatingDirection = routeIndex % 2 === 0 ? -1 : 1
    const curveDistance = hasReverseEdge
      ? 30
      : alternatingDirection * Math.min(28, 10 + Math.floor(routeIndex / 2) * 5)
    return [{
      group: 'edges',
      data: {
        id: `edge-${index}`,
        source,
        target,
        occurrenceCount: edge.occurrenceCount,
        curveDistance
      },
      classes: role
    }]
  })
  return [...nodes, ...edges]
}

export function KnowledgeReferenceGraph(props: KnowledgeReferenceGraphProps) {
  let container: HTMLDivElement | undefined
  let graph: Core | undefined
  let resizeObserver: ResizeObserver | undefined
  let currentProjection = props.projection
  let disposed = false

  const fitGraph = (): void => {
    if (!graph) return
    graph.fit(undefined, 34)
    const fittedZoom = graph.zoom()
    const readableZoom = Math.min(
      MAXIMUM_AUTO_ZOOM,
      Math.max(MINIMUM_READABLE_AUTO_ZOOM, fittedZoom)
    )
    if (readableZoom !== fittedZoom) {
      graph.zoom(readableZoom)
    }
    graph.center(graph.nodes('.center'))
  }

  const renderGraph = (): void => {
    if (!graph) return
    graph.startBatch()
    graph.elements().remove()
    graph.add(elementsFor(currentProjection, graph.width()))
    graph.endBatch()
    graph.layout({ name: 'preset', fit: false, animate: false }).run()
    fitGraph()
  }

  const clearHighlight = (): void => {
    graph?.elements().removeClass('is-muted is-active')
  }

  createEffect(() => {
    currentProjection = props.projection
    renderGraph()
  })

  onMount(() => {
    void import('cytoscape').then(({ default: createCytoscape }) => {
      if (disposed || !container) return
      graph = createCytoscape({
        container,
        elements: [],
        minZoom: 0.5,
        maxZoom: 2.2,
        wheelSensitivity: 0.18,
        boxSelectionEnabled: false,
        autoungrabify: true,
        style: [
          {
            selector: 'node',
            style: {
              width: 152,
              height: 54,
              shape: 'ellipse',
              label: 'data(label)',
              'font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
              'font-size': 15,
              'font-weight': 560,
              color: '#3f4b55',
              'text-wrap': 'wrap',
              'text-max-width': '124px',
              'line-height': 1.12,
              'text-valign': 'center',
              'text-halign': 'center',
              'background-color': '#ffffff',
              'border-width': 1,
              'border-color': '#d9dde1',
              'overlay-opacity': 0
            }
          },
          {
            selector: 'node.incoming',
            style: {
              'background-color': '#ffffff',
              'border-color': '#decba9'
            }
          },
          {
            selector: 'node.outgoing',
            style: {
              'background-color': '#ffffff',
              'border-color': '#bfd4df'
            }
          },
          {
            selector: 'node.mutual',
            style: {
              'background-color': '#ffffff',
              'border-color': '#cfc7dc'
            }
          },
          {
            selector: 'node.center',
            style: {
              width: 176,
              height: 62,
              'font-size': 16,
              'font-weight': 660,
              color: '#294e65',
              'background-color': '#ffffff',
              'border-width': 2,
              'border-color': '#8fb5c8'
            }
          },
          {
            selector: 'edge',
            style: {
              width: 1.25,
              'curve-style': 'unbundled-bezier',
              'control-point-distances': 'data(curveDistance)',
              'control-point-weights': 0.5,
              'source-endpoint': 'outside-to-node',
              'target-endpoint': 'outside-to-node',
              'target-arrow-shape': 'triangle',
              'arrow-scale': 0.74,
              'line-color': '#9aa5ad',
              'target-arrow-color': '#9aa5ad',
              'overlay-opacity': 0
            }
          },
          {
            selector: 'edge.incoming',
            style: {
              'line-color': '#b79a69',
              'target-arrow-color': '#b79a69'
            }
          },
          {
            selector: 'edge.outgoing',
            style: {
              'line-color': '#6d9bb2',
              'target-arrow-color': '#6d9bb2'
            }
          },
          {
            selector: '.is-muted',
            style: { opacity: 0.14 }
          },
          {
            selector: '.is-active',
            style: {
              opacity: 1,
              'z-index': 10
            }
          }
        ]
      })

      graph.on('mouseover', 'node', (event: EventObject) => {
        const node = event.target
        const title = node.data('title') as string
        graph?.elements().addClass('is-muted')
        node.addClass('is-active').removeClass('is-muted')
        node.connectedEdges().addClass('is-active').removeClass('is-muted')
        node.connectedEdges().connectedNodes().addClass('is-active').removeClass('is-muted')
        props.onHover(title)
      })
      graph.on('mouseout', 'node', () => {
        clearHighlight()
        props.onHover(undefined)
      })
      graph.on('tap', 'node', (event: EventObject) => {
        const title = event.target.data('title') as string
        if (title !== currentProjection.centerTitle) props.onSelect(title)
      })
      graph.on('tap', (event: EventObject) => {
        if (event.target === graph) props.onHover(undefined)
      })

      resizeObserver = new ResizeObserver(() => {
        graph?.resize()
        renderGraph()
      })
      resizeObserver.observe(container)
      renderGraph()
    })
  })

  onCleanup(() => {
    disposed = true
    resizeObserver?.disconnect()
    graph?.destroy()
  })

  const incoming = () => group(props.projection, 'incoming').memberTitles
  const outgoing = () => group(props.projection, 'outgoing').memberTitles
  const hoverIncoming = () => props.hoverProjection
    ? group(props.hoverProjection, 'incoming').memberTitles
    : []
  const hoverOutgoing = () => props.hoverProjection
    ? group(props.hoverProjection, 'outgoing').memberTitles
    : []

  return (
    <section class="knowledge-reference-graph" aria-label="Statement 直接引用关系">
      <header class="knowledge-reference-graph__header">
        <div>
          <strong>直接引用</strong>
          <span>箭头从引用者指向被引用者</span>
        </div>
        <div class="knowledge-reference-graph__legend" aria-label="引用关系图例">
          <span class="knowledge-reference-graph__legend-item knowledge-reference-graph__legend-item--incoming">
            被引用 {incoming().length}
          </span>
          <span class="knowledge-reference-graph__legend-item knowledge-reference-graph__legend-item--outgoing">
            引用 {outgoing().length}
          </span>
        </div>
      </header>

      <div class="knowledge-reference-graph__canvas-wrap">
        <div ref={container} class="knowledge-reference-graph__canvas" data-testid="knowledge-reference-graph" />
        <Show when={props.projection.edges.length === 0}>
          <div class="knowledge-reference-graph__empty">当前 Statement 没有已解析的直接引用关系。</div>
        </Show>
        <Show when={props.hoveredTitle}>
          {(title) => (
            <aside class="knowledge-reference-graph__hover" aria-live="polite">
              <strong>{title()}</strong>
              <Show
                when={!props.hoverLoading}
                fallback={<span>正在读取相邻 Statement…</span>}
              >
                <div>
                  <span>被引用</span>
                  <p>{hoverIncoming().length ? hoverIncoming().join('、') : '无'}</p>
                </div>
                <div>
                  <span>引用</span>
                  <p>{hoverOutgoing().length ? hoverOutgoing().join('、') : '无'}</p>
                </div>
              </Show>
            </aside>
          )}
        </Show>
      </div>

      <div class="knowledge-reference-graph__lists" aria-label="直接引用关系列表">
        <section>
          <h3>被引用</h3>
          <Show when={incoming().length} fallback={<span>没有 Statement 引用当前内容</span>}>
            <For each={incoming()}>{(title) => (
              <button type="button" onClick={() => props.onSelect(title)}>{title}</button>
            )}</For>
          </Show>
        </section>
        <section>
          <h3>引用</h3>
          <Show when={outgoing().length} fallback={<span>当前内容没有引用其他 Statement</span>}>
            <For each={outgoing()}>{(title) => (
              <button type="button" onClick={() => props.onSelect(title)}>{title}</button>
            )}</For>
          </Show>
        </section>
      </div>

      <Show when={props.projection.unresolvedReferences.length}>
        <p class="knowledge-reference-graph__unresolved">
          {props.projection.unresolvedReferences.length} 个正文引用在当前知识视图中没有目标，未加入关系图。
        </p>
      </Show>
    </section>
  )
}

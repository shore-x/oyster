import { renderToString } from 'solid-js/web'
import { describe, expect, it, vi } from 'vitest'
import type { KnowledgeNeighborhoodProjection } from '../src/shared/knowledge'
import { KnowledgeReferenceExplorer } from '../src/renderer/src/components/KnowledgeReferenceExplorer'

function projection(centerTitle = 'Center'): KnowledgeNeighborhoodProjection {
  return {
    centerTitle,
    depth: 2,
    nodes: [
      { title: centerTitle, excerpt: 'Center body.', distance: 0 },
      { title: 'Incoming', excerpt: 'Incoming body.', distance: 1 },
      { title: 'Outgoing', excerpt: 'Outgoing body.', distance: 1 },
      { title: 'Second hop', excerpt: 'Second-hop body.', distance: 2 }
    ],
    edges: [
      { sourceTitle: 'Incoming', targetTitle: centerTitle, occurrenceCount: 1 },
      { sourceTitle: centerTitle, targetTitle: 'Outgoing', occurrenceCount: 2 },
      { sourceTitle: 'Outgoing', targetTitle: 'Second hop', occurrenceCount: 1 }
    ],
    unresolvedReferences: []
  }
}

describe('KnowledgeReferenceExplorer', () => {
  it('renders a text-led two-hop local graph with adaptive, directionless paths', () => {
    const html = renderToString(() => (
      <KnowledgeReferenceExplorer
        projection={projection()}
        onSelect={vi.fn()}
        onHover={vi.fn()}
      />
    ))

    expect(html).toContain('Second hop')
    expect(html).toContain('knowledge-local-graph__viewport')
    expect(html).toContain('knowledge-local-graph__edge')
    expect(html.match(/knowledge-local-graph__edge--first-hop/g)).toHaveLength(2)
    expect(html.match(/knowledge-local-graph__edge--contextual/g)).toHaveLength(1)
    expect(html.match(/data-edge-tier="first-hop"/g)).toHaveLength(2)
    expect(html.match(/data-edge-tier="contextual"/g)).toHaveLength(1)
    expect(html).not.toContain('knowledge-local-graph__edge--dimmed')
    expect(html).toContain('<path')
    expect(html).toContain('data-curved=')
    expect(html.match(/<button[^>]*knowledge-local-graph__node/g)).toHaveLength(4)
    expect(html.match(/knowledge-local-graph__label/g)).toHaveLength(4)
    expect(html).toContain('data-cluster-count="1"')
    expect(html).toContain('knowledge-local-graph__node--second-hop')
    expect(html).not.toContain('局部引用图 ·')
    expect(html).not.toContain('连线不区分方向')
    expect(html).not.toContain('knowledge-local-graph__marker')
    expect(html).not.toContain('<circle')
    expect(html).not.toContain('<line')
    expect(html).not.toContain('marker-end')
    expect(html).not.toContain('<marker')
    expect(html).not.toContain('canvas')
    expect(html).not.toContain('ellipse')
  })

  it('previews only a compact Statement excerpt inside the graph', () => {
    const html = renderToString(() => (
      <KnowledgeReferenceExplorer
        projection={projection()}
        hoveredTitle="Outgoing"
        onSelect={vi.fn()}
        onHover={vi.fn()}
      />
    ))

    expect(html).toContain('knowledge-local-graph__preview')
    expect(html).toContain('role="tooltip"')
    expect(html).toContain('Outgoing body.')
    expect(html).not.toContain('它引用')
    expect(html).not.toContain('引用它')
    expect(html).not.toContain('个相邻节点')
    expect(html.match(/knowledge-local-graph__edge--first-hop/g)).toHaveLength(2)
    expect(html.match(/knowledge-local-graph__edge--active/g)).toHaveLength(2)
  })

  it('keeps unresolved references in a collapsed disclosure', () => {
    const value = projection()
    value.unresolvedReferences = [{ sourceTitle: 'Center', targetTitle: 'Missing', occurrenceCount: 3 }]
    const html = renderToString(() => (
      <KnowledgeReferenceExplorer
        projection={value}
        onSelect={vi.fn()}
        onHover={vi.fn()}
      />
    ))

    expect(html).toContain('knowledge-reference-explorer__unresolved')
    expect(html).toContain('Missing')
    expect(html).toContain('3 次')
    expect(html).not.toContain('<details open')
  })
})

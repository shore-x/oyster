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
  it('renders a text-led two-hop local graph with straight, directionless edges', () => {
    const html = renderToString(() => (
      <KnowledgeReferenceExplorer
        projection={projection()}
        onSelect={vi.fn()}
        onHover={vi.fn()}
      />
    ))

    expect(html).toMatch(/局部引用图 · [\s\S]*2[\s\S]*跳/)
    expect(html).toContain('Second hop')
    expect(html).toContain('knowledge-local-graph__edge')
    expect(html).toContain('<line')
    expect(html).toContain('data-cluster-count="1"')
    expect(html).not.toContain('marker-end')
    expect(html).not.toContain('canvas')
    expect(html).not.toContain('ellipse')
  })

  it('previews true incoming and outgoing facts for a hovered node', () => {
    const html = renderToString(() => (
      <KnowledgeReferenceExplorer
        projection={projection()}
        hoveredTitle="Outgoing"
        onSelect={vi.fn()}
        onHover={vi.fn()}
      />
    ))

    expect(html).toContain('knowledge-local-graph__preview')
    expect(html).toContain('Outgoing body.')
    expect(html).toMatch(/它引用[\s\S]*Second hop/)
    expect(html).toMatch(/Center[\s\S]*引用它/)
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

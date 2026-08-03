import { renderToString } from 'solid-js/web'
import { describe, expect, it, vi } from 'vitest'
import type { KnowledgeNeighborhoodProjection } from '../src/shared/knowledge'
import { KnowledgeReferenceGraph } from '../src/renderer/src/components/KnowledgeReferenceGraph'

function projection(centerTitle = 'Center'): KnowledgeNeighborhoodProjection {
  return {
    centerTitle,
    nodes: [
      { title: centerTitle, excerpt: 'Center body.', roles: [] },
      { title: 'Incoming', excerpt: 'Incoming body.', roles: ['incoming'] },
      { title: 'Outgoing', excerpt: 'Outgoing body.', roles: ['outgoing'] }
    ],
    edges: [
      { sourceTitle: 'Incoming', targetTitle: centerTitle, occurrenceCount: 1 },
      { sourceTitle: centerTitle, targetTitle: 'Outgoing', occurrenceCount: 1 }
    ],
    groups: [
      { kind: 'incoming', memberTitles: ['Incoming'] },
      { kind: 'outgoing', memberTitles: ['Outgoing'] }
    ],
    unresolvedReferences: []
  }
}

describe('KnowledgeReferenceGraph', () => {
  it('keeps a readable directional list alongside the canvas graph', () => {
    const html = renderToString(() => (
      <KnowledgeReferenceGraph
        projection={projection()}
        onSelect={vi.fn()}
        onHover={vi.fn()}
      />
    ))

    expect(html).toContain('箭头从引用者指向被引用者')
    expect(html).toMatch(/被引用[\s\S]*1/)
    expect(html).toMatch(/引用[\s\S]*1/)
    expect(html).toContain('Incoming')
    expect(html).toContain('Outgoing')
    expect(html).toContain('data-testid="knowledge-reference-graph"')
  })

  it('renders a hovered Statement neighborhood without changing the center projection', () => {
    const hover: KnowledgeNeighborhoodProjection = {
      centerTitle: 'Incoming',
      nodes: [
        { title: 'Incoming', excerpt: 'Incoming body.', roles: [] },
        { title: 'Center', excerpt: 'Center body.', roles: ['incoming'] }
      ],
      edges: [{ sourceTitle: 'Center', targetTitle: 'Incoming', occurrenceCount: 1 }],
      groups: [
        { kind: 'incoming', memberTitles: ['Center'] },
        { kind: 'outgoing', memberTitles: [] }
      ],
      unresolvedReferences: []
    }
    const html = renderToString(() => (
      <KnowledgeReferenceGraph
        projection={projection()}
        hoveredTitle="Incoming"
        hoverProjection={hover}
        onSelect={vi.fn()}
        onHover={vi.fn()}
      />
    ))

    expect(html).toContain('knowledge-reference-graph__hover')
    expect(html).toContain('<strong>Incoming</strong>')
    expect(html).toContain('Center')
  })
})

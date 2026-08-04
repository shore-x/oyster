import { renderToString } from 'solid-js/web'
import { describe, expect, it, vi } from 'vitest'
import type { KnowledgeNeighborhoodProjection } from '../src/shared/knowledge'
import { KnowledgeReferenceExplorer } from '../src/renderer/src/components/KnowledgeReferenceExplorer'

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
      { sourceTitle: centerTitle, targetTitle: 'Outgoing', occurrenceCount: 2 }
    ],
    groups: [
      { kind: 'incoming', memberTitles: ['Incoming'] },
      { kind: 'outgoing', memberTitles: ['Outgoing'] }
    ],
    unresolvedReferences: []
  }
}

describe('KnowledgeReferenceExplorer', () => {
  it('renders direct references as text-first incoming and outgoing groups', () => {
    const html = renderToString(() => (
      <KnowledgeReferenceExplorer
        projection={projection()}
        onSelect={vi.fn()}
        onHover={vi.fn()}
      />
    ))

    expect(html).toContain('被这些 Statement 引用')
    expect(html).toContain('当前 Statement 引用了')
    expect(html).toContain('Incoming body.')
    expect(html).toContain('Outgoing body.')
    expect(html).toContain('knowledge-reference-explorer__list')
    expect(html).toContain('<details')
    expect(html).not.toContain('canvas')
    expect(html).not.toContain('ellipse')
  })

  it('states direction and occurrence counts in natural language', () => {
    const html = renderToString(() => (
      <KnowledgeReferenceExplorer
        projection={projection()}
        onSelect={vi.fn()}
        onHover={vi.fn()}
      />
    ))

    expect(html).toContain('「Incoming」在正文中引用了「Center」')
    expect(html).toContain('「Center」在正文中引用了「Outgoing」')
    expect(html).toMatch(/共出现[\s\S]*2[\s\S]*次/)
  })

  it('shows the active Statement neighborhood inside its expanded detail', () => {
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
      <KnowledgeReferenceExplorer
        projection={projection()}
        hoveredTitle="Incoming"
        hoverProjection={hover}
        onSelect={vi.fn()}
        onHover={vi.fn()}
      />
    ))

    expect(html).toContain('knowledge-reference-explorer__neighbors')
    expect(html).toContain('<dt>被引用</dt>')
    expect(html).toContain('<dd>Center</dd>')
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

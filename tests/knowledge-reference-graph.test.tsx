import { renderToString } from 'solid-js/web'
import { describe, expect, it, vi } from 'vitest'
import type { KnowledgeNeighborhoodProjection } from '../src/shared/knowledge'
import {
  KnowledgeReferenceGraph,
  referenceGraphLabel,
  referenceGraphPositions
} from '../src/renderer/src/components/KnowledgeReferenceGraph'

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
  it('keeps the longest real fixture title while bounding unusually long graph labels', () => {
    expect(referenceGraphLabel('Knowledge Maintenance Agent')).toBe('Knowledge Maintenance Agent')
    expect(referenceGraphLabel('这是一个明显超过关系图节点安全显示长度的 canonical title 示例')).toBe(
      '这是一个明显超过关系图节点安全…'
    )
  })

  it('fans incoming and outgoing Statements into separate, non-overlapping sectors', () => {
    const incoming = Array.from({ length: 5 }, (_, index) => `Incoming ${index + 1}`)
    const outgoing = Array.from({ length: 5 }, (_, index) => `Outgoing ${index + 1}`)
    const value: KnowledgeNeighborhoodProjection = {
      centerTitle: 'Center',
      nodes: [
        { title: 'Center', excerpt: '', roles: [] },
        ...incoming.map((title) => ({ title, excerpt: '', roles: ['incoming'] as const })),
        ...outgoing.map((title) => ({ title, excerpt: '', roles: ['outgoing'] as const }))
      ],
      edges: [
        ...incoming.map((title) => ({ sourceTitle: title, targetTitle: 'Center', occurrenceCount: 1 })),
        ...outgoing.map((title) => ({ sourceTitle: 'Center', targetTitle: title, occurrenceCount: 1 }))
      ],
      groups: [
        { kind: 'incoming', memberTitles: incoming },
        { kind: 'outgoing', memberTitles: outgoing }
      ],
      unresolvedReferences: []
    }
    const positions = referenceGraphPositions(value)
    const center = positions.get('Center')!
    const incomingPositions = incoming.map((title) => positions.get(title)!)
    const outgoingPositions = outgoing.map((title) => positions.get(title)!)

    expect(incomingPositions.every((position) => position.x < center.x)).toBe(true)
    expect(outgoingPositions.every((position) => position.x > center.x)).toBe(true)
    expect(new Set(incomingPositions.map((position) => position.y)).size).toBe(incoming.length)
    expect(Math.max(...incomingPositions.map((position) => position.y))
      - Math.min(...incomingPositions.map((position) => position.y))).toBeGreaterThan(300)
    expect(Math.max(...incomingPositions.map((position) => Math.hypot(position.x, position.y))))
      .toBeGreaterThan(250)

    const compactPositions = referenceGraphPositions(value, 400)
    expect(incoming.every((title) => compactPositions.get(title)!.y < center.y)).toBe(true)
    expect(outgoing.every((title) => compactPositions.get(title)!.y > center.y)).toBe(true)
  })

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

import { describe, expect, it } from 'vitest'
import type { KnowledgeNeighborhoodProjection } from '../src/shared/knowledge'
import { buildKnowledgeLocalGraphScene } from '../src/renderer/src/knowledge-local-graph-scene'

function graph(
  titles: Array<[string, number]>,
  edges: Array<[string, string]>
): KnowledgeNeighborhoodProjection {
  return {
    centerTitle: 'Center',
    depth: 2,
    nodes: titles.map(([title, distance]) => ({ title, distance, excerpt: `${title} body.` })),
    edges: edges.map(([sourceTitle, targetTitle]) => ({
      sourceTitle,
      targetTitle,
      occurrenceCount: 1
    })),
    unresolvedReferences: []
  }
}

describe('buildKnowledgeLocalGraphScene', () => {
  it('keeps a star neutral instead of inventing cohesion between leaves', () => {
    const scene = buildKnowledgeLocalGraphScene(graph(
      [['Center', 0], ['Alpha', 1], ['Beta', 1], ['Gamma', 1]],
      [['Center', 'Alpha'], ['Center', 'Beta'], ['Center', 'Gamma']]
    ))

    expect(scene.clusterCount).toBe(0)
    expect(scene.nodes.filter((node) => node.title !== 'Center').every(
      (node) => node.clusterIndex === undefined
    )).toBe(true)
  })

  it('groups nodes that remain connected without passing through the center', () => {
    const scene = buildKnowledgeLocalGraphScene(graph(
      [
        ['Center', 0],
        ['Alpha', 1],
        ['Alpha detail', 2],
        ['Beta', 1],
        ['Beta detail', 2]
      ],
      [
        ['Center', 'Alpha'],
        ['Alpha', 'Alpha detail'],
        ['Center', 'Beta'],
        ['Beta', 'Beta detail']
      ]
    ))
    const alpha = scene.nodes.find((node) => node.title === 'Alpha')
    const alphaDetail = scene.nodes.find((node) => node.title === 'Alpha detail')
    const beta = scene.nodes.find((node) => node.title === 'Beta')

    expect(scene.clusterCount).toBe(2)
    expect(alpha?.clusterIndex).toBe(alphaDetail?.clusterIndex)
    expect(alpha?.clusterIndex).not.toBe(beta?.clusterIndex)
    expect(scene.edges.filter((edge) => edge.clusterIndex !== undefined)).toHaveLength(2)
  })

  it('collapses mutual references to one visual edge while facts remain directional', () => {
    const scene = buildKnowledgeLocalGraphScene(graph(
      [['Center', 0], ['Alpha', 1]],
      [['Center', 'Alpha'], ['Alpha', 'Center']]
    ))

    expect(scene.edges).toHaveLength(1)
  })
})

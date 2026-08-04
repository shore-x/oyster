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

  it('keeps a small local graph compact and gives second-hop labels a smaller footprint', () => {
    const scene = buildKnowledgeLocalGraphScene(graph(
      [['Center', 0], ['First', 1], ['Second A', 2], ['Second B', 2]],
      [
        ['Center', 'First'],
        ['First', 'Second A'],
        ['First', 'Second B'],
        ['Second A', 'Second B']
      ]
    ), { width: 356 })
    const center = scene.nodes.find((node) => node.title === 'Center')!
    const first = scene.nodes.find((node) => node.title === 'First')!
    const second = scene.nodes.find((node) => node.title === 'Second A')!

    expect(scene.height).toBeLessThanOrEqual(220)
    expect(center.width).toBeGreaterThan(first.width)
    expect(first.width).toBeGreaterThan(second.width)
    expect(first.height).toBeGreaterThan(second.height)
  })

  it('uses soft center repulsion to keep a cohesive second-hop branch nearby but peripheral', () => {
    const firstTitles = ['First 0', 'First 1']
    const secondTitles = Array.from({ length: 5 }, (_, index) => `Second ${index}`)
    const scene = buildKnowledgeLocalGraphScene(graph(
      [
        ['Center', 0],
        ...firstTitles.map((title) => [title, 1] as [string, number]),
        ...secondTitles.map((title) => [title, 2] as [string, number])
      ],
      [
        ...firstTitles.map((title) => ['Center', title] as [string, string]),
        ...secondTitles.map((title, index) => [firstTitles[index % firstTitles.length], title] as [string, string]),
        ...secondTitles.slice(1).map((title, index) => [secondTitles[index], title] as [string, string])
      ]
    ), { width: 360 })
    const center = scene.nodes.find((node) => node.distance === 0)!
    const radius = (node: typeof center): number => Math.hypot(
      node.x - center.x,
      node.y - center.y
    )
    const firstHopRadii = scene.nodes.filter((node) => node.distance === 1).map(radius)
    const secondHopRadii = scene.nodes.filter((node) => node.distance === 2).map(radius)
    const mean = (values: number[]): number => (
      values.reduce((total, value) => total + value, 0) / values.length
    )

    expect(Math.min(...secondHopRadii)).toBeGreaterThan(Math.min(...firstHopRadii))
    expect(mean(secondHopRadii)).toBeGreaterThan(mean(firstHopRadii) + 24)
    expect(Math.max(...secondHopRadii) - Math.max(...firstHopRadii)).toBeLessThan(90)
    expect(new Set(secondHopRadii.map((value) => Math.round(value))).size).toBeGreaterThan(1)
  })

  it('uses additional scene height only when dense text rectangles need it', () => {
    const neighbors = Array.from({ length: 16 }, (_, index) => `Statement ${index + 1} with a long title`)
    const scene = buildKnowledgeLocalGraphScene(graph(
      [['Center', 0], ...neighbors.map((title, index) => [title, index % 3 === 0 ? 1 : 2] as [string, number])],
      neighbors.flatMap((title, index) => [
        ['Center', title] as [string, string],
        ...(index === 0 ? [] : [[neighbors[index - 1], title] as [string, string]])
      ])
    ), { width: 420 })

    expect(scene.height).toBeGreaterThan(280)
    for (let leftIndex = 0; leftIndex < scene.nodes.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < scene.nodes.length; rightIndex += 1) {
        const left = scene.nodes[leftIndex]
        const right = scene.nodes[rightIndex]
        const overlaps = Math.abs(left.x - right.x) < (left.width + right.width) / 2
          && Math.abs(left.y - right.y) < (left.height + right.height) / 2
        expect(overlaps, `${left.title} overlaps ${right.title}`).toBe(false)
      }
    }
    expect(buildKnowledgeLocalGraphScene(graph(
      [['Center', 0], ...neighbors.map((title, index) => [title, index % 3 === 0 ? 1 : 2] as [string, number])],
      neighbors.map((title) => ['Center', title])
    ), { width: 420 })).toEqual(buildKnowledgeLocalGraphScene(graph(
      [['Center', 0], ...neighbors.map((title, index) => [title, index % 3 === 0 ? 1 : 2] as [string, number])],
      neighbors.map((title) => ['Center', title])
    ), { width: 420 }))
  })

  it('clips paths to text bounds and curves edges when straight routes conflict', () => {
    const titles: Array<[string, number]> = [
      ['Center', 0],
      ['Alpha', 1],
      ['Beta', 1],
      ['Gamma', 1],
      ['Delta', 1],
      ['Alpha detail', 2],
      ['Beta detail', 2],
      ['Gamma detail', 2],
      ['Delta detail', 2]
    ]
    const leafTitles = titles.slice(1).map(([title]) => title)
    const edges: Array<[string, string]> = [
      ...leafTitles.map((title) => ['Center', title] as [string, string]),
      ...leafTitles.flatMap((title, index) => leafTitles.slice(index + 1).map(
        (other) => [title, other] as [string, string]
      ))
    ]
    const scene = buildKnowledgeLocalGraphScene(graph(titles, edges), { width: 520 })

    expect(scene.edges.some((edge) => edge.curved)).toBe(true)
    expect(scene.edges.every((edge) => edge.path.startsWith('M '))).toBe(true)
    for (const edge of scene.edges) {
      const source = scene.nodes.find((node) => node.title === edge.sourceTitle)!
      const target = scene.nodes.find((node) => node.title === edge.targetTitle)!
      expect(Math.hypot(edge.sourceX - source.x, edge.sourceY - source.y)).toBeGreaterThan(0)
      expect(Math.hypot(edge.targetX - target.x, edge.targetY - target.y)).toBeGreaterThan(0)
      if (edge.curved) {
        expect(edge.controlX).toBeTypeOf('number')
        expect(edge.controlY).toBeTypeOf('number')
        expect(edge.path).toContain(' Q ')
      }
    }
  })
})

import { describe, expect, it } from 'vitest'
import {
  evidenceMapNodeText,
  groupEvidenceMapNodes,
  numberedObservation,
  planObservationSegments,
  resolveEvidenceMapPlannerOptions,
  type EvidenceMapNode
} from '../src/main/knowledge-processing/evidence-map-planner'

function options(overrides: Parameters<typeof resolveEvidenceMapPlannerOptions>[0] = {}) {
  return resolveEvidenceMapPlannerOptions({
    segmentCharacters: 26,
    adjacentContextCharacters: 13,
    mergeCharacters: 100,
    maxLines: 10,
    ...overrides
  })
}

describe('Evidence Map preprocessing planner', () => {
  it('covers every Observation line exactly once while preserving global numbering', () => {
    const segments = planObservationSegments(['aa', 'bbb', 'c', 'dddd'], options())

    expect(segments.map(({ id, startLine, endLine, lines }) => ({ id, startLine, endLine, lines })))
      .toEqual([
        { id: 'M000001', startLine: 1, endLine: 2, lines: ['aa', 'bbb'] },
        { id: 'M000002', startLine: 3, endLine: 4, lines: ['c', 'dddd'] }
      ])
    expect(segments[1]).toMatchObject({
      contextStartLine: 2,
      contextLines: ['bbb']
    })
    expect(numberedObservation(segments[1].lines, segments[1].startLine))
      .toBe('L000003 | c\nL000004 | dddd')
    expect(segments.flatMap((segment) => segment.lines)).toEqual(['aa', 'bbb', 'c', 'dddd'])
  })

  it('accepts an exact boundary and rejects an indivisible line above it', () => {
    expect(planObservationSegments(['12345'], options({ segmentCharacters: 15 }))).toHaveLength(1)
    expect(() => planObservationSegments(['123456'], options({ segmentCharacters: 15 })))
      .toThrow('L000001 加入全局行号后超过 15')
  })

  it('budgets the serialized global selectors even when the Observation contains many empty lines', () => {
    const segments = planObservationSegments(
      Array.from({ length: 30 }, () => ''),
      options({ maxLines: 30 })
    )

    expect(segments).toHaveLength(15)
    expect(segments.every(
      (segment) => numberedObservation(segment.lines, segment.startLine).length <= 26
    )).toBe(true)
  })

  it('fails closed when the global selector line space would be exceeded', () => {
    expect(() => planObservationSegments(['a', 'b', 'c'], options({ maxLines: 2 })))
      .toThrow('2 行上限')
  })

  it('groups adjacent map inputs without dropping or reordering them', () => {
    const nodes: EvidenceMapNode[] = Array.from({ length: 5 }, (_, index) => ({
      content: `map-${index + 1}`,
      startLine: index + 1,
      endLine: index + 1,
      sectionIds: [`M00000${index + 1}`]
    }))

    const groups = groupEvidenceMapNodes(nodes, 160)

    expect(groups.flat()).toEqual(nodes)
    expect(groups.every((group) => group.length > 0)).toBe(true)
    expect(groups.every((group) => group
      .map((node) => evidenceMapNodeText(node))
      .join('\n\n---\n\n').length <= 160)).toBe(true)
    expect(groups.length).toBeGreaterThan(1)
  })

  it('does not allow runtime options to weaken the production input caps', () => {
    expect(() => options({ segmentCharacters: 120_001 })).toThrow('不能超过 120000')
    expect(() => options({ adjacentContextCharacters: 4_097 })).toThrow('不能超过 4096')
    expect(() => options({ mergeCharacters: 120_001 })).toThrow('不能超过 120000')
  })
})

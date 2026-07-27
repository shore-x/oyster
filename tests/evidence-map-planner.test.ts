import { describe, expect, it } from 'vitest'
import {
  evidenceMapNodeText,
  groupEvidenceMapNodes,
  numberedObservation,
  numberedObservationUnits,
  observationLineNumber,
  planObservationSegments,
  resolveEvidenceMapPlannerOptions,
  type EvidenceMapNode
} from '../src/main/knowledge-processing/evidence-map-planner'
import { createPlainTextObservationView } from '../src/main/observation/observation-view'
import type { ObservationUnit } from '../src/main/observation/model'

function options(overrides: Parameters<typeof resolveEvidenceMapPlannerOptions>[0] = {}) {
  return resolveEvidenceMapPlannerOptions({
    segmentBytes: 26,
    adjacentContextBytes: 13,
    mergeBytes: 100,
    ...overrides
  })
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function units(content: string): ObservationUnit[] {
  return createPlainTextObservationView(content).units
}

describe('Evidence Map preprocessing planner', () => {
  it('covers every Observation line exactly once while preserving global numbering', () => {
    const segments = planObservationSegments(units('aa\nbbb\nc\ndddd'), options())

    expect(segments.map(({ id, startLine, endLine, units }) => ({
      id,
      startLine,
      endLine,
      lines: units.map((unit) => unit.content)
    })))
      .toEqual([
        { id: 'M000001', startLine: 1, endLine: 2, lines: ['aa', 'bbb'] },
        { id: 'M000002', startLine: 3, endLine: 4, lines: ['c', 'dddd'] }
      ])
    expect(segments[1]).toMatchObject({
      contextStartLine: 2,
      contextUnits: [expect.objectContaining({ content: 'bbb' })]
    })
    expect(numberedObservation(segments[1].units.map((unit) => unit.content), segments[1].startLine))
      .toBe('L000003 | c\nL000004 | dddd')
    expect(segments.flatMap((segment) => segment.units.map((unit) => unit.content)))
      .toEqual(['aa', 'bbb', 'c', 'dddd'])
  })

  it('packs adapter-produced units without changing their boundaries', () => {
    expect(planObservationSegments(units('12345'), options({ segmentBytes: 15 }))).toHaveLength(1)
    const prepared: ObservationUnit[] = [
      { lineNumber: 1, content: '12345', startCharacter: 0, endCharacter: 5, totalCharacters: 10 },
      { lineNumber: 1, content: '67890', startCharacter: 5, endCharacter: 10, totalCharacters: 10 }
    ]

    const segments = planObservationSegments(prepared, options({ segmentBytes: 40 }))

    expect(segments.flatMap((segment) => segment.units)).toEqual(prepared)
    expect(segments.every(
      (segment) => utf8Bytes(numberedObservationUnits(segment.units)) <= 40
    )).toBe(true)
  })

  it('budgets the serialized global selectors even when the Observation contains many empty lines', () => {
    const segments = planObservationSegments(
      units(Array.from({ length: 30 }, () => '').join('\n')),
      options()
    )

    expect(segments).toHaveLength(15)
    expect(segments.every(
      (segment) => numberedObservationUnits(segment.units).length <= 26
    )).toBe(true)
  })

  it('does not impose a six-digit global line-number ceiling', () => {
    expect(observationLineNumber(999_999)).toBe('L999999')
    expect(observationLineNumber(1_000_000)).toBe('L1000000')
  })

  it('uses UTF-8 bytes rather than JavaScript character counts for segment budgets', () => {
    const cjkSegments = planObservationSegments(units('汉字\n汉字'), options({ segmentBytes: 26 }))
    expect(cjkSegments).toHaveLength(2)
    expect(cjkSegments.every(
      (segment) => utf8Bytes(numberedObservationUnits(segment.units)) <= 26
    )).toBe(true)
  })

  it('keeps the original L number visible on every slice of one physical line', () => {
    const line = 'x'.repeat(100)
    const slices: ObservationUnit[] = [
      { lineNumber: 1, content: line.slice(0, 50), startCharacter: 0, endCharacter: 50, totalCharacters: 100 },
      { lineNumber: 1, content: line.slice(50), startCharacter: 50, endCharacter: 100, totalCharacters: 100 }
    ]
    const serialized = numberedObservationUnits(slices)

    expect(serialized.split('\n').every((entry) => entry.startsWith('L000001 C'))).toBe(true)
    expect(serialized).toContain('C0:')
    expect(serialized).toContain(`/${line.length} | `)
  })

  it('keeps fragmented lines separate from surrounding physical lines', () => {
    const prepared = units(`before\n${'x'.repeat(7_000)}\nafter`)
    const segments = planObservationSegments(prepared, options({
      segmentBytes: 3_200,
      adjacentContextBytes: 4_096
    }))
    const fragmented = segments.filter((segment) => segment.startLine === 2)

    expect(segments[0]).toMatchObject({ startLine: 1, endLine: 1 })
    expect(fragmented.length).toBeGreaterThan(1)
    expect(fragmented.every((segment) => segment.endLine === 2)).toBe(true)
    expect(segments.at(-1)).toMatchObject({ startLine: 3, endLine: 3 })
    expect(fragmented[1].contextUnits).toContain(fragmented[0].units.at(-1))
  })

  it('carries exact character windows into merge materials', () => {
    const text = evidenceMapNodeText({
      content: 'map',
      startLine: 7,
      endLine: 7,
      sectionIds: ['M000003'],
      characterWindow: { startCharacter: 3_000, endCharacter: 6_000, totalCharacters: 9_000 }
    })

    expect(text).toContain('Character window: C3000:6000/9000')
  })

  it('allows more than 32 bounded segments', () => {
    const segments = planObservationSegments(
      units(Array.from({ length: 34 }, () => '12345').join('\n')),
      options({ segmentBytes: 15, adjacentContextBytes: 13 })
    )

    expect(segments).toHaveLength(34)
    expect(segments.at(-1)).toMatchObject({
      id: 'M000034',
      startLine: 34,
      endLine: 34
    })
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

  it('uses UTF-8 bytes for Evidence Map merge groups', () => {
    const nodes: EvidenceMapNode[] = [1, 2].map((line) => ({
      content: '汉'.repeat(10),
      startLine: line,
      endLine: line,
      sectionIds: [`M00000${line}`]
    }))
    const singleNodeBytes = utf8Bytes(evidenceMapNodeText(nodes[0]))
    const groups = groupEvidenceMapNodes(nodes, singleNodeBytes + 1)

    expect(groups).toHaveLength(2)
    expect(groups.flat()).toEqual(nodes)
  })

  it('can pair adjacent CJK nodes near half of the merge byte budget', () => {
    const maximumBytes = 1_000
    const maximumNodeBytes = Math.floor((maximumBytes - utf8Bytes('\n\n---\n\n')) / 2)
    const nodes: EvidenceMapNode[] = [1, 2].map((line) => {
      const shape = {
        content: '',
        startLine: line,
        endLine: line,
        sectionIds: [`M00000${line}`]
      }
      const metadataBytes = utf8Bytes(evidenceMapNodeText(shape))
      return { ...shape, content: '汉'.repeat(Math.floor((maximumNodeBytes - metadataBytes) / 3)) }
    })

    expect(nodes.every((node) => utf8Bytes(evidenceMapNodeText(node)) <= maximumNodeBytes)).toBe(true)
    expect(groupEvidenceMapNodes(nodes, maximumBytes)).toEqual([nodes])
  })

  it('does not allow runtime options to weaken the production input caps', () => {
    expect(() => options({ segmentBytes: 120_001 })).toThrow('不能超过 120000')
    expect(() => options({ adjacentContextBytes: 4_097 })).toThrow('不能超过 4096')
    expect(() => options({ mergeBytes: 120_001 })).toThrow('不能超过 120000')
  })
})

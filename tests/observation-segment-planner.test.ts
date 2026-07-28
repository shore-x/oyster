import { describe, expect, it } from 'vitest'
import {
  numberedObservation,
  numberedObservationUnits,
  observationLineNumber,
  observationSourceSelectorsText,
  observationUnitsMaterialBytes,
  planObservationSegments,
  resolveObservationSegmentPlannerOptions
} from '../src/main/knowledge-processing/observation-segment-planner'
import { createPlainTextObservationView } from '../src/main/observation/observation-view'
import type { ObservationUnit } from '../src/main/observation/model'

function options(
  overrides: Parameters<typeof resolveObservationSegmentPlannerOptions>[0] = {}
) {
  return resolveObservationSegmentPlannerOptions({
    segmentBytes: 45,
    adjacentContextBytes: 13,
    ...overrides
  })
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function units(content: string): ObservationUnit[] {
  return createPlainTextObservationView(content).units
}

describe('Observation segment planner', () => {
  it('covers every Observation line exactly once while preserving global numbering', () => {
    const segments = planObservationSegments(units('aa\nbbb\nc\ndddd'), options())

    expect(segments.map(({ sourceRanges, readLocation, units }) => ({
      sourceRanges,
      readLocation,
      lines: units.map((unit) => unit.content)
    }))).toEqual([
      {
        sourceRanges: [{ startLine: 1, endLine: 2 }],
        readLocation: { line: 1, offset: 0 },
        lines: ['aa', 'bbb']
      },
      {
        sourceRanges: [{ startLine: 3, endLine: 4 }],
        readLocation: { line: 3, offset: 0 },
        lines: ['c', 'dddd']
      }
    ])
    expect(segments[1]).toMatchObject({
      contextSourceRanges: [{ startLine: 2, endLine: 2 }],
      contextUnits: [expect.objectContaining({ content: 'bbb' })]
    })
    expect(numberedObservation(segments[1].units.map((unit) => unit.content), 3))
      .toBe('L000003 | c\nL000004 | dddd')
    expect(segments.flatMap((segment) => segment.units.map((unit) => unit.content)))
      .toEqual(['aa', 'bbb', 'c', 'dddd'])
  })

  it('packs adapter-produced units without changing their boundaries', () => {
    expect(planObservationSegments(units('12345'), options({ segmentBytes: 30 }))).toHaveLength(1)
    const prepared: ObservationUnit[] = [
      { lineNumber: 1, content: '12345', startCharacter: 0, endCharacter: 5, totalCharacters: 10 },
      { lineNumber: 1, content: '67890', startCharacter: 5, endCharacter: 10, totalCharacters: 10 }
    ]

    const segments = planObservationSegments(prepared, options({ segmentBytes: 55 }))

    expect(segments.flatMap((segment) => segment.units)).toEqual(prepared)
    expect(segments.map((segment) => segment.readLocation)).toEqual([
      { line: 1, offset: 0 },
      { line: 1, offset: 5 }
    ])
    expect(segments.every(
      (segment) => utf8Bytes(numberedObservationUnits(segment.units))
        + utf8Bytes(observationSourceSelectorsText(segment.sourceRanges)) <= 55
    )).toBe(true)
    expect(observationUnitsMaterialBytes(prepared)).toBe(
      utf8Bytes(numberedObservationUnits(prepared))
    )
  })

  it('budgets an adapter-provided model representation without losing its raw locator', () => {
    const prepared: ObservationUnit[] = [{
      lineNumber: 7,
      content: 'x'.repeat(1_000),
      modelContent: 'tool result omitted; expand L000007 for details',
      startCharacter: 0,
      endCharacter: 1_000,
      totalCharacters: 1_000
    }]

    const segments = planObservationSegments(prepared, options({ segmentBytes: 100 }))

    expect(segments).toHaveLength(1)
    expect(segments[0].units).toEqual(prepared)
    expect(numberedObservationUnits(segments[0].units)).toBe(
      'L000007 | tool result omitted; expand L000007 for details'
    )
  })

  it('preserves sparse selected lines as exact coalesced ranges instead of an envelope', () => {
    const prepared: ObservationUnit[] = [1, 2, 7, 9, 10].map((lineNumber) => ({
      lineNumber,
      content: `line-${lineNumber}`,
      startCharacter: 0,
      endCharacter: `line-${lineNumber}`.length,
      totalCharacters: `line-${lineNumber}`.length
    }))

    const [segment] = planObservationSegments(prepared, options({ segmentBytes: 500 }))

    expect(segment.sourceRanges).toEqual([
      { startLine: 1, endLine: 2 },
      { startLine: 7, endLine: 7 },
      { startLine: 9, endLine: 10 }
    ])
    expect(observationSourceSelectorsText(segment.sourceRanges)).toBe(
      'L000001-L000002, L000007-L000007, L000009-L000010'
    )
  })

  it('includes exact sparse selector text in each segment material budget', () => {
    const prepared: ObservationUnit[] = Array.from({ length: 40 }, (_, index) => {
      const lineNumber = index * 2 + 1
      return {
        lineNumber,
        content: 'x',
        startCharacter: 0,
        endCharacter: 1,
        totalCharacters: 1
      }
    })

    const segments = planObservationSegments(prepared, options({ segmentBytes: 200 }))

    expect(segments.length).toBeGreaterThan(1)
    expect(segments.every((segment) => (
      utf8Bytes(numberedObservationUnits(segment.units))
        + utf8Bytes(observationSourceSelectorsText(segment.sourceRanges)) <= 200
    ))).toBe(true)
    expect(segments.flatMap((segment) => segment.sourceRanges.map((range) => range.startLine)))
      .toEqual(prepared.map((unit) => unit.lineNumber))
  })

  it('budgets serialized global selectors even when the Observation contains many empty lines', () => {
    const segments = planObservationSegments(
      units(Array.from({ length: 30 }, () => '').join('\n')),
      options()
    )

    expect(segments).toHaveLength(15)
    expect(segments.every(
      (segment) => utf8Bytes(numberedObservationUnits(segment.units))
        + utf8Bytes(observationSourceSelectorsText(segment.sourceRanges)) <= 45
    )).toBe(true)
  })

  it('does not impose a six-digit global line-number ceiling', () => {
    expect(observationLineNumber(999_999)).toBe('L999999')
    expect(observationLineNumber(1_000_000)).toBe('L1000000')
  })

  it('uses UTF-8 bytes rather than JavaScript character counts for segment budgets', () => {
    const cjkSegments = planObservationSegments(units('汉字\n汉字'), options({ segmentBytes: 46 }))
    expect(cjkSegments).toHaveLength(2)
    expect(cjkSegments.every(
      (segment) => utf8Bytes(numberedObservationUnits(segment.units))
        + utf8Bytes(observationSourceSelectorsText(segment.sourceRanges)) <= 46
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

  it('packs fragmented lines with adjacent records while preserving every unit locator', () => {
    const prepared = units(`before\n${'x'.repeat(7_000)}\nafter`)
    const segments = planObservationSegments(prepared, options({
      segmentBytes: 3_200,
      adjacentContextBytes: 4_096
    }))

    expect(segments).toHaveLength(3)
    expect(segments[0]).toMatchObject({ sourceRanges: [{ startLine: 1, endLine: 2 }] })
    expect(segments[1]).toMatchObject({ sourceRanges: [{ startLine: 2, endLine: 2 }] })
    expect(segments[2]).toMatchObject({ sourceRanges: [{ startLine: 2, endLine: 3 }] })
    expect(segments[1].contextUnits).toContain(segments[0].units.at(-1))
    expect(segments.flatMap((segment) => segment.units)).toEqual(prepared)
    expect(segments.every(
      (segment) => utf8Bytes(numberedObservationUnits(segment.units)) <= 3_200
    )).toBe(true)
  })

  it('packs fragments from different raw lines in source order', () => {
    const prepared: ObservationUnit[] = [
      { lineNumber: 1, content: 'ab', startCharacter: 0, endCharacter: 2, totalCharacters: 4 },
      { lineNumber: 1, content: 'cd', startCharacter: 2, endCharacter: 4, totalCharacters: 4 },
      { lineNumber: 2, content: 'ef', startCharacter: 0, endCharacter: 2, totalCharacters: 4 },
      { lineNumber: 2, content: 'gh', startCharacter: 2, endCharacter: 4, totalCharacters: 4 }
    ]

    const segments = planObservationSegments(prepared, options({ segmentBytes: 100 }))

    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({
      sourceRanges: [{ startLine: 1, endLine: 2 }],
      units: prepared
    })
    expect(numberedObservationUnits(segments[0].units).split('\n')).toEqual([
      'L000001 C0:2/4 | ab',
      'L000001 C2:4/4 | cd',
      'L000002 C0:2/4 | ef',
      'L000002 C2:4/4 | gh'
    ])
  })

  it('allows more than 32 bounded segments', () => {
    const segments = planObservationSegments(
      units(Array.from({ length: 34 }, () => '12345').join('\n')),
      options({ segmentBytes: 30, adjacentContextBytes: 13 })
    )

    expect(segments).toHaveLength(34)
    expect(segments.at(-1)).toMatchObject({
      sourceRanges: [{ startLine: 34, endLine: 34 }]
    })
  })

  it('uses production values as defaults rather than hard maximums', () => {
    expect(options({
      segmentBytes: 120_001,
      adjacentContextBytes: 4_097
    })).toEqual({
      segmentBytes: 120_001,
      adjacentContextBytes: 4_097
    })
  })
})

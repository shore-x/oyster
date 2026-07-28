import { observationLineAddress } from '../observation/evidence-location'
import type {
  EvidenceLocation,
  ObservationUnit
} from '../observation/model'

export { observationLineAddress as observationLineNumber } from '../observation/evidence-location'

export const DEFAULT_OBSERVATION_SEGMENT_BYTES = 120_000
export const DEFAULT_ADJACENT_CONTEXT_BYTES = 4_096
/** Per-segment locator metadata boundary; it never limits total Session coverage. */
export const MAX_OBSERVATION_SEGMENT_SELECTOR_BYTES = 24 * 1_024

export interface ObservationSourceRange {
  startLine: number
  endLine: number
}

export interface ObservationSegment {
  /** Exact, sorted and coalesced raw source lines represented by this segment. */
  sourceRanges: ObservationSourceRange[]
  units: ObservationUnit[]
  /** Exact raw source lines supplied only as adjacent context. */
  contextSourceRanges: ObservationSourceRange[]
  contextUnits: ObservationUnit[]
  /** Host-derived starting point that can be passed directly to read_evidence. */
  readLocation: EvidenceLocation
}

export interface ObservationSegmentPlannerOptions {
  segmentBytes?: number
  adjacentContextBytes?: number
}

export interface ResolvedObservationSegmentPlannerOptions {
  segmentBytes: number
  adjacentContextBytes: number
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数`)
  return value
}

export function resolveObservationSegmentPlannerOptions(
  options: ObservationSegmentPlannerOptions = {}
): ResolvedObservationSegmentPlannerOptions {
  return {
    segmentBytes: positiveInteger(
      options.segmentBytes ?? DEFAULT_OBSERVATION_SEGMENT_BYTES,
      'Observation 分段预算'
    ),
    adjacentContextBytes: positiveInteger(
      options.adjacentContextBytes ?? DEFAULT_ADJACENT_CONTEXT_BYTES,
      '相邻上下文预算'
    )
  }
}

export function observationSelector(startLine: number, endLine: number): string {
  return `${observationLineAddress(startLine)}-${observationLineAddress(endLine)}`
}

/**
 * Produces the exact union of already source-ordered ranges. Overlapping ranges
 * occur when consecutive segments contain different fragments of one raw line.
 */
export function coalesceObservationSourceRanges(
  ranges: ObservationSourceRange[]
): ObservationSourceRange[] {
  const coalesced: ObservationSourceRange[] = []
  for (const range of ranges) {
    if (
      !Number.isSafeInteger(range.startLine)
      || !Number.isSafeInteger(range.endLine)
      || range.startLine < 1
      || range.endLine < range.startLine
    ) {
      throw new Error('Observation source range 无效')
    }
    const previous = coalesced.at(-1)
    if (!previous) {
      coalesced.push({ ...range })
      continue
    }
    if (range.startLine < previous.startLine) {
      throw new Error('Observation source ranges 必须按原始证据顺序排列')
    }
    if (range.startLine <= previous.endLine + 1) {
      previous.endLine = Math.max(previous.endLine, range.endLine)
      continue
    }
    coalesced.push({ ...range })
  }
  return coalesced
}

export function observationSourceRanges(units: ObservationUnit[]): ObservationSourceRange[] {
  return coalesceObservationSourceRanges(units.map((unit) => ({
    startLine: unit.lineNumber,
    endLine: unit.lineNumber
  })))
}

export function observationSourceSelectors(ranges: ObservationSourceRange[]): string[] {
  return ranges.map((range) => observationSelector(range.startLine, range.endLine))
}

export function observationSourceSelectorsText(ranges: ObservationSourceRange[]): string {
  return observationSourceSelectors(ranges).join(', ')
}

export function numberedObservation(lines: string[], startLine = 1): string {
  return lines.map((line, index) => `${observationLineAddress(startLine + index)} | ${line}`).join('\n')
}

function isWholeLine(unit: ObservationUnit): boolean {
  return unit.startCharacter === 0 && unit.endCharacter === unit.totalCharacters
}

function serializedObservationUnit(unit: ObservationUnit): string {
  const prefix = isWholeLine(unit)
    ? observationLineAddress(unit.lineNumber)
    : `${observationLineAddress(unit.lineNumber)} C${unit.startCharacter}:${unit.endCharacter}/${unit.totalCharacters}`
  const recordContext = unit.recordContext ? ` [${unit.recordContext}]` : ''
  return `${prefix}${recordContext} | ${unit.modelContent ?? unit.content}`
}

/** Serializes adapter-owned units without changing their original raw line numbers. */
export function numberedObservationUnits(units: ObservationUnit[]): string {
  return units.map((unit) => serializedObservationUnit(unit)).join('\n')
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

/** Byte size of numberedObservationUnits without materializing the full joined string. */
export function observationUnitsMaterialBytes(units: ObservationUnit[]): number {
  return units.reduce(
    (total, unit, index) => total + utf8Bytes(serializedObservationUnit(unit)) + (index ? 1 : 0),
    0
  )
}

function selectorBytes(range: ObservationSourceRange): number {
  return utf8Bytes(observationSelector(range.startLine, range.endLine))
}

function nextSelectorTextBytes(
  ranges: ObservationSourceRange[],
  selectorTextBytes: number,
  lineNumber: number
): number {
  const previous = ranges.at(-1)
  if (!previous) {
    const range = { startLine: lineNumber, endLine: lineNumber }
    return selectorBytes(range)
  }
  if (lineNumber <= previous.endLine + 1) {
    if (lineNumber <= previous.endLine) return selectorTextBytes
    const extended = { startLine: previous.startLine, endLine: lineNumber }
    return selectorTextBytes - selectorBytes(previous) + selectorBytes(extended)
  }
  const range = { startLine: lineNumber, endLine: lineNumber }
  return selectorTextBytes + utf8Bytes(', ') + selectorBytes(range)
}

function includeSourceLine(ranges: ObservationSourceRange[], lineNumber: number): void {
  const previous = ranges.at(-1)
  if (!previous || lineNumber > previous.endLine + 1) {
    ranges.push({ startLine: lineNumber, endLine: lineNumber })
  } else {
    previous.endLine = Math.max(previous.endLine, lineNumber)
  }
}

function adjacentContext(
  units: ObservationUnit[],
  startIndex: number,
  maximumBytes: number
): { sourceRanges: ObservationSourceRange[]; units: ObservationUnit[] } {
  const selected: ObservationUnit[] = []
  let bytes = 0
  for (let index = startIndex - 1; index >= 0; index--) {
    const weight = utf8Bytes(serializedObservationUnit(units[index])) + (selected.length ? 1 : 0)
    if (weight > maximumBytes || bytes + weight > maximumBytes) break
    selected.unshift(units[index])
    bytes += weight
  }
  return { sourceRanges: observationSourceRanges(selected), units: selected }
}

/**
 * Packs adapter-produced units into model-bounded segments. The planner never
 * interprets or slices an Agent's raw history format. Each segment's material
 * budget includes both its serialized units and its exact selector text.
 */
export function planObservationSegments(
  units: ObservationUnit[],
  options: ResolvedObservationSegmentPlannerOptions
): ObservationSegment[] {
  const segments: ObservationSegment[] = []
  let startIndex = 0
  while (startIndex < units.length) {
    const segmentUnits: ObservationUnit[] = []
    let observationBytes = 0
    let sourceRanges: ObservationSourceRange[] = []
    let selectorTextBytes = 0
    let index = startIndex
    while (index < units.length) {
      const nextUnit = units[index]
      const serializedBytes = utf8Bytes(serializedObservationUnit(nextUnit))
      const observationWeight = serializedBytes + (segmentUnits.length ? 1 : 0)
      const nextSelectorBytes = nextSelectorTextBytes(
        sourceRanges,
        selectorTextBytes,
        nextUnit.lineNumber
      )
      const materialBytes = observationBytes + observationWeight + nextSelectorBytes
      if (
        !segmentUnits.length
        && (
          materialBytes > options.segmentBytes
          || nextSelectorBytes > MAX_OBSERVATION_SEGMENT_SELECTOR_BYTES
        )
      ) {
        throw new Error(
          `Observation view unit ${observationLineAddress(nextUnit.lineNumber)} exceeds the selected model material budget`
        )
      }
      if (
        segmentUnits.length
        && (
          materialBytes > options.segmentBytes
          || nextSelectorBytes > MAX_OBSERVATION_SEGMENT_SELECTOR_BYTES
        )
      ) break
      segmentUnits.push(nextUnit)
      observationBytes += observationWeight
      includeSourceLine(sourceRanges, nextUnit.lineNumber)
      selectorTextBytes = nextSelectorBytes
      index++
    }
    const context = adjacentContext(units, startIndex, options.adjacentContextBytes)
    segments.push({
      sourceRanges,
      units: segmentUnits,
      contextSourceRanges: context.sourceRanges,
      contextUnits: context.units,
      readLocation: {
        line: segmentUnits[0].lineNumber,
        offset: segmentUnits[0].startCharacter
      }
    })
    startIndex = index
  }
  return segments
}

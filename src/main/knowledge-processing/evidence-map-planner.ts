import type { ObservationCharacterWindow, ObservationUnit } from '../observation/model'

export const DEFAULT_OBSERVATION_SEGMENT_BYTES = 120_000
export const DEFAULT_ADJACENT_CONTEXT_BYTES = 4_096
export const DEFAULT_MAP_MERGE_BYTES = 120_000

export interface ObservationSegment {
  id: string
  startLine: number
  endLine: number
  units: ObservationUnit[]
  contextStartLine?: number
  contextUnits: ObservationUnit[]
}

export interface EvidenceMapNode {
  content: string
  startLine: number
  endLine: number
  sectionIds: string[]
  characterWindow?: ObservationCharacterWindow
}

export interface EvidenceMapPlannerOptions {
  segmentBytes?: number
  adjacentContextBytes?: number
  mergeBytes?: number
}

export interface ResolvedEvidenceMapPlannerOptions {
  segmentBytes: number
  adjacentContextBytes: number
  mergeBytes: number
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数`)
  return value
}

export function resolveEvidenceMapPlannerOptions(
  options: EvidenceMapPlannerOptions = {}
): ResolvedEvidenceMapPlannerOptions {
  const segmentBytes = positiveInteger(
    options.segmentBytes ?? DEFAULT_OBSERVATION_SEGMENT_BYTES,
    'Observation 分段预算'
  )
  const adjacentContextBytes = positiveInteger(
    options.adjacentContextBytes ?? DEFAULT_ADJACENT_CONTEXT_BYTES,
    '相邻上下文预算'
  )
  const mergeBytes = positiveInteger(
    options.mergeBytes ?? DEFAULT_MAP_MERGE_BYTES,
    'Evidence Map 归并预算'
  )
  if (segmentBytes > DEFAULT_OBSERVATION_SEGMENT_BYTES) {
    throw new Error(`Observation 分段预算不能超过 ${DEFAULT_OBSERVATION_SEGMENT_BYTES}`)
  }
  if (adjacentContextBytes > DEFAULT_ADJACENT_CONTEXT_BYTES) {
    throw new Error(`相邻上下文预算不能超过 ${DEFAULT_ADJACENT_CONTEXT_BYTES}`)
  }
  if (mergeBytes > DEFAULT_MAP_MERGE_BYTES) {
    throw new Error(`Evidence Map 归并预算不能超过 ${DEFAULT_MAP_MERGE_BYTES}`)
  }
  return { segmentBytes, adjacentContextBytes, mergeBytes }
}

export function observationLineNumber(line: number): string {
  return `L${String(line).padStart(6, '0')}`
}

export function observationSelector(startLine: number, endLine: number): string {
  return `${observationLineNumber(startLine)}-${observationLineNumber(endLine)}`
}

export function evidenceMapSectionId(index: number): string {
  return `M${String(index + 1).padStart(6, '0')}`
}

export function numberedObservation(lines: string[], startLine = 1): string {
  return lines.map((line, index) => `${observationLineNumber(startLine + index)} | ${line}`).join('\n')
}

function isWholeLine(unit: ObservationUnit): boolean {
  return unit.startCharacter === 0 && unit.endCharacter === unit.totalCharacters
}

function serializedObservationUnit(unit: ObservationUnit): string {
  const prefix = isWholeLine(unit)
    ? observationLineNumber(unit.lineNumber)
    : `${observationLineNumber(unit.lineNumber)} C${unit.startCharacter}:${unit.endCharacter}/${unit.totalCharacters}`
  const recordContext = unit.recordContext ? ` [${unit.recordContext}]` : ''
  return `${prefix}${recordContext} | ${unit.content}`
}

/** Serializes adapter-owned units without changing their original raw line numbers. */
export function numberedObservationUnits(units: ObservationUnit[]): string {
  return units.map((unit) => serializedObservationUnit(unit)).join('\n')
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function adjacentContext(
  units: ObservationUnit[],
  startIndex: number,
  maximumBytes: number
): { startLine?: number; units: ObservationUnit[] } {
  const selected: ObservationUnit[] = []
  let bytes = 0
  for (let index = startIndex - 1; index >= 0; index--) {
    const weight = utf8Bytes(serializedObservationUnit(units[index])) + (selected.length ? 1 : 0)
    if (weight > maximumBytes || bytes + weight > maximumBytes) break
    selected.unshift(units[index])
    bytes += weight
  }
  return selected.length
    ? { startLine: selected[0].lineNumber, units: selected }
    : { units: [] }
}

/**
 * Packs adapter-produced units into model-bounded segments. The planner never
 * interprets or slices an Agent's raw history format.
 */
export function planObservationSegments(
  units: ObservationUnit[],
  options: ResolvedEvidenceMapPlannerOptions
): ObservationSegment[] {
  const segments: ObservationSegment[] = []
  let startIndex = 0
  while (startIndex < units.length) {
    const segmentUnits: ObservationUnit[] = []
    let bytes = 0
    let index = startIndex
    while (index < units.length) {
      const nextUnit = units[index]
      const nextIsFragment = !isWholeLine(nextUnit)
      const segmentIsFragment = segmentUnits.some((unit) => !isWholeLine(unit))
      if (
        segmentUnits.length
        && (
          (segmentIsFragment && nextUnit.lineNumber !== segmentUnits[0].lineNumber)
          || (!segmentIsFragment && nextIsFragment)
        )
      ) {
        break
      }
      const serializedBytes = utf8Bytes(serializedObservationUnit(nextUnit))
      if (serializedBytes > options.segmentBytes) {
        throw new Error(
          `Observation view unit ${observationLineNumber(nextUnit.lineNumber)} exceeds the selected model material budget`
        )
      }
      const weight = serializedBytes + (segmentUnits.length ? 1 : 0)
      if (segmentUnits.length && bytes + weight > options.segmentBytes) break
      segmentUnits.push(nextUnit)
      bytes += weight
      index++
    }
    const context = adjacentContext(units, startIndex, options.adjacentContextBytes)
    segments.push({
      id: evidenceMapSectionId(segments.length),
      startLine: segmentUnits[0].lineNumber,
      endLine: segmentUnits[segmentUnits.length - 1].lineNumber,
      units: segmentUnits,
      contextStartLine: context.startLine,
      contextUnits: context.units
    })
    startIndex = index
  }
  return segments
}

export function evidenceMapNodeText(node: EvidenceMapNode): string {
  return [
    `Covered range: ${observationSelector(node.startLine, node.endLine)}`,
    ...(node.characterWindow
      ? [`Character window: C${node.characterWindow.startCharacter}:${node.characterWindow.endCharacter}/${node.characterWindow.totalCharacters}`]
      : []),
    `Expandable map sections: ${node.sectionIds.join(', ')}`,
    node.content
  ].join('\n')
}

/** Groups adjacent map nodes without dropping or reordering any input. */
export function groupEvidenceMapNodes(
  nodes: EvidenceMapNode[],
  maximumBytes: number
): EvidenceMapNode[][] {
  positiveInteger(maximumBytes, 'Evidence Map 归并预算')
  const groups: EvidenceMapNode[][] = []
  let group: EvidenceMapNode[] = []
  let bytes = 0
  for (const node of nodes) {
    const nodeBytes = utf8Bytes(evidenceMapNodeText(node))
    if (nodeBytes > maximumBytes) {
      throw new Error('局部 Evidence Map 超过单次导航归并输入上限')
    }
    const separatorBytes = utf8Bytes('\n\n---\n\n')
    if (group.length && bytes + separatorBytes + nodeBytes > maximumBytes) {
      groups.push(group)
      group = []
      bytes = 0
    }
    bytes += (group.length ? separatorBytes : 0) + nodeBytes
    group.push(node)
  }
  if (group.length) groups.push(group)
  return groups
}

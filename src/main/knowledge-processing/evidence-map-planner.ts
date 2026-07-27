export const DEFAULT_OBSERVATION_SEGMENT_CHARACTERS = 120_000
export const DEFAULT_ADJACENT_CONTEXT_CHARACTERS = 4_096
export const DEFAULT_MAP_MERGE_CHARACTERS = 120_000
export const MAX_ADDRESSABLE_OBSERVATION_LINES = 999_999

export interface ObservationSegment {
  id: string
  startLine: number
  endLine: number
  lines: string[]
  contextStartLine?: number
  contextLines: string[]
}

export interface EvidenceMapNode {
  content: string
  startLine: number
  endLine: number
  sectionIds: string[]
}

export interface EvidenceMapPlannerOptions {
  segmentCharacters?: number
  adjacentContextCharacters?: number
  mergeCharacters?: number
  maxLines?: number
}

export interface ResolvedEvidenceMapPlannerOptions {
  segmentCharacters: number
  adjacentContextCharacters: number
  mergeCharacters: number
  maxLines: number
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数`)
  return value
}

export function resolveEvidenceMapPlannerOptions(
  options: EvidenceMapPlannerOptions = {}
): ResolvedEvidenceMapPlannerOptions {
  const segmentCharacters = positiveInteger(
    options.segmentCharacters ?? DEFAULT_OBSERVATION_SEGMENT_CHARACTERS,
    'Observation 分段预算'
  )
  const adjacentContextCharacters = positiveInteger(
    options.adjacentContextCharacters ?? DEFAULT_ADJACENT_CONTEXT_CHARACTERS,
    '相邻上下文预算'
  )
  const mergeCharacters = positiveInteger(
    options.mergeCharacters ?? DEFAULT_MAP_MERGE_CHARACTERS,
    'Evidence Map 归并预算'
  )
  const maxLines = positiveInteger(
    options.maxLines ?? MAX_ADDRESSABLE_OBSERVATION_LINES,
    'Observation 行数上限'
  )
  if (maxLines > MAX_ADDRESSABLE_OBSERVATION_LINES) {
    throw new Error(`Observation 行数上限不能超过 ${MAX_ADDRESSABLE_OBSERVATION_LINES}`)
  }
  if (segmentCharacters > DEFAULT_OBSERVATION_SEGMENT_CHARACTERS) {
    throw new Error(`Observation 分段预算不能超过 ${DEFAULT_OBSERVATION_SEGMENT_CHARACTERS}`)
  }
  if (adjacentContextCharacters > DEFAULT_ADJACENT_CONTEXT_CHARACTERS) {
    throw new Error(`相邻上下文预算不能超过 ${DEFAULT_ADJACENT_CONTEXT_CHARACTERS}`)
  }
  if (mergeCharacters > DEFAULT_MAP_MERGE_CHARACTERS) {
    throw new Error(`Evidence Map 归并预算不能超过 ${DEFAULT_MAP_MERGE_CHARACTERS}`)
  }
  return { segmentCharacters, adjacentContextCharacters, mergeCharacters, maxLines }
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

function lineWeight(line: string): number {
  return `${observationLineNumber(1)} | ${line}`.length
}

function adjacentContext(
  lines: string[],
  startIndex: number,
  maximumCharacters: number
): { startLine?: number; lines: string[] } {
  const selected: string[] = []
  let characters = 0
  for (let index = startIndex - 1; index >= 0; index--) {
    const weight = lineWeight(lines[index]) + (selected.length ? 1 : 0)
    if (weight > maximumCharacters || characters + weight > maximumCharacters) break
    selected.unshift(lines[index])
    characters += weight
  }
  return selected.length
    ? { startLine: startIndex - selected.length + 1, lines: selected }
    : { lines: [] }
}

/** Splits one already-normalized Observation without changing its global line address space. */
export function planObservationSegments(
  lines: string[],
  options: ResolvedEvidenceMapPlannerOptions
): ObservationSegment[] {
  if (lines.length > options.maxLines) {
    throw new Error(`Observation 超过可寻址的 ${options.maxLines} 行上限`)
  }
  const segments: ObservationSegment[] = []
  let startIndex = 0
  while (startIndex < lines.length) {
    const segmentLines: string[] = []
    let characters = 0
    let index = startIndex
    while (index < lines.length) {
      const serializedLine = lineWeight(lines[index])
      const weight = serializedLine + (segmentLines.length ? 1 : 0)
      if (serializedLine > options.segmentCharacters) {
        throw new Error(
          `Observation ${observationLineNumber(index + 1)} 加入全局行号后超过 ${options.segmentCharacters} 个字符的单次处理上限`
        )
      }
      if (segmentLines.length && characters + weight > options.segmentCharacters) break
      segmentLines.push(lines[index])
      characters += weight
      index++
    }
    const context = adjacentContext(lines, startIndex, options.adjacentContextCharacters)
    segments.push({
      id: evidenceMapSectionId(segments.length),
      startLine: startIndex + 1,
      endLine: index,
      lines: segmentLines,
      contextStartLine: context.startLine,
      contextLines: context.lines
    })
    startIndex = index
  }
  return segments
}

export function evidenceMapNodeText(node: EvidenceMapNode): string {
  return [
    `Covered range: ${observationSelector(node.startLine, node.endLine)}`,
    `Expandable map sections: ${node.sectionIds.join(', ')}`,
    node.content
  ].join('\n')
}

/** Groups adjacent map nodes without dropping or reordering any input. */
export function groupEvidenceMapNodes(
  nodes: EvidenceMapNode[],
  maximumCharacters: number
): EvidenceMapNode[][] {
  positiveInteger(maximumCharacters, 'Evidence Map 归并预算')
  const groups: EvidenceMapNode[][] = []
  let group: EvidenceMapNode[] = []
  let characters = 0
  for (const node of nodes) {
    const nodeCharacters = evidenceMapNodeText(node).length
    if (nodeCharacters > maximumCharacters) {
      throw new Error('局部 Evidence Map 超过单次导航归并输入上限')
    }
    const separatorCharacters = '\n\n---\n\n'.length
    if (group.length && characters + separatorCharacters + nodeCharacters > maximumCharacters) {
      groups.push(group)
      group = []
      characters = 0
    }
    characters += (group.length ? separatorCharacters : 0) + nodeCharacters
    group.push(node)
  }
  if (group.length) groups.push(group)
  return groups
}

import type { EvidenceLocation } from './model'

export const DEFAULT_EVIDENCE_READ_LIMIT = 16 * 1_024
export const MAX_EVIDENCE_READ_LIMIT = 48 * 1_024
export const MAX_EVIDENCE_READ_LINES = 200

export interface EvidenceReadChunk {
  line: number
  startOffset: number
  endOffset: number
  totalCharacters: number
  content: string
}

export interface EvidenceReadPage {
  requestedStart: EvidenceLocation
  start: EvidenceLocation
  end: EvidenceLocation
  next?: EvidenceLocation
  eof: boolean
  chunks: EvidenceReadChunk[]
  returnedCharacters: number
  returnedLines: number
  requestedLimit: number
  appliedLimit: number
}

export function observationLineAddress(line: number): string {
  return `L${String(line).padStart(6, '0')}`
}

export function formatEvidenceLocation(location: EvidenceLocation): string {
  return `${observationLineAddress(location.line)}:C${location.offset}`
}

export function evidenceReadCallHint(
  location: EvidenceLocation,
  limit = DEFAULT_EVIDENCE_READ_LIMIT
): string {
  return `read_evidence({"line":${location.line},"offset":${location.offset},"limit":${limit}})`
}

export function compareEvidenceLocations(left: EvidenceLocation, right: EvidenceLocation): number {
  if (left.line !== right.line) return left.line - right.line
  return left.offset - right.offset
}

export function splitsSurrogatePair(value: string, offset: number): boolean {
  if (offset <= 0 || offset >= value.length) return false
  const left = value.charCodeAt(offset - 1)
  const right = value.charCodeAt(offset)
  return left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff
}

function assertLocation(lines: string[], location: EvidenceLocation): void {
  if (
    !Number.isSafeInteger(location.line)
    || location.line < 1
    || location.line > lines.length
    || !Number.isSafeInteger(location.offset)
    || location.offset < 0
    || location.offset > lines[location.line - 1].length
    || splitsSurrogatePair(lines[location.line - 1], location.offset)
  ) {
    throw new Error('Evidence Location 无效或切开了 Unicode 字符')
  }
}

/**
 * Reads a bounded page from a line-addressed raw Observation. The limit counts
 * UTF-16 characters from physical-line content. Large requests are
 * clamped and always return a continuation instead of failing for source size.
 */
export function readEvidencePage(
  lines: string[],
  requestedStart: EvidenceLocation,
  requestedLimit: number
): EvidenceReadPage {
  if (!lines.length) throw new Error('Observation 没有可读取的原始证据')
  assertLocation(lines, requestedStart)
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 2) {
    throw new Error('read_evidence limit 必须是大于等于 2 的整数')
  }

  const start = { ...requestedStart }
  const appliedLimit = Math.min(requestedLimit, MAX_EVIDENCE_READ_LIMIT)
  const chunks: EvidenceReadChunk[] = []
  let current: EvidenceLocation = { ...start }
  let remaining = appliedLimit
  let returnedCharacters = 0
  let returnedLines = 0

  while (
    current.line <= lines.length
    && remaining > 0
    && returnedLines < MAX_EVIDENCE_READ_LINES
  ) {
    const value = lines[current.line - 1]
    const available = value.length - current.offset

    if (available > 0) {
      let endOffset = current.offset + Math.min(available, remaining)
      if (splitsSurrogatePair(value, endOffset)) endOffset--
      if (endOffset === current.offset) break
      const content = value.slice(current.offset, endOffset)
      chunks.push({
        line: current.line,
        startOffset: current.offset,
        endOffset,
        totalCharacters: value.length,
        content
      })
      const consumed = endOffset - current.offset
      returnedCharacters += consumed
      remaining -= consumed
      returnedLines++
      current = { line: current.line, offset: endOffset }
    } else {
      chunks.push({
        line: current.line,
        startOffset: current.offset,
        endOffset: current.offset,
        totalCharacters: value.length,
        content: ''
      })
      returnedLines++
    }

    if (current.offset < value.length) break
    if (current.line === lines.length) break
    if (remaining === 0 || returnedLines >= MAX_EVIDENCE_READ_LINES) {
      current = { line: current.line + 1, offset: 0 }
      break
    }
    current = { line: current.line + 1, offset: 0 }
  }

  const atEnd = current.line === lines.length && current.offset === lines.at(-1)!.length
  return {
    requestedStart: { ...requestedStart },
    start,
    end: { ...current },
    ...(atEnd ? {} : { next: { ...current } }),
    eof: atEnd,
    chunks,
    returnedCharacters,
    returnedLines,
    requestedLimit,
    appliedLimit
  }
}

export function formatEvidenceReadPage(page: EvidenceReadPage): string {
  const body = page.chunks.length
    ? page.chunks.map((chunk) => chunk.content).join('\n')
    : '(No source characters returned at EOF.)'
  return [
    `Requested start: ${formatEvidenceLocation(page.requestedStart)}`,
    `Returned range (end exclusive): ${formatEvidenceLocation(page.start)}-${formatEvidenceLocation(page.end)}`,
    `Returned source characters: ${page.returnedCharacters}`,
    `Applied limit: ${page.appliedLimit}${page.requestedLimit === page.appliedLimit ? '' : ` (requested ${page.requestedLimit})`}`,
    `Next: ${page.next ? formatEvidenceLocation(page.next) : 'none (EOF)'}`,
    `EOF: ${page.eof ? 'true' : 'false'}`,
    'BEGIN_RAW_EVIDENCE',
    body,
    'END_RAW_EVIDENCE'
  ].join('\n')
}

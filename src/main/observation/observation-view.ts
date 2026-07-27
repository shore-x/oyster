import type { ObservationUnit, ObservationView } from './model'

/** Leaves room for a locator and adapter context inside the default 4 KiB boundary context. */
export const MAX_OBSERVATION_UNIT_BYTES = 3 * 1_024

export interface ObservationLineFraming {
  preferredBreaks?: number[]
  recordContext?: string
  /** Adapter-owned adjustment for boundaries that are unsafe in its source encoding. */
  adjustBoundary?: (line: string, offset: number, minimum: number) => number
}

export type ObservationLineFramer = (line: string, lineNumber: number) => ObservationLineFraming

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff
}

function safeBoundary(value: string, offset: number, minimum: number): number {
  if (
    offset > minimum
    && offset < value.length
    && isHighSurrogate(value.charCodeAt(offset - 1))
    && isLowSurrogate(value.charCodeAt(offset))
  ) {
    return offset - 1
  }
  return offset
}

function nextBoundary(value: string, offset: number): number {
  const codePoint = value.codePointAt(offset)
  return offset + (codePoint !== undefined && codePoint > 0xffff ? 2 : 1)
}

function normalizedBreaks(value: string, breaks: number[]): number[] {
  return [...new Set(breaks)]
    .filter((offset) => (
      Number.isSafeInteger(offset)
      && offset > 0
      && offset < value.length
      && safeBoundary(value, offset, 0) === offset
    ))
    .sort((left, right) => left - right)
}

function utf8CodePointBytes(codePoint: number): number {
  if (codePoint <= 0x7f) return 1
  if (codePoint <= 0x7ff) return 2
  if (codePoint <= 0xffff) return 3
  return 4
}

function lineUnits(
  line: string,
  lineNumber: number,
  framing: ObservationLineFraming
): ObservationUnit[] {
  const unit = (startCharacter: number, endCharacter: number): ObservationUnit => ({
    lineNumber,
    content: line.slice(startCharacter, endCharacter),
    startCharacter,
    endCharacter,
    totalCharacters: line.length,
    ...(framing.recordContext ? { recordContext: framing.recordContext } : {})
  })
  if (utf8Bytes(line) <= MAX_OBSERVATION_UNIT_BYTES) {
    return [unit(0, line.length)]
  }

  const breaks = normalizedBreaks(line, framing.preferredBreaks ?? [])
  const units: ObservationUnit[] = []
  let startCharacter = 0
  let endCharacter = 0
  let bytes = 0
  let breakIndex = 0
  const emit = (): void => {
    units.push(unit(startCharacter, endCharacter))
    startCharacter = endCharacter
    bytes = 0
  }
  while (endCharacter < line.length) {
    const codePoint = line.codePointAt(endCharacter)!
    const nextCharacter = nextBoundary(line, endCharacter)
    const codePointBytes = utf8CodePointBytes(codePoint)
    if (bytes && bytes + codePointBytes > MAX_OBSERVATION_UNIT_BYTES) {
      const adjusted = framing.adjustBoundary?.(line, endCharacter, startCharacter)
      if (
        adjusted !== undefined
        && adjusted > startCharacter
        && adjusted < endCharacter
        && safeBoundary(line, adjusted, startCharacter) === adjusted
      ) {
        endCharacter = adjusted
      }
      emit()
      continue
    }
    bytes += codePointBytes
    endCharacter = nextCharacter
    while (breakIndex < breaks.length && breaks[breakIndex] < endCharacter) breakIndex++
    const atPreferredBreak = breaks[breakIndex] === endCharacter
    if (atPreferredBreak) breakIndex++
    if (atPreferredBreak && bytes >= Math.floor(MAX_OBSERVATION_UNIT_BYTES * 0.75)) emit()
  }
  if (endCharacter > startCharacter) emit()
  return units
}

/**
 * Shared lossless text primitive. It knows only raw lines and byte-safe units;
 * the owning source adapter supplies all format-specific framing.
 */
export function createObservationViewFromLines(
  rawLines: string[],
  formatVersion: string,
  frameLine: ObservationLineFramer = () => ({})
): ObservationView {
  return {
    formatVersion,
    rawLines,
    units: rawLines.flatMap((line, index) => lineUnits(line, index + 1, frameLine(line, index + 1)))
  }
}

export function createPlainTextObservationView(content: string): ObservationView {
  return createObservationViewFromLines(content.split(/\r\n|\r|\n/), 'plain-text-v1')
}

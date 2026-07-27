import type { ObservationView } from '../observation/model'
import {
  createObservationViewFromLines,
  type ObservationLineFraming
} from '../observation/observation-view'

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : undefined
}

function sourceToken(value: unknown): string | undefined {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 64
    && /^[a-zA-Z0-9_.:-]+$/.test(value)
    ? value
    : undefined
}

function contentBlockTypes(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.flatMap((item) => {
    const type = sourceToken(asRecord(item)?.type)
    return type ? [type] : []
  }))].slice(0, 8)
}

function recordContext(agent: string, values: Array<[string, unknown]>): string {
  const details = values.flatMap(([label, value]) => {
    if (Array.isArray(value)) return value.length ? [`${label}=${value.join(',')}`] : []
    const token = sourceToken(value)
    return token ? [`${label}=${token}`] : []
  })
  const context = [agent, ...details].join(' · ')
  if (Buffer.byteLength(context, 'utf8') <= 512) return context
  let end = Math.min(context.length, 511)
  while (end > 0 && Buffer.byteLength(`${context.slice(0, end)}…`, 'utf8') > 512) end--
  return `${context.slice(0, end)}…`
}

function parsedRecord(line: string): Record<string, unknown> | undefined {
  if (!line.trim()) return undefined
  try {
    return asRecord(JSON.parse(line))
  } catch {
    return undefined
  }
}

/** JSON syntax is a safe preference, never a semantic boundary imposed on an Agent format. */
function jsonSyntaxBreaks(line: string): number[] {
  const breaks: number[] = []
  let lastBucket = -1
  let inString = false
  let escaped = false
  for (let index = 0; index < line.length; index++) {
    const character = line[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') {
      inString = true
    } else if (character === ',' || character === '}' || character === ']') {
      const offset = index + 1
      const bucket = Math.floor(offset / 512)
      if (bucket === lastBucket) breaks[breaks.length - 1] = offset
      else {
        lastBucket = bucket
        breaks.push(offset)
      }
    }
  }
  return breaks
}

function unescapedBackslashAt(value: string, index: number): boolean {
  if (value[index] !== '\\') return false
  let preceding = 0
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor--) preceding++
  return preceding % 2 === 0
}

/** Avoids handing the model a fragment boundary in the middle of one JSON escape. */
function jsonSafeBoundary(value: string, offset: number, minimum: number): number {
  const searchStart = Math.max(minimum, offset - 6)
  for (let index = searchStart; index < offset; index++) {
    if (!unescapedBackslashAt(value, index)) continue
    const escapeEnd = value[index + 1] === 'u' ? index + 6 : index + 2
    if (offset > index && offset < escapeEnd && index > minimum) return index
  }
  return offset
}

function jsonlView(
  rawContent: string,
  formatVersion: string,
  frameRecord: (record: Record<string, unknown> | undefined) => string
): ObservationView {
  const rawLines = rawContent.split(/\r\n|\r|\n/)
  return createObservationViewFromLines(rawLines, formatVersion, (line): ObservationLineFraming => ({
    preferredBreaks: jsonSyntaxBreaks(line),
    adjustBoundary: jsonSafeBoundary,
    recordContext: frameRecord(parsedRecord(line))
  }))
}

function claudeRecordContext(record: Record<string, unknown> | undefined): string {
  const message = asRecord(record?.message)
  return recordContext('Claude', [
    ['record', record?.type],
    ['role', message?.role],
    ['blocks', contentBlockTypes(message?.content)]
  ])
}

function piRecordContext(record: Record<string, unknown> | undefined): string {
  const message = asRecord(record?.message)
  return recordContext('Pi', [
    ['record', record?.type],
    ['role', record?.role ?? message?.role],
    ['blocks', contentBlockTypes(record?.content ?? message?.content)]
  ])
}

function codexRecordContext(record: Record<string, unknown> | undefined): string {
  const payload = asRecord(record?.payload)
  return recordContext('Codex', [
    ['record', record?.type],
    ['payload', payload?.type],
    ['role', payload?.role],
    ['blocks', contentBlockTypes(payload?.content)]
  ])
}

export function createClaudeObservationView(rawContent: string): ObservationView {
  return jsonlView(rawContent, 'claude-jsonl-v2', claudeRecordContext)
}

export function createPiObservationView(rawContent: string): ObservationView {
  return jsonlView(rawContent, 'pi-jsonl-v2', piRecordContext)
}

export function createCodexObservationView(rawContent: string): ObservationView {
  return jsonlView(rawContent, 'codex-jsonl-v2', codexRecordContext)
}

import type { ObservationUnit, ObservationView } from '../observation/model'
import {
  MAX_OBSERVATION_UNIT_BYTES,
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
    ['role', payload?.role ?? record?.role],
    ['blocks', contentBlockTypes(payload?.content ?? record?.content)]
  ])
}

const CODEX_EXCLUDED_RECORD_TYPES = new Set([
  'compacted',
  'inter_agent_communication_metadata',
  'session_meta',
  'turn_context',
  'world_state'
])

const CODEX_EXCLUDED_EVENT_TYPES = new Set([
  // Execution events either duplicate a canonical tool record or are runtime telemetry.
  'agent_reasoning',
  'context_compacted',
  'mcp_tool_call_end',
  'patch_apply_end',
  'sub_agent_activity',
  'task_complete',
  'task_started',
  'thread_settings_applied',
  'token_count',
  'web_search_end'
])

const CODEX_COMPACT_TEXT_BYTES = 1_024
const CODEX_SUBAGENT_TEXT_BYTES = 1_024
const CODEX_MODEL_CONTENT_BYTES = MAX_OBSERVATION_UNIT_BYTES

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function boundedText(value: string, maximumBytes: number): string {
  const sourceBytes = utf8Bytes(value)
  if (sourceBytes <= maximumBytes) return value
  const omission = `\n… source shortened from ${sourceBytes} bytes; expand the cited raw line for detail …\n`
  const contentBudget = Math.max(0, maximumBytes - utf8Bytes(omission))
  const prefixBudget = Math.ceil(contentBudget * 0.65)
  const suffixBudget = contentBudget - prefixBudget
  let prefix = ''
  let prefixBytes = 0
  for (const character of value) {
    const bytes = utf8Bytes(character)
    if (prefixBytes + bytes > prefixBudget) break
    prefix += character
    prefixBytes += bytes
  }
  let suffix = ''
  let suffixBytes = 0
  for (let index = value.length; index > 0;) {
    let start = index - 1
    const codeUnit = value.charCodeAt(start)
    if (
      codeUnit >= 0xdc00
      && codeUnit <= 0xdfff
      && start > 0
      && value.charCodeAt(start - 1) >= 0xd800
      && value.charCodeAt(start - 1) <= 0xdbff
    ) {
      start--
    }
    const character = value.slice(start, index)
    const bytes = utf8Bytes(character)
    if (suffixBytes + bytes > suffixBudget) break
    suffix = character + suffix
    suffixBytes += bytes
    index = start
  }
  return `${prefix}${omission}${suffix}`
}

function modelText(value: string, maximumBytes: number): string {
  return boundedText(
    value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '�'),
    maximumBytes
  )
}

function serializedValue(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function parseJsonString(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function textBlocks(value: unknown): string[] {
  if (!Array.isArray(value)) return typeof value === 'string' ? [value] : []
  return value.flatMap((item) => {
    const block = asRecord(item)
    if (!block) return []
    for (const key of ['text', 'message', 'content']) {
      if (typeof block[key] === 'string') return [block[key] as string]
    }
    return []
  })
}

function compactModelRecord(value: Record<string, unknown>): string {
  const serialized = JSON.stringify(value)
  if (utf8Bytes(serialized) <= CODEX_MODEL_CONTENT_BYTES) return serialized
  return JSON.stringify({
    kind: value.kind,
    ...(typeof value.tool === 'string' ? { tool: value.tool } : {}),
    ...(typeof value.callId === 'string' ? { callId: value.callId } : {}),
    ...(typeof value.outputBytes === 'number' ? { outputBytes: value.outputBytes } : {}),
    representationOmitted: true,
    rawDetailAvailable: true
  })
}

function shortString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim()
    ? modelText(value, 256)
    : undefined
}

function toolName(payload: Record<string, unknown>): string | undefined {
  const name = sourceToken(payload.name)
  const namespace = sourceToken(payload.namespace)
  return name ? [namespace, name].filter(Boolean).join('.') : undefined
}

function compactToolCall(payload: Record<string, unknown>): string {
  const input = payload.input ?? payload.arguments
  return compactModelRecord({
    kind: 'tool_call',
    ...(toolName(payload) ? { tool: toolName(payload) } : {}),
    ...(sourceToken(payload.call_id) ? { callId: payload.call_id } : {}),
    ...(sourceToken(payload.status) ? { status: payload.status } : {}),
    ...(input !== undefined
      ? { input: modelText(serializedValue(parseJsonString(input)), CODEX_COMPACT_TEXT_BYTES) }
      : {}),
    rawDetailAvailable: true
  })
}

function outputStatus(value: unknown): Record<string, unknown> {
  const record = asRecord(parseJsonString(value))
  if (!record) return {}
  const status: Record<string, unknown> = {}
  for (const key of ['status', 'success', 'exit_code', 'timed_out', 'isError']) {
    const field = record[key]
    if (typeof field === 'string' || typeof field === 'number' || typeof field === 'boolean') {
      status[key] = field
    }
  }
  return status
}

function compactToolOutput(
  payload: Record<string, unknown>,
  toolsByCallId: Map<string, string>
): string {
  const output = payload.output
  const callId = sourceToken(payload.call_id)
  const serializedOutput = serializedValue(output)
  const outputText = textBlocks(output).join('\n') || serializedOutput
  return compactModelRecord({
    kind: 'tool_result',
    ...(callId ? { callId } : {}),
    ...(callId && toolsByCallId.get(callId) ? { tool: toolsByCallId.get(callId) } : {}),
    ...outputStatus(output),
    outputBytes: utf8Bytes(serializedOutput),
    ...(outputText ? { outcomePreview: modelText(outputText, CODEX_COMPACT_TEXT_BYTES) } : {}),
    rawDetailAvailable: true
  })
}

function compactSubagentMessage(payload: Record<string, unknown>): string {
  const plaintext = textBlocks(payload.content).join('\n')
  return compactModelRecord({
    kind: 'subagent_message',
    ...(shortString(payload.author) ? { author: shortString(payload.author) } : {}),
    ...(shortString(payload.recipient) ? { recipient: shortString(payload.recipient) } : {}),
    ...(plaintext ? { message: modelText(plaintext, CODEX_SUBAGENT_TEXT_BYTES) } : {}),
    rawDetailAvailable: true
  })
}

function compactTurnAborted(payload: Record<string, unknown>): string {
  return compactModelRecord({
    kind: 'turn_aborted',
    ...(sourceToken(payload.turn_id) ? { turnId: payload.turn_id } : {}),
    ...(typeof payload.reason === 'string'
      ? { reason: modelText(payload.reason, CODEX_COMPACT_TEXT_BYTES) }
      : {})
  })
}

function compactUnknownRecord(record: Record<string, unknown>): string {
  const payload = asRecord(record.payload)
  return compactModelRecord({
    kind: 'unrecognized_codex_record',
    ...(sourceToken(record.type) ? { recordType: record.type } : {}),
    ...(sourceToken(payload?.type) ? { payloadType: payload?.type } : {}),
    payloadKeys: payload ? Object.keys(payload).sort().slice(0, 24) : [],
    rawDetailAvailable: true
  })
}

function exactCodexUnits(line: string, lineNumber: number): ObservationUnit[] {
  return createObservationViewFromLines(
    [line],
    'codex-record',
    (rawLine): ObservationLineFraming => ({
      preferredBreaks: jsonSyntaxBreaks(rawLine),
      adjustBoundary: jsonSafeBoundary,
      recordContext: codexRecordContext(parsedRecord(rawLine))
    })
  ).units.map((unit) => ({ ...unit, lineNumber }))
}

function compactCodexUnit(
  line: string,
  lineNumber: number,
  modelContent: string,
  contextValues: Array<[string, unknown]>
): ObservationUnit {
  return {
    lineNumber,
    content: line,
    startCharacter: 0,
    endCharacter: line.length,
    totalCharacters: line.length,
    modelContent,
    recordContext: recordContext('Codex', contextValues)
  }
}

type CodexConversationRole = 'user' | 'assistant'

interface CodexUnitCandidate {
  units: ObservationUnit[]
  /** Event messages are used only when this Session has no canonical records for the role. */
  fallbackRole?: CodexConversationRole
}

function codexUnits(rawLines: string[]): ObservationUnit[] {
  const toolsByCallId = new Map<string, string>()
  const canonicalRoles = new Set<CodexConversationRole>()
  const candidates = rawLines.flatMap((line, index): CodexUnitCandidate[] => {
    if (!line.trim()) return []
    const lineNumber = index + 1
    const record = parsedRecord(line)
    if (!record) return [{ units: exactCodexUnits(line, lineNumber) }]

    const type = sourceToken(record.type)
    if (type && CODEX_EXCLUDED_RECORD_TYPES.has(type)) return []
    const payload = asRecord(record.payload)
    if (!type && (record.role === 'user' || record.role === 'assistant')) {
      canonicalRoles.add(record.role)
      return [{ units: exactCodexUnits(line, lineNumber) }]
    }
    if (!type && (record.role === 'developer' || record.role === 'system')) return []
    if (type === 'event_msg') {
      const eventType = sourceToken(payload?.type)
      if (!payload || (eventType && CODEX_EXCLUDED_EVENT_TYPES.has(eventType))) return []
      if (eventType === 'user_message' || eventType === 'agent_message') {
        return [{
          units: exactCodexUnits(line, lineNumber),
          fallbackRole: eventType === 'user_message' ? 'user' : 'assistant'
        }]
      }
      if (eventType === 'turn_aborted') {
        return [{
          units: [compactCodexUnit(
            line,
            lineNumber,
            compactTurnAborted(payload),
            [['record', 'event'], ['event', eventType]]
          )]
        }]
      }
      return [{
        units: [compactCodexUnit(
          line,
          lineNumber,
          compactUnknownRecord(record),
          [['record', 'event'], ['event', eventType]]
        )]
      }]
    }

    if (type === 'response_item' && payload) {
      if (payload.type === 'message') {
        if (payload.role !== 'user' && payload.role !== 'assistant') return []
        canonicalRoles.add(payload.role)
        return [{ units: exactCodexUnits(line, lineNumber) }]
      }
      if (payload.type === 'reasoning') return []
      if (payload.type === 'custom_tool_call' || payload.type === 'function_call') {
        const name = toolName(payload)
        const callId = sourceToken(payload.call_id)
        if (callId && name) toolsByCallId.set(callId, name)
        return [{
          units: [compactCodexUnit(
            line,
            lineNumber,
            compactToolCall(payload),
            [['record', 'tool_call'], ['tool', name]]
          )]
        }]
      }
      if (payload.type === 'custom_tool_call_output' || payload.type === 'function_call_output') {
        const callId = sourceToken(payload.call_id)
        const name = callId ? toolsByCallId.get(callId) : undefined
        return [{
          units: [compactCodexUnit(
            line,
            lineNumber,
            compactToolOutput(payload, toolsByCallId),
            [['record', 'tool_result'], ['tool', name]]
          )]
        }]
      }
      if (payload.type === 'agent_message') {
        return [{
          units: [compactCodexUnit(
            line,
            lineNumber,
            compactSubagentMessage(payload),
            [['record', 'subagent_message'], ['author', payload.author], ['recipient', payload.recipient]]
          )]
        }]
      }
    }

    return [{
      units: [compactCodexUnit(
        line,
        lineNumber,
        compactUnknownRecord(record),
        [['record', type], ['payload', payload?.type]]
      )]
    }]
  })
  return candidates.flatMap((candidate) => (
    candidate.fallbackRole && canonicalRoles.has(candidate.fallbackRole)
      ? []
      : candidate.units
  ))
}

export function createClaudeObservationView(rawContent: string): ObservationView {
  return jsonlView(rawContent, 'claude-jsonl-v2', claudeRecordContext)
}

export function createPiObservationView(rawContent: string): ObservationView {
  return jsonlView(rawContent, 'pi-jsonl-v2', piRecordContext)
}

export function createCodexObservationView(rawContent: string): ObservationView {
  const rawLines = rawContent.split(/\r\n|\r|\n/)
  return {
    formatVersion: 'codex-jsonl-v3',
    rawLines,
    units: codexUnits(rawLines)
  }
}

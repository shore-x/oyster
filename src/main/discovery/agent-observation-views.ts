import type { ObservationUnit, ObservationView } from '../observation/model'
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

/** Adapter-private navigation metadata, not a persisted fact or cross-Harness schema. */
interface SkillHint {
  name?: string
  tool?: string
  source: 'runtime_injection' | 'tool_call'
}

function skillName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const name = value.trim()
  return sourceToken(name)
}

function skillDocumentName(value: unknown, depth = 0): string | undefined {
  if (depth > 6) return undefined
  if (typeof value === 'string') {
    return skillName(value.match(/(?:^|[\\/])([a-zA-Z0-9._-]{1,64})[\\/]SKILL\.md(?=$|[\s"',;)}\]])/)?.[1])
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const name = skillDocumentName(item, depth + 1)
      if (name) return name
    }
    return undefined
  }
  const record = asRecord(value)
  if (!record) return undefined
  for (const item of Object.values(record)) {
    const name = skillDocumentName(item, depth + 1)
    if (name) return name
  }
  return undefined
}

function contentTexts(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const block = asRecord(item)
    return typeof block?.text === 'string' ? [block.text] : []
  })
}

function injectedSkillName(value: unknown): string | undefined {
  for (const text of contentTexts(value)) {
    const injection = text.trim()
    if (!/^<skill(?:\s[^>]*)?>[\s\S]*<\/skill>$/i.test(injection)) continue
    const attributeName = skillName(injection.match(/^<skill\b[^>]*\bname=["']([^"']+)["'][^>]*>/i)?.[1])
    if (attributeName) return attributeName
    const elementName = skillName(injection.match(/<name>([^<]+)<\/name>/i)?.[1])
    if (elementName) return elementName
  }
  return undefined
}

function isReadTool(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const normalized = value.toLowerCase().replace(/[^a-z]/g, '')
  return normalized === 'read' || normalized === 'readfile'
}

function nativeSkillToolHint(block: Record<string, unknown>): SkillHint | undefined {
  const tool = sourceToken(block.name)
  if (!tool || tool.toLowerCase() !== 'skill') return undefined
  const input = asRecord(block.input ?? block.arguments)
  return {
    name: skillName(input?.skill ?? input?.name),
    tool,
    source: 'tool_call'
  }
}

function skillReadToolHint(block: Record<string, unknown>): SkillHint | undefined {
  const tool = sourceToken(block.name)
  if (!tool || !isReadTool(tool)) return undefined
  const name = skillDocumentName(block.input ?? block.arguments)
  return name ? { name, tool, source: 'tool_call' } : undefined
}

function claudeSkillHint(record: Record<string, unknown> | undefined): SkillHint | undefined {
  const message = asRecord(record?.message)
  if (!message) return undefined
  if (message.role === 'user') {
    const name = injectedSkillName(message.content)
    if (name) return { name, source: 'runtime_injection' }
  }
  if (!Array.isArray(message.content)) return undefined
  for (const item of message.content) {
    const block = asRecord(item)
    if (block?.type !== 'tool_use') continue
    const hint = nativeSkillToolHint(block) ?? skillReadToolHint(block)
    if (hint) return hint
  }
  return undefined
}

function piSkillHint(record: Record<string, unknown> | undefined): SkillHint | undefined {
  const message = asRecord(record?.message)
  const role = record?.role ?? message?.role
  const content = record?.content ?? message?.content
  if (role === 'user') {
    const name = injectedSkillName(content)
    if (name) return { name, source: 'runtime_injection' }
  }
  if (!Array.isArray(content)) return undefined
  for (const item of content) {
    const block = asRecord(item)
    if (block?.type !== 'toolCall') continue
    const hint = nativeSkillToolHint(block) ?? skillReadToolHint(block)
    if (hint) return hint
  }
  return undefined
}

function codexSkillHint(payload: Record<string, unknown>): SkillHint | undefined {
  if (payload.role === 'user') {
    const name = injectedSkillName(payload.content)
    if (name) return { name, source: 'runtime_injection' }
  }

  const payloadType = typeof payload.type === 'string'
    ? payload.type.toLowerCase().replace(/[^a-z]/g, '')
    : ''
  if (!payloadType.includes('toolcall') && payloadType !== 'functioncall') return undefined
  const tool = sourceToken(payload.name)
  if (tool?.toLowerCase() === 'skill') {
    const input = asRecord(payload.input ?? payload.arguments)
    return {
      name: skillName(input?.skill ?? input?.name),
      tool,
      source: 'tool_call'
    }
  }
  const name = skillDocumentName(payload.input ?? payload.arguments)
  return name ? { name, ...(tool ? { tool } : {}), source: 'tool_call' } : undefined
}

function skillHintContext(hint: SkillHint | undefined): string | undefined {
  return hint ? hint.name ?? 'detected' : undefined
}

function skillHintModelContent(hint: SkillHint): string {
  return JSON.stringify({
    kind: 'skill_activation_hint',
    source: hint.source,
    ...(hint.name ? { name: hint.name } : {}),
    ...(hint.tool ? { tool: hint.tool } : {})
  })
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
  const hint = claudeSkillHint(record)
  return recordContext('Claude', [
    ['record', record?.type],
    ['role', message?.role],
    ['blocks', contentBlockTypes(message?.content)],
    ['skill_hint', skillHintContext(hint)]
  ])
}

function piRecordContext(record: Record<string, unknown> | undefined): string {
  const message = asRecord(record?.message)
  const hint = piSkillHint(record)
  return recordContext('Pi', [
    ['record', record?.type],
    ['role', record?.role ?? message?.role],
    ['blocks', contentBlockTypes(record?.content ?? message?.content)],
    ['skill_hint', skillHintContext(hint)]
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

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function codexWorkingDirectory(payload: Record<string, unknown> | undefined): string | undefined {
  if (typeof payload?.cwd !== 'string') return undefined
  const cwd = payload.cwd.trim()
  return cwd && utf8Bytes(cwd) <= 1_024 && !/[\r\n\u0000-\u001f\u007f]/.test(cwd)
    ? cwd
    : undefined
}

/** These are Codex-injected user records, not messages authored by the person. */
function isCodexRuntimeScaffold(payload: Record<string, unknown>): boolean {
  if (!Array.isArray(payload.content) || payload.content.length === 0) return false
  const texts = payload.content.map((item) => {
    const block = asRecord(item)
    return block?.type === 'input_text' && typeof block.text === 'string'
      ? block.text.trim()
      : undefined
  })
  if (texts.some((text) => text === undefined)) return false
  return texts.every((text) => (
    /^# AGENTS\.md instructions for [^\r\n]+\r?\n\r?\n<INSTRUCTIONS>[\s\S]*<\/INSTRUCTIONS>$/.test(text!)
    || /^<environment_context>[\s\S]*<\/environment_context>$/.test(text!)
  ))
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
  const canonicalRoles = new Set<CodexConversationRole>()
  let lastWorkingDirectory: string | undefined
  const candidates = rawLines.flatMap((line, index): CodexUnitCandidate[] => {
    if (!line.trim()) return []
    const lineNumber = index + 1
    const record = parsedRecord(line)
    if (!record) return [{ units: exactCodexUnits(line, lineNumber) }]

    const type = sourceToken(record.type)
    const payload = asRecord(record.payload)
    if (type === 'session_meta' || type === 'turn_context') {
      const workingDirectory = codexWorkingDirectory(payload)
      if (!workingDirectory || workingDirectory === lastWorkingDirectory) return []
      lastWorkingDirectory = workingDirectory
      return [{
        units: [compactCodexUnit(
          line,
          lineNumber,
          JSON.stringify({ kind: 'session_context', workingDirectory }),
          [['record', 'session_context']]
        )]
      }]
    }
    if (!type && (record.role === 'user' || record.role === 'assistant')) {
      if (record.role === 'user' && isCodexRuntimeScaffold(record)) return []
      const hint = codexSkillHint(record)
      if (hint) {
        return [{
          units: [compactCodexUnit(
            line,
            lineNumber,
            skillHintModelContent(hint),
            [['record', 'skill_hint'], ['skill_hint', skillHintContext(hint)]]
          )]
        }]
      }
      canonicalRoles.add(record.role)
      return [{ units: exactCodexUnits(line, lineNumber) }]
    }
    if (type === 'event_msg') {
      const eventType = sourceToken(payload?.type)
      if (!payload) return []
      if (eventType === 'user_message' || eventType === 'agent_message') {
        return [{
          units: exactCodexUnits(line, lineNumber),
          fallbackRole: eventType === 'user_message' ? 'user' : 'assistant'
        }]
      }
      return []
    }

    if (type === 'response_item' && payload) {
      const hint = codexSkillHint(payload)
      if (hint) {
        return [{
          units: [compactCodexUnit(
            line,
            lineNumber,
            skillHintModelContent(hint),
            [
              ['record', type],
              ['payload', payload.type],
              ['skill_hint', skillHintContext(hint)]
            ]
          )]
        }]
      }
      if (payload.type === 'message') {
        if (payload.role !== 'user' && payload.role !== 'assistant') return []
        if (payload.role === 'user' && isCodexRuntimeScaffold(payload)) return []
        canonicalRoles.add(payload.role)
        return [{ units: exactCodexUnits(line, lineNumber) }]
      }
    }
    return []
  })
  return candidates.flatMap((candidate) => (
    candidate.fallbackRole && canonicalRoles.has(candidate.fallbackRole)
      ? []
      : candidate.units
  ))
}

export function createClaudeObservationView(rawContent: string): ObservationView {
  return jsonlView(rawContent, 'claude-jsonl-v3', claudeRecordContext)
}

export function createPiObservationView(rawContent: string): ObservationView {
  return jsonlView(rawContent, 'pi-jsonl-v3', piRecordContext)
}

export function createCodexObservationView(rawContent: string): ObservationView {
  const rawLines = rawContent.split(/\r\n|\r|\n/)
  return {
    formatVersion: 'codex-jsonl-v5',
    rawLines,
    units: codexUnits(rawLines)
  }
}

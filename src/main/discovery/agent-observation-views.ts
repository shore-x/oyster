import { createHash } from 'node:crypto'
import type {
  AgentObservation,
  CanonicalActivity,
  CanonicalActivityAttachment,
  CanonicalActivityItem,
  CanonicalActivityKind,
  EvidenceRange,
  RawEvidence,
  RawEvidenceSkillHint
} from '../observation/model'

const MAX_INLINE_ACTIVITY_PAYLOAD_CHARACTERS = 512

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

interface SkillHint {
  name?: string
  tool?: string
  source: RawEvidenceSkillHint['source']
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

const CODEX_RUNTIME_MESSAGE_PATTERNS = [
  /^# AGENTS\.md instructions for (?:.|\n)+/i,
  /^<environment_context(?:\s[^>]*)?>/i,
  /^<permissions instructions>/i,
  /^<app-context>/i,
  /^<skills_instructions>/i,
  /^<collaboration_mode>/i,
  /^<multi_agent_mode>/i,
  /^<recommended_plugins>/i,
  /^Another language model started to solve this problem and produced a summary/i
] as const

/** Codex records runtime envelopes as user-role messages; they are not authored dialogue. */
export function isCodexRuntimeInjectedMessage(value: unknown): boolean {
  const text = contentTexts(value).join('\n').trim()
  return Boolean(text) && CODEX_RUNTIME_MESSAGE_PATTERNS.some((pattern) => pattern.test(text))
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

function toolSkillHint(block: Record<string, unknown>): SkillHint | undefined {
  const tool = sourceToken(block.name)
  if (!tool) return undefined
  if (tool.toLowerCase() === 'skill') {
    const input = asRecord(block.input ?? block.arguments)
    return {
      name: skillName(input?.skill ?? input?.name),
      tool,
      source: 'tool_call'
    }
  }
  if (!isReadTool(tool)) return undefined
  const name = skillDocumentName(block.input ?? block.arguments)
  return name ? { name, tool, source: 'tool_call' } : undefined
}

function contentSkillHint(content: unknown): SkillHint | undefined {
  if (!Array.isArray(content)) return undefined
  for (const item of content) {
    const block = asRecord(item)
    if (!block || (block.type !== 'tool_use' && block.type !== 'toolCall')) continue
    const hint = toolSkillHint(block)
    if (hint) return hint
  }
  return undefined
}

function claudeSkillHint(record: Record<string, unknown>): SkillHint | undefined {
  const message = asRecord(record.message)
  if (!message) return undefined
  if (message.role === 'user') {
    const name = injectedSkillName(message.content)
    if (name) return { name, source: 'runtime_injection' }
  }
  return contentSkillHint(message.content)
}

function piSkillHint(record: Record<string, unknown>): SkillHint | undefined {
  const message = asRecord(record.message)
  const role = record.role ?? message?.role
  const content = record.content ?? message?.content
  if (role === 'user') {
    const name = injectedSkillName(content)
    if (name) return { name, source: 'runtime_injection' }
  }
  return contentSkillHint(content)
}

function codexSkillHint(record: Record<string, unknown>): SkillHint | undefined {
  const payload = asRecord(record.payload) ?? record
  if (payload.role === 'user') {
    const name = injectedSkillName(payload.content)
    if (name) return { name, source: 'runtime_injection' }
  }
  if (payload.type === 'user_message') {
    const name = injectedSkillName(payload.message)
    if (name) return { name, source: 'runtime_injection' }
  }
  const payloadType = typeof payload.type === 'string'
    ? payload.type.toLowerCase().replace(/[^a-z]/g, '')
    : ''
  if (!payloadType.includes('toolcall') && payloadType !== 'functioncall') return undefined
  return toolSkillHint(payload)
}

function parsedRecord(line: string): Record<string, unknown> | undefined {
  if (!line.trim()) return undefined
  try {
    return asRecord(JSON.parse(line))
  } catch {
    return undefined
  }
}

function rawEvidence(
  rawContent: string,
  formatVersion: string,
  detect: (record: Record<string, unknown>) => SkillHint | undefined
): RawEvidence {
  const lines = rawContent.split(/\r\n|\r|\n/)
  const skillHints = lines.flatMap((line, index): RawEvidenceSkillHint[] => {
    const record = parsedRecord(line)
    const hint = record ? detect(record) : undefined
    if (!hint) return []
    const nameOffset = hint.name ? line.indexOf(hint.name) : -1
    return [{
      location: { line: index + 1, offset: Math.max(0, nameOffset) },
      ...(hint.name ? { name: hint.name } : {}),
      ...(hint.tool ? { tool: hint.tool } : {}),
      source: hint.source
    }]
  })
  return { formatVersion, lines, skillHints }
}

interface ProjectionBuilder {
  items: CanonicalActivityItem[]
  attachments: CanonicalActivityAttachment[]
  nextAttachment: number
  codexToolCalls: Map<string, string>
  mirrorable: Array<{
    item: CanonicalActivityItem
    kind: CanonicalActivityKind
    content: string
    line: number
    source: 'primary' | 'event'
  }>
}

interface ParsedProjectionRecord {
  record?: Record<string, unknown>
  range: EvidenceRange
  lineIndex: number
  rawLine: string
}

interface TreeProjectionRecord extends ParsedProjectionRecord {
  id: string
  parentId?: string
}

interface ProjectionSection {
  label: 'active' | 'alternate'
  records: ParsedProjectionRecord[]
  warning?: string
}

interface AttachmentCapture {
  id: string
  field: string
  mimeType: string
  byteLength: number
  sha256: string
}

function physicalLineRange(lines: readonly string[], index: number): EvidenceRange {
  return {
    start: { line: index + 1, offset: 0 },
    end: { line: index + 1, offset: lines[index].length }
  }
}

function parsedProjectionRecords(lines: readonly string[]): ParsedProjectionRecord[] {
  return lines.map((rawLine, lineIndex) => {
    const record = parsedRecord(rawLine)
    return {
      ...(record ? { record } : {}),
      range: physicalLineRange(lines, lineIndex),
      lineIndex,
      rawLine
    }
  })
}

function treeProjectionSections(
  records: readonly ParsedProjectionRecord[],
  idField: string,
  parentIdField: string,
  preferredLeafId?: string,
  isTreeRecord: (record: Record<string, unknown>) => boolean = () => true,
  isFallbackLeaf: (record: Record<string, unknown>) => boolean = () => true
): ProjectionSection[] {
  const treeRecords = records.flatMap((entry): TreeProjectionRecord[] => {
    if (!entry.record || !isTreeRecord(entry.record)) return []
    const id = sourceToken(entry.record?.[idField])
    if (!id) return []
    const parentId = sourceToken(entry.record?.[parentIdField])
    return [{ ...entry, id, ...(parentId ? { parentId } : {}) }]
  })
  if (!treeRecords.length) return [{ label: 'active', records: [...records] }]

  const byId = new Map<string, TreeProjectionRecord>()
  let valid = true
  for (const entry of treeRecords) {
    if (byId.has(entry.id)) valid = false
    byId.set(entry.id, entry)
  }
  const resolved = new Set<string>()
  for (const entry of treeRecords) {
    if (resolved.has(entry.id)) continue
    const chain: TreeProjectionRecord[] = []
    const chainIds = new Set<string>()
    let candidate: TreeProjectionRecord | undefined = entry
    while (candidate && !resolved.has(candidate.id)) {
      if (chainIds.has(candidate.id)) {
        valid = false
        break
      }
      chainIds.add(candidate.id)
      chain.push(candidate)
      if (!candidate.parentId) break
      candidate = byId.get(candidate.parentId)
      if (!candidate) valid = false
    }
    chain.forEach((item) => resolved.add(item.id))
  }
  const preferredLeaf = preferredLeafId ? byId.get(preferredLeafId) : undefined
  const leaf = preferredLeaf
    ?? [...treeRecords].reverse().find((entry) => entry.record && isFallbackLeaf(entry.record))
  if (!leaf) valid = false
  const activeReverse: TreeProjectionRecord[] = []
  const visited = new Set<string>()
  let current: TreeProjectionRecord | undefined = leaf
  while (current) {
    if (visited.has(current.id)) {
      valid = false
      break
    }
    visited.add(current.id)
    activeReverse.push(current)
    if (!current.parentId) break
    current = byId.get(current.parentId)
    if (!current) valid = false
  }
  if (!valid) return [{
    label: 'active',
    records: [...records],
    warning: 'Conversation branches could not be reconstructed from the source IDs. Records follow physical source order.'
  }]

  const active = activeReverse.reverse()
  const activeLines = new Set(active.map((entry) => entry.lineIndex))
  const treeLines = new Set(treeRecords.map((entry) => entry.lineIndex))
  const nonTreeRecords = records.filter((entry) => !treeLines.has(entry.lineIndex))
  const alternate = treeRecords.filter((entry) => !activeLines.has(entry.lineIndex))
  return [
    { label: 'active', records: [...nonTreeRecords, ...active].sort((left, right) => left.lineIndex - right.lineIndex) },
    ...(alternate.length ? [{ label: 'alternate' as const, records: alternate }] : [])
  ]
}

function readableText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  const record = asRecord(value)
  return typeof record?.text === 'string'
    ? record.text
    : typeof record?.thinking === 'string'
      ? record.thinking
      : undefined
}

function compactRecord(value: Record<string, unknown>, omitted: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !omitted.includes(key)))
}

function parseStructuredString(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function compactActivityPayload(value: string): string {
  if (value.length <= MAX_INLINE_ACTIVITY_PAYLOAD_CHARACTERS) return value
  const headLength = Math.floor(MAX_INLINE_ACTIVITY_PAYLOAD_CHARACTERS * 0.75)
  const tailLength = MAX_INLINE_ACTIVITY_PAYLOAD_CHARACTERS - headLength
  const omitted = value.length - headLength - tailLength
  return [
    value.slice(0, headLength),
    `[Canonical Activity omitted ${omitted} of ${value.length} payload characters. Full normalized payload SHA-256: ${createHash('sha256').update(value).digest('hex')}. Use the Raw source locator in the Task input for exact content.]`,
    value.slice(-tailLength)
  ].join('\n')
}

function unwrappedToolResult(value: unknown): unknown {
  const parsed = typeof value === 'string' ? parseStructuredString(value) : value
  const record = asRecord(parsed)
  if (!record || record.content === undefined) return parsed
  const texts = contentTexts(record.content)
  const onlyText = typeof record.content === 'string'
    || (Array.isArray(record.content) && record.content.every((entry) => (
      typeof entry === 'string' || typeof asRecord(entry)?.text === 'string'
    )))
  if (onlyText && texts.length) return texts.join('\n')
  return record.content
}

function attachmentDescriptor(capture: AttachmentCapture): string {
  return [
    `[Attachment ${capture.id}]`,
    `Media type: ${capture.mimeType}`,
    `Bytes: ${capture.byteLength}`,
    `SHA-256: ${capture.sha256}`,
    `Source field: ${capture.field}`,
    capture.mimeType.startsWith('image/')
      ? `Inspect the ${capture.id} file materialized in the Task input with the ordinary read tool.`
      : 'This attachment type is opaque to the current Maintainer runtime; use the Raw source locator for provenance.'
  ].join('\n')
}

function captureAttachment(
  builder: ProjectionBuilder,
  range: EvidenceRange,
  mimeType: string,
  encodedData: string,
  field: string
): AttachmentCapture {
  const data = encodedData.replace(/\s/g, '')
  const bytes = Buffer.from(data, 'base64')
  const capture: AttachmentCapture = {
    id: `ATT${String(builder.nextAttachment++).padStart(6, '0')}`,
    field,
    mimeType,
    byteLength: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex')
  }
  builder.attachments.push({
    id: capture.id,
    mimeType,
    data,
    byteLength: capture.byteLength,
    sha256: capture.sha256,
    rawRange: range
  })
  return capture
}

function sanitizedValue(
  builder: ProjectionBuilder,
  range: EvidenceRange,
  value: unknown,
  field: string,
  captures: AttachmentCapture[]
): unknown {
  if (typeof value === 'string') {
    const dataUri = value.match(/^data:([^;,]+);base64,([\s\S]*)$/)
    if (dataUri) {
      const capture = captureAttachment(builder, range, dataUri[1], dataUri[2], field)
      captures.push(capture)
      return `[Attachment ${capture.id}]`
    }
    return value
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => sanitizedValue(
      builder,
      range,
      entry,
      `${field}[${index}]`,
      captures
    ))
  }
  const record = asRecord(value)
  if (!record) return value
  const attachment = blockAttachment(builder, range, record, field)
  if (attachment) {
    captures.push(attachment)
    return `[Attachment ${attachment.id}]`
  }
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => {
    const path = field ? `${field}.${key}` : key
    if (key === 'encrypted_content' && typeof entry === 'string') {
      return [key, `[Opaque encrypted payload: ${entry.length} characters; sha256=${createHash('sha256').update(entry).digest('hex')}]`]
    }
    return [key, sanitizedValue(builder, range, entry, path, captures)]
  }))
}

function formattedValue(
  builder: ProjectionBuilder,
  range: EvidenceRange,
  value: unknown,
  field = ''
): { text: string; captures: AttachmentCapture[] } {
  const captures: AttachmentCapture[] = []
  const normalized = sanitizedValue(builder, range, value, field, captures)
  const text = typeof normalized === 'string'
    ? normalized
    : JSON.stringify(normalized, null, 2)
  return {
    text: compactActivityPayload(text),
    captures
  }
}

function addItem(
  builder: ProjectionBuilder,
  kind: CanonicalActivityKind,
  content: string,
  range: EvidenceRange,
  attachmentId?: string
): CanonicalActivityItem | undefined {
  if (!content.trim()) return undefined
  const item: CanonicalActivityItem = {
    kind,
    content,
    rawRanges: [range],
    ...(attachmentId ? { attachmentId } : {})
  }
  builder.items.push(item)
  return item
}

function addCapturedAttachments(
  builder: ProjectionBuilder,
  captures: readonly AttachmentCapture[],
  range: EvidenceRange
): void {
  for (const capture of captures) {
    addItem(
      builder,
      'attachment',
      attachmentDescriptor(capture),
      range,
      capture.mimeType.startsWith('image/') ? capture.id : undefined
    )
  }
}

function addValueItem(
  builder: ProjectionBuilder,
  kind: CanonicalActivityKind,
  heading: string,
  value: unknown,
  range: EvidenceRange,
  field = ''
): void {
  const formatted = formattedValue(builder, range, value, field)
  addItem(builder, kind, [heading, formatted.text].filter(Boolean).join('\n'), range)
  addCapturedAttachments(builder, formatted.captures, range)
}

function addUnparseableRecord(
  projection: ProjectionBuilder,
  dialect: 'Claude' | 'Pi' | 'Codex',
  line: string,
  range: EvidenceRange
): void {
  addItem(projection, 'unknown', [
    `Unparseable ${dialect} JSONL record (opaque).`,
    `Characters: ${line.length}`,
    `UTF-8 bytes: ${Buffer.byteLength(line, 'utf8')}`,
    `SHA-256: ${createHash('sha256').update(line).digest('hex')}`,
    'Use this activity\'s Raw source locator in the Task input to inspect the exact content.'
  ].join('\n'), range)
}

function addMirrorableItem(
  builder: ProjectionBuilder,
  kind: Extract<CanonicalActivityKind, 'user_message' | 'assistant_message'>,
  content: string,
  range: EvidenceRange,
  source: 'primary' | 'event'
): void {
  if (!content.trim()) return
  const line = range.start.line
  const mirror = [...builder.mirrorable].reverse().find((candidate) => (
    candidate.kind === kind
    && candidate.content === content
    && candidate.source !== source
    && Math.abs(candidate.line - line) <= 3
  ))
  if (mirror) {
    mirror.item.rawRanges.push(range)
    return
  }
  const item = addItem(builder, kind, content, range)
  if (item) builder.mirrorable.push({ item, kind, content, line, source })
}

function addDeduplicatedItem(
  builder: ProjectionBuilder,
  contents: Map<string, CanonicalActivityItem>,
  kind: CanonicalActivityKind,
  content: string,
  range: EvidenceRange
): void {
  const previous = contents.get(content)
  if (previous) {
    previous.rawRanges.push(range)
    return
  }
  const item = addItem(builder, kind, content, range)
  if (item) contents.set(content, item)
}

function builder(): ProjectionBuilder {
  return {
    items: [],
    attachments: [],
    nextAttachment: 1,
    codexToolCalls: new Map(),
    mirrorable: []
  }
}

function canonicalActivity(
  formatVersion: string,
  projection: ProjectionBuilder
): CanonicalActivity {
  return {
    formatVersion,
    items: projection.items,
    attachments: projection.attachments
  }
}

function blockAttachment(
  projection: ProjectionBuilder,
  range: EvidenceRange,
  block: Record<string, unknown>,
  field: string
): AttachmentCapture | undefined {
  if (typeof block.image_url === 'string') {
    const match = block.image_url.match(/^data:([^;,]+);base64,([\s\S]*)$/)
    if (match) return captureAttachment(projection, range, match[1], match[2], field)
  }
  const source = asRecord(block.source)
  const mimeType = typeof source?.media_type === 'string'
    ? source.media_type
    : typeof block.mimeType === 'string'
      ? block.mimeType
      : typeof block.mime_type === 'string'
        ? block.mime_type
        : undefined
  const data = typeof source?.data === 'string'
    ? source.data
    : typeof block.data === 'string'
      ? block.data
      : undefined
  return mimeType && data ? captureAttachment(projection, range, mimeType, data, field) : undefined
}

function appendMessageBlocks(
  projection: ProjectionBuilder,
  role: unknown,
  content: unknown,
  range: EvidenceRange,
  dialect: 'claude' | 'pi' | 'codex'
): void {
  if (typeof content === 'string') {
    const kind = role === 'assistant'
      ? 'assistant_message'
      : role === 'developer' || role === 'system'
        ? 'instruction'
        : 'user_message'
    if (kind === 'assistant_message' || kind === 'user_message') {
      addMirrorableItem(projection, kind, content, range, 'primary')
    } else {
      addItem(projection, kind, compactActivityPayload(content), range)
    }
    return
  }
  if (!Array.isArray(content)) return

  for (const [index, value] of content.entries()) {
    const block = asRecord(value)
    if (!block) continue
    const type = typeof block.type === 'string' ? block.type : ''
    if (type === 'text' || type === 'input_text' || type === 'output_text') {
      const text = readableText(block)
      if (!text) continue
      const kind = role === 'assistant'
        ? 'assistant_message'
        : role === 'developer' || role === 'system'
          ? 'instruction'
          : 'user_message'
      if (kind === 'assistant_message' || kind === 'user_message') {
        addMirrorableItem(projection, kind, text, range, 'primary')
      } else {
        addItem(projection, kind, compactActivityPayload(text), range)
      }
      continue
    }
    if (type === 'thinking' || type === 'reasoning' || type === 'summary_text') {
      continue
    }
    if (type === 'tool_use' || type === 'toolCall') {
      const name = typeof block.name === 'string' ? block.name : 'unknown tool'
      const id = typeof block.id === 'string' ? block.id : undefined
      const args = block.input ?? block.arguments ?? {}
      const formatted = formattedValue(projection, range, args, `content[${index}].arguments`)
      addItem(projection, 'tool_call', [
        `Tool: ${name}`,
        id ? `Call ID: ${id}` : undefined,
        'Arguments:',
        formatted.text
      ].filter((part): part is string => Boolean(part)).join('\n'), range)
      addCapturedAttachments(projection, formatted.captures, range)
      continue
    }
    if (type === 'tool_result' || type === 'toolResult') {
      const id = typeof block.tool_use_id === 'string'
        ? block.tool_use_id
        : typeof block.toolCallId === 'string'
          ? block.toolCallId
          : undefined
      const formatted = formattedValue(
        projection,
        range,
        unwrappedToolResult(block.content ?? compactRecord(block, ['type', 'tool_use_id', 'toolCallId'])),
        `content[${index}].result`
      )
      addItem(projection, 'tool_result', [
        id ? `Call ID: ${id}` : undefined,
        block.is_error === true || block.isError === true ? 'Status: error' : undefined,
        formatted.text
      ].filter((part): part is string => Boolean(part)).join('\n'), range)
      addCapturedAttachments(projection, formatted.captures, range)
      continue
    }
    if (type.includes('image')) {
      const capture = blockAttachment(projection, range, block, `content[${index}]`)
      if (capture) addCapturedAttachments(projection, [capture], range)
      else addValueItem(
        projection,
        'attachment',
        'Image reference without embedded binary data:',
        block,
        range,
        `content[${index}]`
      )
      continue
    }
    addValueItem(projection, 'unknown', `Unrecognized ${dialect} message block (${type || 'no type'}):`, block, range, `content[${index}]`)
  }
}

function projectClaudeRecord(
  projection: ProjectionBuilder,
  entry: ParsedProjectionRecord
): void {
  const { record, range, rawLine } = entry
  if (!record) {
    if (rawLine.trim()) addUnparseableRecord(projection, 'Claude', rawLine, range)
    return
  }
  const message = asRecord(record.message)
  if ((record.type === 'user' || record.type === 'assistant') && message) {
    if (message.role === 'user' && injectedSkillName(message.content)) return
    appendMessageBlocks(projection, message.role ?? record.type, message.content, range, 'claude')
    return
  }
  if (record.type === 'attachment') {
    addValueItem(projection, 'attachment', 'Claude attachment record:', record.attachment ?? record, range, 'attachment')
    return
  }
  if (record.type === 'system') {
    addValueItem(projection, 'state', 'Claude system activity:', compactRecord(record, ['type']), range)
    return
  }
  if (record.type === 'permission-mode') {
    addValueItem(projection, 'state', 'Permission mode:', compactRecord(record, ['type', 'sessionId']), range)
    return
  }
  if (record.type === 'file-history-snapshot' || record.type === 'last-prompt') {
    addValueItem(projection, 'state', `Claude ${String(record.type)}:`, compactRecord(record, ['type']), range)
    return
  }
  addValueItem(projection, 'unknown', `Unrecognized Claude record (${String(record.type ?? 'no type')}):`, record, range)
}

function projectClaude(lines: readonly string[]): CanonicalActivity {
  const projection = builder()
  const records = parsedProjectionRecords(lines)
  const preferredLeafId = [...records].reverse().flatMap((entry): string[] => {
    if (entry.record?.type !== 'last-prompt') return []
    const leafUuid = sourceToken(entry.record.leafUuid)
    return leafUuid ? [leafUuid] : []
  }).at(0)
  for (const section of treeProjectionSections(
    records,
    'uuid',
    'parentUuid',
    preferredLeafId,
    () => true,
    (record) => record.isSidechain !== true
  )) {
    if (section.warning) addItem(projection, 'state', `Claude: ${section.warning}`, section.records[0].range)
    if (section.label === 'alternate') {
      addItem(
        projection,
        'state',
        'Claude alternate or abandoned source branches follow. They remain evidence of exploration, but do not represent the active conversation path.',
        section.records[0].range
      )
    }
    section.records.forEach((entry) => projectClaudeRecord(projection, entry))
  }
  return canonicalActivity('claude-canonical-activity-v3', projection)
}

function projectPiRecord(projection: ProjectionBuilder, entry: ParsedProjectionRecord): void {
  const { record, range, rawLine } = entry
  if (!record) {
    if (rawLine.trim()) addUnparseableRecord(projection, 'Pi', rawLine, range)
    return
  }
  if (record.type === 'message') {
    const message = asRecord(record.message) ?? record
    const role = message.role ?? record.role
    const content = message.content ?? record.content
    if (role === 'user' && injectedSkillName(content)) return
    if (role === 'toolResult') {
      const formatted = formattedValue(projection, range, content ?? '', 'message.content')
      addItem(projection, 'tool_result', [
        typeof message.toolName === 'string' ? `Tool: ${message.toolName}` : undefined,
        typeof message.toolCallId === 'string' ? `Call ID: ${message.toolCallId}` : undefined,
        message.isError === true
          ? 'Status: error'
          : message.isError === false
            ? 'Status: success'
            : undefined,
        formatted.text
      ].filter((part): part is string => Boolean(part)).join('\n'), range)
      addCapturedAttachments(projection, formatted.captures, range)
      return
    }
    if (role === 'user' || role === 'assistant' || role === 'developer' || role === 'system') {
      appendMessageBlocks(projection, role, content, range, 'pi')
      if (
        role === 'assistant'
        && (message.stopReason === 'error' || message.stopReason === 'aborted' || message.errorMessage != null)
      ) {
        addValueItem(
          projection,
          'state',
          'Pi assistant execution did not produce a message:',
          compactRecord(message, ['role', 'content', 'usage']),
          range
        )
      }
      return
    }
    if (role === 'bashExecution') {
      const status = message.cancelled === true
        ? 'cancelled'
        : typeof message.exitCode === 'number'
          ? message.exitCode === 0 ? 'success' : 'error'
          : undefined
      const formatted = formattedValue(projection, range, {
        ...(typeof message.command === 'string' ? { command: message.command } : {}),
        ...(message.output !== undefined ? { output: message.output } : {}),
        ...(typeof message.exitCode === 'number' ? { exitCode: message.exitCode } : {}),
        ...(message.cancelled === true ? { cancelled: true } : {}),
        ...(message.truncated === true ? { truncated: true } : {}),
        ...(typeof message.fullOutputPath === 'string' ? { fullOutputPath: message.fullOutputPath } : {})
      }, 'message')
      addItem(projection, 'tool_result', [
        'Tool: bash',
        status ? `Status: ${status}` : undefined,
        formatted.text
      ].filter((part): part is string => Boolean(part)).join('\n'), range)
      addCapturedAttachments(projection, formatted.captures, range)
      return
    }
    if (role === 'branchSummary' || role === 'compactionSummary') {
      addValueItem(projection, 'state', `Pi ${String(role)}:`, compactRecord(message, ['role', 'usage']), range)
      return
    }
    addValueItem(
      projection,
      'unknown',
      `Unrecognized Pi message role (${String(role ?? 'no role')}):`,
      message,
      range,
      'message'
    )
    return
  }
  if (record.type === 'session') {
    addValueItem(
      projection,
      'conversation_context',
      'Pi conversation context:',
      compactRecord(record, ['type', 'id', 'timestamp']),
      range
    )
    return
  }
  if (record.type === 'model_change' || record.type === 'thinking_level_change') {
    addValueItem(projection, 'state', `Pi ${String(record.type)}:`, compactRecord(record, ['type', 'id', 'parentId', 'timestamp']), range)
    return
  }
  addValueItem(projection, 'unknown', `Unrecognized Pi record (${String(record.type ?? 'no type')}):`, record, range)
}

function projectPi(lines: readonly string[]): CanonicalActivity {
  const projection = builder()
  const records = parsedProjectionRecords(lines)
  for (const section of treeProjectionSections(
    records,
    'id',
    'parentId',
    undefined,
    (record) => record.type !== 'session'
  )) {
    if (section.warning) addItem(projection, 'state', `Pi: ${section.warning}`, section.records[0].range)
    if (section.label === 'alternate') {
      addItem(
        projection,
        'state',
        'Pi alternate or abandoned source branches follow. They remain evidence of exploration, but do not represent the active conversation path.',
        section.records[0].range
      )
    }
    section.records.forEach((entry) => projectPiRecord(projection, entry))
  }
  return canonicalActivity('pi-canonical-activity-v3', projection)
}

function codexConversationContext(payload: Record<string, unknown>): string {
  return typeof payload.cwd === 'string' && payload.cwd
    ? `Codex conversation context · project: ${payload.cwd}`
    : 'Codex conversation context'
}

function appendCompactCodexToolCall(
  projection: ProjectionBuilder,
  name: string,
  callId: string | undefined,
  status: string | undefined,
  argumentsText: string,
  range: EvidenceRange
): void {
  addItem(projection, 'tool_call', [
    `Tool: ${name}`,
    callId ? `Call ID: ${callId}` : undefined,
    status ? `Status: ${status}` : undefined,
    'Arguments:',
    argumentsText
  ].filter((part): part is string => Boolean(part)).join('\n'), range)
  if (callId) projection.codexToolCalls.set(callId, name)
}

function appendCompactCodexToolResult(
  projection: ProjectionBuilder,
  callId: string | undefined,
  status: string | undefined,
  resultText: string,
  range: EvidenceRange
): void {
  const toolName = callId ? projection.codexToolCalls.get(callId) : undefined
  addItem(projection, 'tool_result', [
    toolName ? `Tool: ${toolName}` : undefined,
    callId ? `Call ID: ${callId}` : undefined,
    status ? `Status: ${status}` : undefined,
    'Result:',
    resultText
  ].filter((part): part is string => Boolean(part)).join('\n'), range)
}

function codexToolStatus(...values: unknown[]): string | undefined {
  for (const value of values) {
    const record = asRecord(value)
    if (!record) continue
    if (record.is_error === true || record.isError === true || record.success === false || record.error != null) {
      return 'error'
    }
    if (record.is_error === false || record.isError === false || record.success === true) {
      return 'success'
    }
    if (typeof record.status === 'string' && record.status) return record.status
    if (Object.prototype.hasOwnProperty.call(record, 'Error') || Object.prototype.hasOwnProperty.call(record, 'Err')) {
      return 'error'
    }
    if (Object.prototype.hasOwnProperty.call(record, 'Ok')) return 'success'
  }
  return undefined
}

function appendCodexToolCall(
  projection: ProjectionBuilder,
  payload: Record<string, unknown>,
  range: EvidenceRange
): void {
  const name = typeof payload.name === 'string' ? payload.name : 'unknown tool'
  const qualifiedName = typeof payload.namespace === 'string' && payload.namespace
    ? `${payload.namespace}.${name}`
    : name
  const callId = typeof payload.call_id === 'string'
    ? payload.call_id
    : typeof payload.id === 'string'
      ? payload.id
      : undefined
  const rawArguments = payload.arguments ?? payload.input ?? {}
  const args = typeof rawArguments === 'string' ? parseStructuredString(rawArguments) : rawArguments
  const formatted = formattedValue(projection, range, args, 'arguments')
  appendCompactCodexToolCall(
    projection,
    qualifiedName,
    callId,
    codexToolStatus(payload),
    formatted.text,
    range
  )
  addCapturedAttachments(projection, formatted.captures, range)
}

function appendCodexToolResult(
  projection: ProjectionBuilder,
  payload: Record<string, unknown>,
  range: EvidenceRange
): void {
  const callId = typeof payload.call_id === 'string'
    ? payload.call_id
    : typeof payload.id === 'string'
      ? payload.id
      : undefined
  const rawResult = payload.output ?? payload.content ?? payload.result ?? ''
  const parsedResult = typeof rawResult === 'string' ? parseStructuredString(rawResult) : rawResult
  const formatted = formattedValue(
    projection,
    range,
    unwrappedToolResult(parsedResult),
    'output'
  )
  appendCompactCodexToolResult(
    projection,
    callId,
    codexToolStatus(payload, parsedResult),
    formatted.text,
    range
  )
  addCapturedAttachments(projection, formatted.captures, range)
}

function appendCodexEventToolResult(
  projection: ProjectionBuilder,
  payload: Record<string, unknown>,
  range: EvidenceRange
): void {
  const type = typeof payload.type === 'string' ? payload.type : 'tool_event'
  const callId = typeof payload.call_id === 'string' ? payload.call_id : undefined
  const omitted = ['type', 'call_id', 'turn_id']
  let imageCapture: AttachmentCapture | undefined
  if (type === 'image_generation_end' && typeof payload.result === 'string' && payload.result) {
    imageCapture = captureAttachment(projection, range, 'image/png', payload.result, 'result')
    omitted.push('result')
  }
  const value = compactRecord(payload, omitted)
  const formatted = formattedValue(projection, range, value, `event.${type}`)
  addItem(projection, 'tool_result', [
    `Codex tool event: ${type}`,
    callId ? `Call ID: ${callId}` : undefined,
    codexToolStatus(payload, payload.result) ? `Status: ${codexToolStatus(payload, payload.result)}` : undefined,
    'Result:',
    formatted.text
  ].filter((part): part is string => Boolean(part)).join('\n'), range)
  addCapturedAttachments(projection, formatted.captures, range)
  if (imageCapture) addCapturedAttachments(projection, [imageCapture], range)
}

function codexCompactionContent(payload: Record<string, unknown>): string {
  const replacementHistory = Array.isArray(payload.replacement_history)
    ? payload.replacement_history
    : []
  const roles = new Map<string, number>()
  for (const entry of replacementHistory) {
    const role = sourceToken(asRecord(entry)?.role)
    if (role) roles.set(role, (roles.get(role) ?? 0) + 1)
  }
  const roleSummary = [...roles.entries()]
    .map(([role, count]) => `${role}: ${count}`)
    .join(', ')
  const summary = typeof payload.message === 'string'
    ? payload.message
    : typeof payload.summary === 'string'
      ? payload.summary
      : undefined
  return [
    'Codex context compaction summary:',
    summary,
    `Replacement history omitted: ${replacementHistory.length} protocol messages${roleSummary ? ` (${roleSummary})` : ''}.`,
    typeof payload.window_number === 'number' ? `Window: ${payload.window_number}.` : undefined,
    'Replacement protocol messages are omitted because they duplicate earlier Canonical Activity. Use the Raw source locator for exact protocol content.'
  ].filter((part): part is string => Boolean(part)).join('\n')
}

function codexInterAgentMessage(value: unknown): string | undefined {
  const text = contentTexts(value).join('\n').trim()
  const match = text.match(
    /^Message Type: [^\n]+\nTask name: [^\n]+\nSender: [^\n]+\nPayload:\n([\s\S]*)$/
  )
  if (!match) return undefined
  const payload = match[1].trim()
  return payload
}

function projectCodex(lines: readonly string[]): CanonicalActivity {
  const projection = builder()
  const conversationContexts = new Map<string, CanonicalActivityItem>()
  lines.forEach((line, index) => {
    const record = parsedRecord(line)
    const range = physicalLineRange(lines, index)
    if (!record) {
      if (line.trim()) addUnparseableRecord(projection, 'Codex', line, range)
      return
    }
    const payload = asRecord(record.payload) ?? record
    const type = typeof payload.type === 'string' ? payload.type : ''

    if (record.type === 'session_meta') {
      const content = codexConversationContext(payload)
      addDeduplicatedItem(
        projection,
        conversationContexts,
        'conversation_context',
        content,
        range
      )
      return
    }
    if (record.type === 'compacted') {
      addItem(projection, 'state', codexCompactionContent(payload), range)
      return
    }
    if (record.type === 'response_item') {
      if (type === 'message' || type === 'agent_message') {
        const role = payload.role ?? (type === 'agent_message' ? 'assistant' : undefined)
        if (role === 'developer' || role === 'system') return
        if (role === 'user' && isCodexRuntimeInjectedMessage(payload.content)) return
        if (role === 'user' && injectedSkillName(payload.content)) return
        if (type === 'agent_message') {
          const interAgentMessage = codexInterAgentMessage(payload.content)
          if (interAgentMessage !== undefined) {
            if (interAgentMessage) {
              addMirrorableItem(projection, 'assistant_message', interAgentMessage, range, 'primary')
            }
            return
          }
        }
        appendMessageBlocks(
          projection,
          role,
          payload.content,
          range,
          'codex'
        )
        return
      }
      if (type === 'reasoning') {
        return
      }
      if (type === 'function_call' || type === 'custom_tool_call' || type === 'tool_call') {
        appendCodexToolCall(projection, payload, range)
        return
      }
      if (type === 'function_call_output' || type === 'custom_tool_call_output' || type === 'tool_call_output') {
        appendCodexToolResult(projection, payload, range)
        return
      }
      addValueItem(
        projection,
        'unknown',
        `Unrecognized Codex response item (${type || 'no type'}):`,
        payload,
        range
      )
      return
    }
    if (record.type === 'event_msg') {
      if (type === 'agent_reasoning') return
      if (type === 'agent_message' && typeof payload.message === 'string') {
        addMirrorableItem(projection, 'assistant_message', payload.message, range, 'event')
        return
      }
      if (type === 'user_message' && typeof payload.message === 'string') {
        if (isCodexRuntimeInjectedMessage(payload.message)) return
        if (injectedSkillName(payload.message)) return
        addMirrorableItem(projection, 'user_message', payload.message, range, 'event')
        return
      }
      if (
        type === 'token_count'
        || type === 'task_started'
        || type === 'context_compacted'
        || type === 'thread_settings_applied'
      ) return
      if (type === 'sub_agent_activity') {
        if (payload.kind === 'started' || payload.kind === 'interacted') return
        if (payload.kind === 'interrupted') {
          addValueItem(
            projection,
            'state',
            'Codex subagent activity was interrupted:',
            compactRecord(payload, ['type']),
            range
          )
        } else {
          addValueItem(
            projection,
            'unknown',
            `Unrecognized Codex subagent activity (${String(payload.kind ?? 'no kind')}):`,
            payload,
            range
          )
        }
        return
      }
      if (
        type === 'patch_apply_end'
        || type === 'mcp_tool_call_end'
        || type === 'image_generation_end'
      ) {
        appendCodexEventToolResult(projection, payload, range)
        return
      }
      if (type === 'task_complete') {
        const message = typeof payload.last_agent_message === 'string'
          ? payload.last_agent_message
          : typeof payload.message === 'string'
            ? payload.message
            : undefined
        if (message) addMirrorableItem(projection, 'assistant_message', message, range, 'event')
        if (payload.error != null || payload.success === false || payload.status === 'error' || payload.status === 'failed') {
          addValueItem(projection, 'state', 'Codex task failed:', compactRecord(payload, ['type', 'last_agent_message', 'message']), range)
        }
        return
      }
      if (type === 'turn_aborted' || type === 'thread_rolled_back') {
        addValueItem(projection, 'state', `Codex event (${type}):`, compactRecord(payload, ['type']), range)
        return
      }
      addValueItem(
        projection,
        'unknown',
        `Unrecognized Codex event (${type || 'no type'}):`,
        payload,
        range
      )
      return
    }
    if (record.type === 'turn_context') {
      return
    }
    if (record.type === 'world_state') {
      return
    }
    if (record.type === 'inter_agent_communication_metadata') return
    addValueItem(projection, 'unknown', `Unrecognized Codex record (${String(record.type ?? type ?? 'no type')}):`, record, range)
  })
  return canonicalActivity('codex-canonical-activity-v4', projection)
}

function createClaudeRawEvidence(rawContent: string): RawEvidence {
  return rawEvidence(rawContent, 'claude-jsonl-raw-v1', claudeSkillHint)
}

export function createClaudeObservation(rawContent: string): AgentObservation {
  const evidence = createClaudeRawEvidence(rawContent)
  return { rawEvidence: evidence, canonicalActivity: projectClaude(evidence.lines) }
}

function createPiRawEvidence(rawContent: string): RawEvidence {
  return rawEvidence(rawContent, 'pi-jsonl-raw-v1', piSkillHint)
}

export function createPiObservation(rawContent: string): AgentObservation {
  const evidence = createPiRawEvidence(rawContent)
  return { rawEvidence: evidence, canonicalActivity: projectPi(evidence.lines) }
}

function createCodexRawEvidence(rawContent: string): RawEvidence {
  return rawEvidence(rawContent, 'codex-jsonl-raw-v1', codexSkillHint)
}

export function createCodexObservation(rawContent: string): AgentObservation {
  const evidence = createCodexRawEvidence(rawContent)
  return { rawEvidence: evidence, canonicalActivity: projectCodex(evidence.lines) }
}

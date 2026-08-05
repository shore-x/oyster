import type { RawEvidence, RawEvidenceSkillHint } from '../observation/model'

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

export function createClaudeRawEvidence(rawContent: string): RawEvidence {
  return rawEvidence(rawContent, 'claude-jsonl-raw-v1', claudeSkillHint)
}

export function createPiRawEvidence(rawContent: string): RawEvidence {
  return rawEvidence(rawContent, 'pi-jsonl-raw-v1', piSkillHint)
}

export function createCodexRawEvidence(rawContent: string): RawEvidence {
  return rawEvidence(rawContent, 'codex-jsonl-raw-v1', codexSkillHint)
}

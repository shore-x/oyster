export type KnowledgeStatementContentPart =
  | { kind: 'text'; value: string }
  | {
      kind: 'reference'
      targetTitle: string
      label: string
      start: number
      end: number
    }

const STATEMENT_REFERENCE_PATTERN = /\[\[([^\]|\n]+?)(?:\|([^\]\n]+?))?\]\]/g

/**
 * Deterministic parser for the reference syntax owned by the Knowledge model.
 * Consumers may render these parts differently, but must not redefine what a
 * `[[canonical title|local display text]]` reference means.
 */
export function parseKnowledgeStatementContent(content: string): KnowledgeStatementContentPart[] {
  const parts: KnowledgeStatementContentPart[] = []
  const pattern = new RegExp(STATEMENT_REFERENCE_PATTERN.source, STATEMENT_REFERENCE_PATTERN.flags)
  let cursor = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(content)) !== null) {
    if (match.index > cursor) parts.push({ kind: 'text', value: content.slice(cursor, match.index) })
    const targetTitle = match[1].trim()
    const label = match[2]?.trim() || targetTitle
    parts.push({
      kind: 'reference',
      targetTitle,
      label,
      start: match.index,
      end: match.index + match[0].length
    })
    cursor = match.index + match[0].length
  }

  if (cursor < content.length) parts.push({ kind: 'text', value: content.slice(cursor) })
  return parts
}

export function knowledgeStatementExcerpt(content: string, limit = 220): string {
  const text = parseKnowledgeStatementContent(content)
    .map((part) => part.kind === 'text' ? part.value : part.label)
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text
}

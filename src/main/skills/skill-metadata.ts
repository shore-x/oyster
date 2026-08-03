export interface SkillMetadata {
  name?: string
  description?: string
}

export interface ValidSkillMetadata {
  name: string
  description: string
}

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function unquoteYamlScalar(value: string): string | undefined {
  const scalar = value.trim()
  if (!scalar) return undefined
  if (scalar.startsWith('"') && scalar.endsWith('"')) {
    try {
      const parsed = JSON.parse(scalar)
      return typeof parsed === 'string' && parsed.trim() ? parsed.trim() : undefined
    } catch {
      return scalar.slice(1, -1).trim() || undefined
    }
  }
  if (scalar.startsWith("'") && scalar.endsWith("'")) {
    return scalar.slice(1, -1).replaceAll("''", "'").trim() || undefined
  }
  return scalar.trim() || undefined
}

/**
 * Reads only the portable display fields from the leading YAML frontmatter.
 * Unknown fields and the Markdown body deliberately remain uninterpreted.
 */
export function skillMetadataFields(content: string): SkillMetadata {
  const lines = content.split(/\r?\n/)
  if (lines[0] !== '---') return {}
  const closing = lines.indexOf('---', 1)
  if (closing < 0) return {}

  const result: SkillMetadata = {}
  for (let index = 1; index < closing; index++) {
    const match = /^(name|description)\s*:\s*(.*)$/.exec(lines[index])
    if (!match) continue
    const key = match[1] as keyof SkillMetadata
    const marker = match[2].trim()
    if (marker === '|' || marker === '>') {
      const parts: string[] = []
      while (index + 1 < closing && (/^\s/.test(lines[index + 1]) || lines[index + 1] === '')) {
        index++
        parts.push(lines[index].replace(/^\s+/, ''))
      }
      const value = (marker === '|' ? parts.join('\n') : parts.join(' ')).trim()
      if (value) result[key] = value
      continue
    }
    const value = unquoteYamlScalar(marker)
    if (value) result[key] = value
  }
  return result
}

export function validSkillName(value: string | undefined): value is string {
  return Boolean(
    value
    && value.length <= 64
    && SKILL_NAME_PATTERN.test(value)
  )
}

export function validateSkillMetadata(metadata: SkillMetadata): ValidSkillMetadata {
  if (!validSkillName(metadata.name)) {
    throw new Error('SKILL.md 的 name 必须为 1–64 个小写字母、数字或单连字符')
  }
  if (
    typeof metadata.description !== 'string'
    || metadata.description.length < 1
    || metadata.description.length > 1024
  ) {
    throw new Error('SKILL.md 的 description 必须为 1–1024 个字符')
  }
  return { name: metadata.name, description: metadata.description }
}

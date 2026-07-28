import {
  formatEvidenceLocation,
  splitsSurrogatePair
} from '../observation/evidence-location'
import {
  MAX_STATEMENT_CANDIDATE_EXPRESSION_CHARACTERS,
  MAX_STATEMENT_CANDIDATE_QUESTION_CHARACTERS
} from './statement-candidate-agenda'

export const MAX_STATEMENT_CANDIDATE_EXPRESSION_LENGTH = MAX_STATEMENT_CANDIDATE_EXPRESSION_CHARACTERS
export const MAX_STATEMENT_CANDIDATE_QUESTION_LENGTH = MAX_STATEMENT_CANDIDATE_QUESTION_CHARACTERS

export interface StatementCandidateLocation {
  line: number
  offset: number
}

export interface StatementCandidate {
  expression: string
  question: string
  locations: StatementCandidateLocation[]
}

export interface StatementCandidateBatch {
  candidates: StatementCandidate[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void {
  const actual = Object.keys(value)
  const missing = expected.filter((key) => !Object.hasOwn(value, key))
  const extra = actual.filter((key) => !expected.includes(key))
  if (missing.length || extra.length) {
    const details = [
      missing.length ? `缺少 ${missing.join(', ')}` : undefined,
      extra.length ? `包含额外字段 ${extra.join(', ')}` : undefined
    ].filter((part): part is string => Boolean(part)).join('；')
    throw new Error(`${label} 字段无效：${details}`)
  }
}

function requiredText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} 必须是非空字符串`)
  }
  if (value.length > maximum) {
    throw new Error(`${label} 超出长度上限 ${maximum}`)
  }
  return value
}

function jsonPayload(output: string): string {
  if (typeof output !== 'string' || !output.trim()) {
    throw new Error('Statement candidate batch 输出不能为空')
  }

  const trimmed = output.trim()
  const fenced = /^(?<fence>`{3,})[ \t]*(?:json)?[ \t]*\r?\n(?<payload>[\s\S]*?)\r?\n\k<fence>[ \t]*$/i.exec(trimmed)
  if (!fenced) return trimmed

  const payload = fenced.groups?.payload
  if (!payload?.trim()) throw new Error('Statement candidate batch JSON 不能为空')
  return payload
}

function parseLocation(
  value: unknown,
  observationLines: readonly string[],
  candidateIndex: number,
  locationIndex: number
): StatementCandidateLocation {
  const label = `Candidate ${candidateIndex + 1} location ${locationIndex + 1}`
  if (!isRecord(value)) throw new Error(`${label} 必须是对象`)
  assertExactKeys(value, ['line', 'offset'], label)

  const { line, offset } = value
  if (!Number.isSafeInteger(line) || (line as number) < 1) {
    throw new Error(`${label} line 必须是大于等于 1 的安全整数`)
  }
  if (!Number.isSafeInteger(offset) || (offset as number) < 0) {
    throw new Error(`${label} offset 必须是大于等于 0 的安全整数`)
  }

  const lineNumber = line as number
  const characterOffset = offset as number
  if (lineNumber > observationLines.length) {
    throw new Error(`${label} line 超出 Observation 范围`)
  }
  const observationLine = observationLines[lineNumber - 1]
  if (typeof observationLine !== 'string' || /[\r\n]/.test(observationLine)) {
    throw new Error('Observation 必须按单行字符串数组提供')
  }
  if (characterOffset > observationLine.length) {
    throw new Error(`${label} offset 超出 Observation 行范围`)
  }
  if (splitsSurrogatePair(observationLine, characterOffset)) {
    throw new Error(`${label} offset 切开了 Unicode 字符`)
  }

  return { line: lineNumber, offset: characterOffset }
}

function parseCandidate(
  value: unknown,
  observationLines: readonly string[],
  candidateIndex: number
): StatementCandidate {
  const label = `Candidate ${candidateIndex + 1}`
  if (!isRecord(value)) throw new Error(`${label} 必须是对象`)
  assertExactKeys(value, ['expression', 'question', 'locations'], label)

  if (!Array.isArray(value.locations) || !value.locations.length) {
    throw new Error(`${label} locations 必须是非空数组`)
  }

  return {
    expression: requiredText(
      value.expression,
      `${label} expression`,
      MAX_STATEMENT_CANDIDATE_EXPRESSION_LENGTH
    ),
    question: requiredText(
      value.question,
      `${label} question`,
      MAX_STATEMENT_CANDIDATE_QUESTION_LENGTH
    ),
    locations: value.locations.map((location, locationIndex) => parseLocation(
      location,
      observationLines,
      candidateIndex,
      locationIndex
    ))
  }
}

export function parseStatementCandidateBatch(
  output: string,
  observationLines: readonly string[]
): StatementCandidateBatch {
  if (!Array.isArray(observationLines)) {
    throw new Error('Observation 必须按单行字符串数组提供')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonPayload(output)) as unknown
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('Statement candidate batch 不是有效 JSON')
    }
    throw error
  }

  if (!isRecord(parsed)) throw new Error('Statement candidate batch 必须是对象')
  assertExactKeys(parsed, ['candidates'], 'Statement candidate batch')
  if (!Array.isArray(parsed.candidates)) {
    throw new Error('Statement candidate batch candidates 必须是数组')
  }

  return {
    candidates: parsed.candidates.map((candidate, candidateIndex) => parseCandidate(
      candidate,
      observationLines,
      candidateIndex
    ))
  }
}

function markdownCodeBlock(value: string): string {
  const longestFence = Math.max(
    0,
    ...Array.from(value.matchAll(/`+/g), (match) => match[0].length)
  )
  const fence = '`'.repeat(Math.max(3, longestFence + 1))
  return `${fence}text\n${value}\n${fence}`
}

export function renderStatementCandidateBatchMarkdown(batch: StatementCandidateBatch): string {
  const header = [
    '# Statement Candidate Batch',
    '',
    `Candidate count: ${batch.candidates.length}`
  ]
  if (!batch.candidates.length) return [...header, '', 'No candidates.'].join('\n')

  return [
    ...header,
    ...batch.candidates.flatMap((candidate, index) => [
      '',
      `## Candidate ${index + 1}`,
      '',
      '### Expression',
      '',
      markdownCodeBlock(candidate.expression),
      '',
      '### Question',
      '',
      markdownCodeBlock(candidate.question),
      '',
      '### Locations',
      '',
      ...candidate.locations.map((location) => `- \`${formatEvidenceLocation(location)}\``)
    ])
  ].join('\n')
}

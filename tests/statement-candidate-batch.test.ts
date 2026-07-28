import { describe, expect, it } from 'vitest'
import {
  MAX_STATEMENT_CANDIDATE_EXPRESSION_LENGTH,
  MAX_STATEMENT_CANDIDATE_QUESTION_LENGTH,
  parseStatementCandidateBatch,
  renderStatementCandidateBatchMarkdown
} from '../src/main/knowledge-processing/statement-candidate-batch'

const observationLines = [
  'The ai.service-agent module uses SQLite.',
  '数据库在这个项目中指本地知识存储。',
  'emoji 😀 boundary'
]

describe('Statement candidate batch', () => {
  it('parses a strict JSON batch without changing model text or location order', () => {
    const output = JSON.stringify({
      candidates: [{
        expression: ' ai.service-agent ',
        question: ' What does it refer to here? ',
        locations: [
          { line: 2, offset: 0 },
          { line: 1, offset: 4 }
        ]
      }]
    })

    expect(parseStatementCandidateBatch(output, observationLines)).toEqual({
      candidates: [{
        expression: ' ai.service-agent ',
        question: ' What does it refer to here? ',
        locations: [
          { line: 2, offset: 0 },
          { line: 1, offset: 4 }
        ]
      }]
    })
  })

  it('strips an optional Markdown JSON fence and allows an empty batch', () => {
    expect(parseStatementCandidateBatch([
      '```json',
      '{"candidates":[]}',
      '```'
    ].join('\n'), observationLines)).toEqual({ candidates: [] })
  })

  it('rejects empty, malformed, and ambiguously wrapped output', () => {
    expect(() => parseStatementCandidateBatch('  ', observationLines)).toThrow('输出不能为空')
    expect(() => parseStatementCandidateBatch('{', observationLines)).toThrow('不是有效 JSON')
    expect(() => parseStatementCandidateBatch('before\n```json\n{"candidates":[]}\n```', observationLines))
      .toThrow('不是有效 JSON')
    expect(() => parseStatementCandidateBatch('```json\n\n```', observationLines))
      .toThrow('JSON 不能为空')
  })

  it('requires exact object fields at every level', () => {
    expect(() => parseStatementCandidateBatch(JSON.stringify({
      candidates: [],
      summary: 'not allowed'
    }), observationLines)).toThrow('包含额外字段 summary')

    expect(() => parseStatementCandidateBatch(JSON.stringify({
      candidates: [{ expression: 'database', question: 'What is it?' }]
    }), observationLines)).toThrow('缺少 locations')

    expect(() => parseStatementCandidateBatch(JSON.stringify({
      candidates: [{
        expression: 'database',
        question: 'What is it?',
        locations: [{ line: 1, offset: 0, end: 8 }]
      }]
    }), observationLines)).toThrow('包含额外字段 end')
  })

  it('requires non-empty bounded candidate text and at least one location', () => {
    expect(() => parseStatementCandidateBatch(JSON.stringify({
      candidates: [{ expression: ' ', question: 'What is it?', locations: [{ line: 1, offset: 0 }] }]
    }), observationLines)).toThrow('expression 必须是非空字符串')

    expect(() => parseStatementCandidateBatch(JSON.stringify({
      candidates: [{ expression: 'database', question: '', locations: [{ line: 1, offset: 0 }] }]
    }), observationLines)).toThrow('question 必须是非空字符串')

    expect(() => parseStatementCandidateBatch(JSON.stringify({
      candidates: [{
        expression: 'x'.repeat(MAX_STATEMENT_CANDIDATE_EXPRESSION_LENGTH + 1),
        question: 'What is it?',
        locations: [{ line: 1, offset: 0 }]
      }]
    }), observationLines)).toThrow(`expression 超出长度上限 ${MAX_STATEMENT_CANDIDATE_EXPRESSION_LENGTH}`)

    expect(() => parseStatementCandidateBatch(JSON.stringify({
      candidates: [{
        expression: 'database',
        question: 'x'.repeat(MAX_STATEMENT_CANDIDATE_QUESTION_LENGTH + 1),
        locations: [{ line: 1, offset: 0 }]
      }]
    }), observationLines)).toThrow(`question 超出长度上限 ${MAX_STATEMENT_CANDIDATE_QUESTION_LENGTH}`)

    expect(() => parseStatementCandidateBatch(JSON.stringify({
      candidates: [{ expression: 'database', question: 'What is it?', locations: [] }]
    }), observationLines)).toThrow('locations 必须是非空数组')
  })

  it.each([
    [{ line: 0, offset: 0 }, 'line 必须是大于等于 1 的安全整数'],
    [{ line: 1.5, offset: 0 }, 'line 必须是大于等于 1 的安全整数'],
    [{ line: Number.MAX_SAFE_INTEGER + 1, offset: 0 }, 'line 必须是大于等于 1 的安全整数'],
    [{ line: 1, offset: -1 }, 'offset 必须是大于等于 0 的安全整数'],
    [{ line: 1, offset: 0.5 }, 'offset 必须是大于等于 0 的安全整数'],
    [{ line: 4, offset: 0 }, 'line 超出 Observation 范围'],
    [{ line: 1, offset: observationLines[0].length + 1 }, 'offset 超出 Observation 行范围'],
    [{ line: 3, offset: 7 }, 'offset 切开了 Unicode 字符']
  ])('rejects invalid location %j', (location, message) => {
    expect(() => parseStatementCandidateBatch(JSON.stringify({
      candidates: [{
        expression: 'database',
        question: 'What is it?',
        locations: [location]
      }]
    }), observationLines)).toThrow(message)
  })

  it('requires physical Observation lines and accepts offsets on either side of a surrogate pair', () => {
    const firstLineCandidate = JSON.stringify({
      candidates: [{
        expression: 'line',
        question: 'What does it mean?',
        locations: [{ line: 1, offset: 0 }]
      }]
    })
    expect(() => parseStatementCandidateBatch(firstLineCandidate, ['two\nlines']))
      .toThrow('Observation 必须按单行字符串数组提供')
    expect(() => parseStatementCandidateBatch(firstLineCandidate, new Array<string>(1)))
      .toThrow('Observation 必须按单行字符串数组提供')

    const candidate = (offset: number): string => JSON.stringify({
      candidates: [{
        expression: 'emoji',
        question: 'What does it mark?',
        locations: [{ line: 3, offset }]
      }]
    })
    expect(parseStatementCandidateBatch(candidate(6), observationLines).candidates[0].locations[0].offset)
      .toBe(6)
    expect(parseStatementCandidateBatch(candidate(8), observationLines).candidates[0].locations[0].offset)
      .toBe(8)
  })

  it('renders an empty batch and a Markdown-safe debug view', () => {
    expect(renderStatementCandidateBatchMarkdown({ candidates: [] })).toBe([
      '# Statement Candidate Batch',
      '',
      'Candidate count: 0',
      '',
      'No candidates.'
    ].join('\n'))

    const markdown = renderStatementCandidateBatchMarkdown({
      candidates: [{
        expression: 'name with ``` fence',
        question: 'Which [[Statement]] explains it?',
        locations: [{ line: 2, offset: 3 }]
      }]
    })
    expect(markdown).toContain('Candidate count: 1')
    expect(markdown).toContain('````text\nname with ``` fence\n````')
    expect(markdown).toContain('Which [[Statement]] explains it?')
    expect(markdown).toContain('- `L000002:C3`')
  })
})

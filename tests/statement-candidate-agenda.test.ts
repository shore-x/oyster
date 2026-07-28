import { describe, expect, it } from 'vitest'
import {
  InMemoryStatementCandidateAgenda,
  MAX_STATEMENT_CANDIDATE_EXPRESSION_CHARACTERS,
  MAX_STATEMENT_CANDIDATE_QUESTION_CHARACTERS
} from '../src/main/knowledge-processing/statement-candidate-agenda'

function candidate(question: string) {
  return { expression: question, question }
}

describe('InMemoryStatementCandidateAgenda', () => {
  it('seeds open candidates and assigns Host-owned run-local refs', () => {
    const agenda = new InMemoryStatementCandidateAgenda([
      {
        expression: 'ai.service-agent',
        question: 'What does ai.service-agent denote?',
        evidenceLocations: ['L000012-L000018']
      },
      { expression: 'SCA', question: 'What does SCA mean in this project?' }
    ])

    expect(agenda.list()).toMatchObject({
      counts: { total: 2, open: 2, resolved: 0 },
      total: 2,
      nextOffset: null,
      items: [
        {
          ref: 'C000001',
          expression: 'ai.service-agent',
          question: 'What does ai.service-agent denote?',
          evidenceLocations: ['L000012-L000018'],
          status: 'open'
        },
        {
          ref: 'C000002',
          expression: 'SCA',
          question: 'What does SCA mean in this project?',
          evidenceLocations: [],
          status: 'open'
        }
      ]
    })

    const anotherRun = new InMemoryStatementCandidateAgenda([candidate('Independent run')])
    expect(anotherRun.list().items[0].ref).toBe('C000001')
  })

  it('remains open to candidates discovered during maintenance', () => {
    const agenda = new InMemoryStatementCandidateAgenda([candidate('Seed')])

    expect(agenda.add([
      {
        expression: 'background term',
        question: 'Newly discovered background',
        evidenceLocations: ['L000020 C40:80/160']
      },
      { expression: 'ambiguous term', question: 'A related ambiguity' }
    ])).toEqual([
      {
        ref: 'C000002',
        expression: 'background term',
        question: 'Newly discovered background',
        evidenceLocations: ['L000020 C40:80/160'],
        status: 'open'
      },
      {
        ref: 'C000003',
        expression: 'ambiguous term',
        question: 'A related ambiguity',
        evidenceLocations: [],
        status: 'open'
      }
    ])
    expect(agenda.snapshot().counts).toEqual({ total: 3, open: 3, resolved: 0 })
  })

  it('resolves candidates in batches with unrestricted disposition text', () => {
    const agenda = new InMemoryStatementCandidateAgenda([
      candidate('First'),
      candidate('Second'),
      candidate('Third')
    ])

    expect(agenda.resolve([
      { ref: 'C000001', resolution: 'Covered by an existing focused Statement.' },
      { ref: 'C000002', resolution: 'Incidental task wording; no durable knowledge to add.' }
    ])).toMatchObject([
      { ref: 'C000001', status: 'resolved', resolution: 'Covered by an existing focused Statement.' },
      { ref: 'C000002', status: 'resolved', resolution: 'Incidental task wording; no durable knowledge to add.' }
    ])
    expect(agenda.list({ status: 'open' }).items.map(({ ref }) => ref)).toEqual(['C000003'])
    expect(agenda.list({ status: 'resolved' }).counts).toEqual({ total: 3, open: 1, resolved: 2 })
  })

  it('paginates either the complete agenda or one status without losing global counts', () => {
    const agenda = new InMemoryStatementCandidateAgenda(
      Array.from({ length: 6 }, (_, index) => candidate(`Candidate ${index + 1}`))
    )
    agenda.resolve([
      { ref: 'C000002', resolution: 'Not needed' },
      { ref: 'C000005', resolution: 'Already covered' }
    ])

    expect(agenda.list({ offset: 2, limit: 2 })).toMatchObject({
      counts: { total: 6, open: 4, resolved: 2 },
      offset: 2,
      limit: 2,
      total: 6,
      nextOffset: 4,
      items: [{ ref: 'C000003' }, { ref: 'C000004' }]
    })
    expect(agenda.list({ status: 'open', offset: 1, limit: 2 })).toMatchObject({
      total: 4,
      nextOffset: 4,
      items: [{ ref: 'C000003' }, { ref: 'C000004' }]
    })
    expect(agenda.list({ status: 'open', offset: 4, limit: 2 })).toMatchObject({
      total: 4,
      nextOffset: null,
      items: [{ ref: 'C000006' }]
    })
  })

  it('keeps filtered pagination stable while candidates are resolved between pages', () => {
    const agenda = new InMemoryStatementCandidateAgenda(
      Array.from({ length: 5 }, (_, index) => candidate(`Candidate ${index + 1}`))
    )

    const first = agenda.list({ status: 'open', limit: 2 })
    agenda.resolve(first.items.map(({ ref }) => ({ ref, resolution: 'Handled' })))
    const second = agenda.list({ status: 'open', offset: first.nextOffset!, limit: 2 })

    expect(first.items.map(({ ref }) => ref)).toEqual(['C000001', 'C000002'])
    expect(first.nextOffset).toBe(2)
    expect(second.items.map(({ ref }) => ref)).toEqual(['C000003', 'C000004'])
    expect(second.nextOffset).toBe(4)
  })

  it('builds a bounded open preview while preserving complete counts', () => {
    const agenda = new InMemoryStatementCandidateAgenda(
      Array.from({ length: 8 }, (_, index) => candidate(`Candidate ${index + 1}`))
    )
    agenda.resolve([{ ref: 'C000001', resolution: 'Resolved independently' }])

    expect(agenda.snapshot(3)).toEqual({
      counts: { total: 8, open: 7, resolved: 1 },
      openPreview: [
        expect.objectContaining({ ref: 'C000002', status: 'open' }),
        expect.objectContaining({ ref: 'C000003', status: 'open' }),
        expect.objectContaining({ ref: 'C000004', status: 'open' })
      ],
      remainingOpen: 4
    })
    expect(agenda.snapshot(0)).toMatchObject({ openPreview: [], remainingOpen: 7 })
  })

  it('validates a whole batch before changing the agenda', () => {
    const agenda = new InMemoryStatementCandidateAgenda([candidate('Original')])

    expect(() => agenda.add([
      candidate('Valid candidate'),
      { expression: 'Invalid', question: '   ' }
    ])).toThrow('候选问题 不能为空')
    expect(agenda.snapshot().counts).toEqual({ total: 1, open: 1, resolved: 0 })

    expect(() => agenda.resolve([
      { ref: 'C000001', resolution: 'Would otherwise resolve' },
      { ref: 'C999999', resolution: 'Missing' }
    ])).toThrow('未找到 Statement 候选：C999999')
    expect(agenda.list().items[0]).toMatchObject({ status: 'open' })
    expect(agenda.list().items[0].resolution).toBeUndefined()
  })

  it('does not impose a run-level candidate quota', () => {
    const agenda = new InMemoryStatementCandidateAgenda()
    agenda.add(Array.from({ length: 1_250 }, (_, index) => candidate(`Candidate ${index + 1}`)))

    expect(agenda.snapshot(2)).toMatchObject({
      counts: { total: 1_250, open: 1_250, resolved: 0 },
      remainingOpen: 1_248
    })
    expect(agenda.list({ offset: 1_249, limit: 20 }).items[0].ref).toBe('C001250')
  })

  it('returns copies instead of exposing mutable Host state', () => {
    const agenda = new InMemoryStatementCandidateAgenda([
      { expression: 'Protected', question: 'Protected', evidenceLocations: ['L000001'] }
    ])
    const [candidate] = agenda.list().items

    candidate.question = 'Mutated outside'
    candidate.evidenceLocations.push('L999999')

    expect(agenda.list().items[0]).toMatchObject({
      question: 'Protected',
      evidenceLocations: ['L000001']
    })
  })

  it('preserves the discovered expression while applying a bounded per-item input limit', () => {
    const agenda = new InMemoryStatementCandidateAgenda([{
      expression: '  ai.service-agent  ',
      question: 'What does this exact local name denote?'
    }])

    expect(agenda.snapshot().openPreview[0]).toMatchObject({ expression: 'ai.service-agent' })
    expect(() => agenda.add([{
      expression: 'x'.repeat(MAX_STATEMENT_CANDIDATE_EXPRESSION_CHARACTERS + 1),
      question: 'Too long'
    }])).toThrow(`候选原始称呼不能超过 ${MAX_STATEMENT_CANDIDATE_EXPRESSION_CHARACTERS} 个字符`)
    expect(() => agenda.add([{
      expression: 'Question too long',
      question: 'x'.repeat(MAX_STATEMENT_CANDIDATE_QUESTION_CHARACTERS + 1)
    }])).toThrow(`候选问题不能超过 ${MAX_STATEMENT_CANDIDATE_QUESTION_CHARACTERS} 个字符`)
    expect(agenda.snapshot().counts).toEqual({ total: 1, open: 1, resolved: 0 })
  })
})

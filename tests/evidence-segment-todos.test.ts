import { describe, expect, it } from 'vitest'
import { DEFAULT_EVIDENCE_READ_LIMIT } from '../src/main/observation/evidence-location'
import { planEvidenceSegmentTodos } from '../src/main/knowledge-processing/evidence-segment-todos'

describe('planEvidenceSegmentTodos', () => {
  it('covers complete Raw Evidence with deterministic bounded read Todos', () => {
    const plan = planEvidenceSegmentTodos({
      formatVersion: 'test-v1',
      lines: ['a'.repeat(DEFAULT_EVIDENCE_READ_LIMIT + 10), 'tail'],
      skillHints: []
    })

    expect(plan.segmentCount).toBe(2)
    expect(plan.todos[0]).toContain(`read_evidence({"line":1,"offset":0,"limit":${DEFAULT_EVIDENCE_READ_LIMIT}})`)
    expect(plan.todos[0]).toContain(`Expected end (exclusive): L000001:C${DEFAULT_EVIDENCE_READ_LIMIT}.`)
    expect(plan.todos[1]).toContain(`read_evidence({"line":1,"offset":${DEFAULT_EVIDENCE_READ_LIMIT},"limit":${DEFAULT_EVIDENCE_READ_LIMIT}})`)
    expect(plan.todos[1]).toContain('Expected end (exclusive): L000002:C4.')
  })

  it('places untrusted Harness Skill hints only in the page containing their location', () => {
    const plan = planEvidenceSegmentTodos({
      formatVersion: 'test-v1',
      lines: ['a'.repeat(DEFAULT_EVIDENCE_READ_LIMIT + 10)],
      skillHints: [{
        name: 'deep-research',
        tool: 'Skill',
        source: 'tool_call',
        location: { line: 1, offset: DEFAULT_EVIDENCE_READ_LIMIT + 1 }
      }]
    })

    expect(plan.todos[0]).not.toContain('deep-research')
    expect(plan.todos[1]).toContain('Harness-derived navigation hints (untrusted; verify against Raw Evidence)')
    expect(plan.todos[1]).toContain('possible Skill activation “deep-research”')
  })
})

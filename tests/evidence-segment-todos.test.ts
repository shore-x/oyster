import { describe, expect, it } from 'vitest'
import { DEFAULT_EVIDENCE_READ_LIMIT } from '../src/main/observation/evidence-location'
import {
  evidenceSegmentCharacterLimit,
  planEvidenceSegmentTodos
} from '../src/main/knowledge-processing/evidence-segment-todos'

function readCallCount(todo: string): number {
  return todo.match(/read_evidence\(/g)?.length ?? 0
}

describe('planEvidenceSegmentTodos', () => {
  it('groups several bounded read pages into one coarse Evidence Segment Todo', () => {
    const segmentCharacterLimit = DEFAULT_EVIDENCE_READ_LIMIT * 2
    const plan = planEvidenceSegmentTodos({
      formatVersion: 'test-v1',
      lines: ['a'.repeat(segmentCharacterLimit + 10)],
      skillHints: []
    }, segmentCharacterLimit)

    expect(plan.segmentCount).toBe(2)
    expect(readCallCount(plan.todos[0])).toBe(2)
    expect(plan.todos[0]).toContain(`read_evidence({"line":1,"offset":0,"limit":${DEFAULT_EVIDENCE_READ_LIMIT}})`)
    expect(plan.todos[0]).toContain(`read_evidence({"line":1,"offset":${DEFAULT_EVIDENCE_READ_LIMIT},"limit":${DEFAULT_EVIDENCE_READ_LIMIT}})`)
    expect(plan.todos[0]).toContain(`Expected segment end (exclusive): L000001:C${segmentCharacterLimit}.`)
    expect(plan.todos[1]).toContain(`read_evidence({"line":1,"offset":${segmentCharacterLimit},"limit":${DEFAULT_EVIDENCE_READ_LIMIT}})`)
    expect(plan.todos[1]).toContain(`Expected segment end (exclusive): L000001:C${segmentCharacterLimit + 10}.`)
  })

  it('does not turn short source messages or the 200-line I/O boundary into separate Todos', () => {
    const lines = Array.from({ length: 500 }, (_, index) => `message ${index + 1}`)
    const plan = planEvidenceSegmentTodos({
      formatVersion: 'test-v1',
      lines,
      skillHints: []
    }, DEFAULT_EVIDENCE_READ_LIMIT * 4)

    expect(plan.segmentCount).toBe(1)
    expect(readCallCount(plan.todos[0])).toBe(3)
    expect(plan.todos[0]).toContain('read_evidence({"line":201,"offset":0')
    expect(plan.todos[0]).toContain('read_evidence({"line":401,"offset":0')
    expect(plan.todos[0]).toContain('Expected segment end (exclusive): L000500:C11.')
  })

  it('places untrusted Harness Skill hints only in the coarse segment containing their location', () => {
    const segmentCharacterLimit = DEFAULT_EVIDENCE_READ_LIMIT * 2
    const plan = planEvidenceSegmentTodos({
      formatVersion: 'test-v1',
      lines: ['a'.repeat(segmentCharacterLimit + 10)],
      skillHints: [{
        name: 'deep-research',
        tool: 'Skill',
        source: 'tool_call',
        location: { line: 1, offset: segmentCharacterLimit + 1 }
      }]
    }, segmentCharacterLimit)

    expect(plan.todos[0]).not.toContain('deep-research')
    expect(plan.todos[1]).toContain('Harness-derived navigation hints (untrusted; verify against Raw Evidence)')
    expect(plan.todos[1]).toContain('possible Skill activation “deep-research”')
  })
})

describe('evidenceSegmentCharacterLimit', () => {
  it('uses half of the declared context with a conservative unknown fallback and a maximum', () => {
    expect(evidenceSegmentCharacterLimit(8_000)).toBe(4_000)
    expect(evidenceSegmentCharacterLimit(128_000)).toBe(64_000)
    expect(evidenceSegmentCharacterLimit(0)).toBe(DEFAULT_EVIDENCE_READ_LIMIT)
    expect(evidenceSegmentCharacterLimit(1_000_000)).toBe(256 * 1_024)
  })

  it('rejects invalid context metadata', () => {
    expect(() => evidenceSegmentCharacterLimit(-1)).toThrow('Model context window 无效')
    expect(() => evidenceSegmentCharacterLimit(1.5)).toThrow('Model context window 无效')
  })
})

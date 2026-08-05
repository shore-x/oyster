import { renderToString } from 'solid-js/web'
import { describe, expect, it } from 'vitest'
import { StatementCandidateList } from '../src/renderer/src/components/StatementCandidateList'

describe('StatementCandidateList', () => {
  it('shows a discovered expression and its open question without internal evidence coordinates', () => {
    const html = renderToString(() => StatementCandidateList({
      candidates: [{
        expression: 'ai.service-agent',
        question: 'What does this module name refer to in the repository?',
        locations: [{ line: 42, offset: 7 }]
      }]
    }))

    expect(html).toContain('ai.service-agent')
    expect(html).toContain('What does this module name refer to in the repository?')
    expect(html).not.toContain('L000042:C7')
    expect(html).toContain('待调查')
  })
})

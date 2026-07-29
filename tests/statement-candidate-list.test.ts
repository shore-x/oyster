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
    expect(html).toContain('待裁决')
  })

  it('shows the maintainer resolution without internal candidate references', () => {
    const html = renderToString(() => StatementCandidateList({
      candidates: [{
        ref: 'C000003',
        expression: 'database',
        question: 'Which project database does this occurrence denote?',
        evidenceLocations: ['L000105:C12'],
        status: 'resolved',
        resolution: 'This occurrence denotes [[Oyster local knowledge database]].'
      }]
    }))

    expect(html).not.toContain('C000003')
    expect(html).toContain('已裁决')
    expect(html).not.toContain('L000105:C12')
    expect(html).toContain('Oyster local knowledge database')
  })
})

import { describe, expect, it } from 'vitest'
import { statementPreview } from '../src/renderer/src/components/KnowledgeStatementBrowser'
import { parseKnowledgeStatementContent } from '../src/shared/knowledge-reference'

describe('knowledge Statement browser', () => {
  it('renders readable summaries instead of leaking wikilink markup', () => {
    expect(statementPreview('由 [[Knowledge Maintenance Agent|知识维护 Agent]]\n维护。'))
      .toBe('由 知识维护 Agent 维护。')
  })

  it('keeps reference offsets in the shared, UI-independent parser', () => {
    expect(parseKnowledgeStatementContent('A [[Target|label]] B')).toEqual([
      { kind: 'text', value: 'A ' },
      { kind: 'reference', targetTitle: 'Target', label: 'label', start: 2, end: 18 },
      { kind: 'text', value: ' B' }
    ])
  })
})

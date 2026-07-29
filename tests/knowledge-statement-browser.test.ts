import { describe, expect, it } from 'vitest'
import {
  parseStatementContent,
  statementPreview
} from '../src/renderer/src/components/KnowledgeStatementBrowser'

describe('knowledge Statement browser', () => {
  it('parses canonical-title links and local display aliases without changing surrounding text', () => {
    expect(parseStatementContent(
      '由 [[Knowledge Maintenance Agent|知识维护 Agent]] 维护 [[知识加工链路]]。'
    )).toEqual([
      { kind: 'text', value: '由 ' },
      { kind: 'link', target: 'Knowledge Maintenance Agent', label: '知识维护 Agent' },
      { kind: 'text', value: ' 维护 ' },
      { kind: 'link', target: '知识加工链路', label: '知识加工链路' },
      { kind: 'text', value: '。' }
    ])
  })

  it('renders readable summaries instead of leaking wikilink markup', () => {
    expect(statementPreview('由 [[Knowledge Maintenance Agent|知识维护 Agent]]\n维护。'))
      .toBe('由 知识维护 Agent 维护。')
  })
})

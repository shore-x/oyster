import { describe, expect, it } from 'vitest'
import { KnowledgeExplorerSession } from '../src/renderer/src/knowledge-explorer-session'

describe('KnowledgeExplorerSession', () => {
  it('keeps transient navigation and hover state outside Knowledge data', () => {
    const session = new KnowledgeExplorerSession('Center')

    expect(session.navigate('Beta')).toMatchObject({
      history: ['Center', 'Beta'],
      historyIndex: 1,
      currentTitle: 'Beta'
    })
    expect(session.hover('Alpha').hoveredTitle).toBe('Alpha')
    expect(session.move(-1)).toMatchObject({
      history: ['Center', 'Beta'],
      historyIndex: 0,
      currentTitle: 'Center',
      hoveredTitle: undefined
    })
    expect(session.navigate('Gamma')).toMatchObject({
      history: ['Center', 'Gamma'],
      historyIndex: 1,
      currentTitle: 'Gamma'
    })
  })

  it('resets a browser session without carrying its old history', () => {
    const session = new KnowledgeExplorerSession('Center')
    session.navigate('Beta')

    expect(session.reset('Search Result')).toEqual({
      history: ['Search Result'],
      historyIndex: 0,
      currentTitle: 'Search Result',
      hoveredTitle: undefined
    })
  })
})

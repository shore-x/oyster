import { describe, expect, it } from 'vitest'
import { KnowledgeExplorerNavigation } from '../src/renderer/src/knowledge-explorer-navigation'

describe('KnowledgeExplorerNavigation', () => {
  it('keeps transient navigation and hover state outside Knowledge data', () => {
    const navigation = new KnowledgeExplorerNavigation('Center')

    expect(navigation.navigate('Beta')).toMatchObject({
      history: ['Center', 'Beta'],
      historyIndex: 1,
      currentTitle: 'Beta'
    })
    expect(navigation.hover('Alpha').hoveredTitle).toBe('Alpha')
    expect(navigation.move(-1)).toMatchObject({
      history: ['Center', 'Beta'],
      historyIndex: 0,
      currentTitle: 'Center',
      hoveredTitle: undefined
    })
    expect(navigation.navigate('Gamma')).toMatchObject({
      history: ['Center', 'Gamma'],
      historyIndex: 1,
      currentTitle: 'Gamma'
    })
  })

  it('resets browser navigation without carrying its old history', () => {
    const navigation = new KnowledgeExplorerNavigation('Center')
    navigation.navigate('Beta')

    expect(navigation.reset('Search Result')).toEqual({
      history: ['Search Result'],
      historyIndex: 0,
      currentTitle: 'Search Result',
      hoveredTitle: undefined
    })
  })
})

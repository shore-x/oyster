import { describe, expect, it } from 'vitest'
import { KnowledgeContributionWorkspace } from '../src/main/knowledge-processing/knowledge-contribution-workspace'

describe('KnowledgeContributionWorkspace', () => {
  it('keeps a run-local draft keyed by canonical title and preserves insertion order', () => {
    const workspace = new KnowledgeContributionWorkspace()

    workspace.upsert({ title: 'Oyster', content: 'First understanding.' })
    workspace.upsert({ title: 'Knowledge Statement', content: 'A focused knowledge object.' })
    workspace.upsert({ title: ' Oyster ', content: 'Current understanding.' })

    expect(workspace.size).toBe(2)
    expect(workspace.read('Oyster')).toEqual({
      title: 'Oyster',
      content: 'Current understanding.'
    })
    expect(workspace.list()).toEqual({
      statements: [
        { title: 'Oyster', content: 'Current understanding.' },
        { title: 'Knowledge Statement', content: 'A focused knowledge object.' }
      ],
      offset: 0,
      total: 2
    })
  })

  it('supports paging, removal, and a detached atomic contribution', () => {
    const workspace = new KnowledgeContributionWorkspace()
    workspace.upsert({ title: 'A', content: 'One.' })
    workspace.upsert({ title: 'B', content: 'Two.' })

    expect(workspace.list(1, 0)).toMatchObject({
      statements: [{ title: 'A', content: 'One.' }],
      nextOffset: 1,
      total: 2
    })
    expect(workspace.remove('A')).toBe(true)
    expect(workspace.remove('A')).toBe(false)
    expect(workspace.list(1, 1)).toMatchObject({
      statements: [{ title: 'B', content: 'Two.' }],
      total: 1
    })

    const contribution = workspace.contribution('run:1')
    contribution.statements[0].content = 'Mutated outside.'
    expect(workspace.read('B')?.content).toBe('Two.')
  })

  it('rejects invalid titles, bodies, and list boundaries', () => {
    const workspace = new KnowledgeContributionWorkspace()
    expect(() => workspace.upsert({ title: ' ', content: 'Body' })).toThrow('不能为空')
    expect(() => workspace.upsert({ title: 'Title', content: ' ' })).toThrow('不能为空')
    expect(() => workspace.list(0)).toThrow('limit 必须大于 0')
    expect(() => workspace.list(1, -1)).toThrow('offset 无效')
  })
})

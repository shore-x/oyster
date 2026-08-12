import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileKnowledgeStore } from '../src/main/knowledge-store/file-knowledge-store'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'oyster-file-knowledge-'))
  const knowledgePath = join(root, 'knowledge')
  await mkdir(join(knowledgePath, 'nested'), { recursive: true })
  await Promise.all([
    writeFile(join(knowledgePath, 'alpha.md'), '# Alpha\n\nLinks to [[Beta]].\n'),
    writeFile(join(knowledgePath, 'nested', 'beta.md'), '# Beta\n\nSecond statement.\n')
  ])
  return { root, knowledgePath, store: new FileKnowledgeStore(knowledgePath) }
}

describe('FileKnowledgeStore', () => {
  it('reads, searches, and browses the authoritative Markdown files', async () => {
    const { store } = await fixture()
    expect(store.listStatements()).toEqual([
      { title: 'Alpha', content: 'Links to [[Beta]].' },
      { title: 'Beta', content: 'Second statement.' }
    ])
    await expect(store.read('Beta')).resolves.toEqual({
      title: 'Beta',
      content: 'Second statement.'
    })
    await expect(store.search('second', 10)).resolves.toEqual([
      { title: 'Beta', content: 'Second statement.' }
    ])
    expect(store.browse({ query: 'alpha' })).toMatchObject({
      total: 1,
      statements: [{ title: 'Alpha', preview: 'Links to [[Beta]].' }]
    })
  })

  it('rejects duplicate canonical titles across files', async () => {
    const { knowledgePath, store } = await fixture()
    await writeFile(join(knowledgePath, 'duplicate.md'), '# Alpha\n\nDuplicate.\n')
    expect(() => store.listStatements()).toThrow('canonical title 重复：Alpha')
  })
})

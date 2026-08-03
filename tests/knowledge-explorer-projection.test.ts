import { describe, expect, it } from 'vitest'
import { KnowledgeExplorerProjectionService } from '../src/main/knowledge-projection/knowledge-explorer-projection'
import type {
  BrowseKnowledgeInput,
  KnowledgeBrowseResult,
  KnowledgeStatement,
  ListKnowledgeStatementsOptions
} from '../src/shared/knowledge'

function reader(initialStatements: KnowledgeStatement[]) {
  let statements = initialStatements
  return {
    replace(next: KnowledgeStatement[]): void {
      statements = next
    },
    getStatement(title: string): KnowledgeStatement | undefined {
      return statements.find((statement) => statement.title === title)
    },
    listStatements(options: ListKnowledgeStatementsOptions = {}): KnowledgeStatement[] {
      const offset = options.offset ?? 0
      return statements.slice(offset, offset + (options.limit ?? 100))
    },
    browse(input: BrowseKnowledgeInput = {}): KnowledgeBrowseResult {
      const query = input.query?.toLocaleLowerCase()
      const matches = query
        ? statements.filter((statement) => `${statement.title}\n${statement.content}`.toLocaleLowerCase().includes(query))
        : statements
      const offset = input.offset ?? 0
      const page = matches.slice(offset, offset + (input.limit ?? 100))
      return {
        statements: page.map((statement) => ({ title: statement.title, preview: statement.content })),
        total: matches.length
      }
    }
  }
}

describe('KnowledgeExplorerProjectionService', () => {
  it('derives directional direct references, mutual roles and unresolved targets from the current view', () => {
    const source = reader([
      {
        title: 'Center',
        content: 'Uses [[Beta]] and repeats [[Beta|the beta statement]]. Missing [[Missing]].'
      },
      { title: 'Alpha', content: 'Explains [[Center]].' },
      { title: 'Beta', content: 'Also points back to [[Center]].' },
      { title: 'Gamma', content: 'Unrelated.' }
    ])
    const service = new KnowledgeExplorerProjectionService(source)

    expect(service.getNeighborhood('Center')).toEqual({
      centerTitle: 'Center',
      nodes: [
        {
          title: 'Center',
          excerpt: 'Uses Beta and repeats the beta statement. Missing Missing.',
          roles: []
        },
        { title: 'Alpha', excerpt: 'Explains Center.', roles: ['incoming'] },
        { title: 'Beta', excerpt: 'Also points back to Center.', roles: ['incoming', 'outgoing'] }
      ],
      edges: [
        { sourceTitle: 'Alpha', targetTitle: 'Center', occurrenceCount: 1 },
        { sourceTitle: 'Beta', targetTitle: 'Center', occurrenceCount: 1 },
        { sourceTitle: 'Center', targetTitle: 'Beta', occurrenceCount: 2 }
      ],
      groups: [
        { kind: 'incoming', memberTitles: ['Alpha', 'Beta'] },
        { kind: 'outgoing', memberTitles: ['Beta'] }
      ],
      unresolvedReferences: [
        { sourceTitle: 'Center', targetTitle: 'Missing', occurrenceCount: 1 }
      ]
    })
  })

  it('rebuilds references from changed Statement bodies instead of retaining an edge authority', () => {
    const source = reader([
      { title: 'Center', content: 'Current body.' },
      { title: 'Alpha', content: 'Links [[Center]].' }
    ])
    const service = new KnowledgeExplorerProjectionService(source)
    expect(service.getNeighborhood('Center')?.edges).toHaveLength(1)

    source.replace([
      { title: 'Center', content: 'Now links [[Alpha]].' },
      { title: 'Alpha', content: 'No link remains.' }
    ])

    expect(service.getNeighborhood('Center')?.edges).toEqual([
      { sourceTitle: 'Center', targetTitle: 'Alpha', occurrenceCount: 1 }
    ])
  })

  it('returns readable browse excerpts without wikilink markup', () => {
    const service = new KnowledgeExplorerProjectionService(reader([
      { title: 'Alpha', content: 'Uses [[Beta|the beta statement]].' }
    ]))

    expect(service.browse().statements).toEqual([
      { title: 'Alpha', preview: 'Uses the beta statement.' }
    ])
  })
})

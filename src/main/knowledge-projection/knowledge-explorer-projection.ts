import type {
  KnowledgeBrowseResult,
  KnowledgeNeighborhoodProjection,
  KnowledgeStatement,
  BrowseKnowledgeInput,
  ListKnowledgeStatementsOptions
} from '../../shared/knowledge'
import {
  knowledgeStatementExcerpt,
  parseKnowledgeStatementContent
} from '../../shared/knowledge-reference'

const SNAPSHOT_PAGE_SIZE = 1_000

export interface KnowledgeProjectionReader {
  getStatement(title: string): KnowledgeStatement | undefined
  listStatements(options?: ListKnowledgeStatementsOptions): KnowledgeStatement[]
  browse(input?: BrowseKnowledgeInput): KnowledgeBrowseResult
}

function compareTitles(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: 'base' }) || left.localeCompare(right)
}

function readCurrentKnowledgeView(reader: KnowledgeProjectionReader): KnowledgeStatement[] {
  const statements: KnowledgeStatement[] = []
  let offset = 0
  while (true) {
    const page = reader.listStatements({ limit: SNAPSHOT_PAGE_SIZE, offset })
    statements.push(...page)
    if (page.length < SNAPSHOT_PAGE_SIZE) return statements
    offset += page.length
  }
}

/**
 * Read-only, rebuildable projection over the current Knowledge Statement view.
 * The Store remains authoritative; edges and groups returned here are snapshots.
 */
export class KnowledgeExplorerProjectionService {
  constructor(private readonly reader: KnowledgeProjectionReader) {}

  browse(input: BrowseKnowledgeInput = {}): KnowledgeBrowseResult {
    const result = this.reader.browse(input)
    return {
      ...result,
      statements: result.statements.map((statement) => ({
        ...statement,
        preview: knowledgeStatementExcerpt(
          this.reader.getStatement(statement.title)?.content ?? statement.preview,
          220
        )
      }))
    }
  }

  getNeighborhood(centerTitle: string): KnowledgeNeighborhoodProjection | undefined {
    const center = this.reader.getStatement(centerTitle)
    if (!center) return undefined

    const statements = readCurrentKnowledgeView(this.reader)
    const statementsByTitle = new Map(statements.map((statement) => [statement.title, statement]))
    if (!statementsByTitle.has(center.title)) statementsByTitle.set(center.title, center)

    const edgeCounts = new Map<string, {
      sourceTitle: string
      targetTitle: string
      occurrenceCount: number
    }>()
    const unresolvedCounts = new Map<string, number>()

    for (const statement of statementsByTitle.values()) {
      for (const part of parseKnowledgeStatementContent(statement.content)) {
        if (part.kind !== 'reference') continue
        const target = statementsByTitle.get(part.targetTitle)
        if (!target) {
          if (statement.title === center.title) {
            unresolvedCounts.set(part.targetTitle, (unresolvedCounts.get(part.targetTitle) ?? 0) + 1)
          }
          continue
        }
        if (statement.title !== center.title && target.title !== center.title) continue

        const key = JSON.stringify([statement.title, target.title])
        const existing = edgeCounts.get(key)
        if (existing) existing.occurrenceCount += 1
        else {
          edgeCounts.set(key, {
            sourceTitle: statement.title,
            targetTitle: target.title,
            occurrenceCount: 1
          })
        }
      }
    }

    const edges = [...edgeCounts.values()].sort((left, right) => (
      compareTitles(left.sourceTitle, right.sourceTitle)
      || compareTitles(left.targetTitle, right.targetTitle)
    ))
    const rolesByTitle = new Map<string, Set<'incoming' | 'outgoing'>>()
    for (const edge of edges) {
      if (edge.targetTitle === center.title && edge.sourceTitle !== center.title) {
        const roles = rolesByTitle.get(edge.sourceTitle) ?? new Set()
        roles.add('incoming')
        rolesByTitle.set(edge.sourceTitle, roles)
      }
      if (edge.sourceTitle === center.title && edge.targetTitle !== center.title) {
        const roles = rolesByTitle.get(edge.targetTitle) ?? new Set()
        roles.add('outgoing')
        rolesByTitle.set(edge.targetTitle, roles)
      }
    }

    const neighborTitles = [...rolesByTitle.keys()].sort(compareTitles)
    const nodes = [center.title, ...neighborTitles].map((title) => {
      const statement = statementsByTitle.get(title)
      if (!statement) throw new Error(`Knowledge neighborhood 缺少 Statement：${title}`)
      const roles = rolesByTitle.get(title)
      return {
        title,
        excerpt: knowledgeStatementExcerpt(statement.content),
        roles: roles ? [...roles].sort() : []
      }
    })
    const incomingTitles = neighborTitles.filter((title) => rolesByTitle.get(title)?.has('incoming'))
    const outgoingTitles = neighborTitles.filter((title) => rolesByTitle.get(title)?.has('outgoing'))

    return {
      centerTitle: center.title,
      nodes,
      edges,
      groups: [
        { kind: 'incoming', memberTitles: incomingTitles },
        { kind: 'outgoing', memberTitles: outgoingTitles }
      ],
      unresolvedReferences: [...unresolvedCounts.entries()]
        .sort(([left], [right]) => compareTitles(left, right))
        .map(([targetTitle, occurrenceCount]) => ({
          sourceTitle: center.title,
          targetTitle,
          occurrenceCount
        }))
    }
  }
}

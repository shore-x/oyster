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
const LOCAL_GRAPH_DEPTH = 2

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
 * The repository's knowledge/ files remain authoritative; edges and groups are snapshots.
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

    const allEdges = [...edgeCounts.values()].sort((left, right) => (
      compareTitles(left.sourceTitle, right.sourceTitle)
      || compareTitles(left.targetTitle, right.targetTitle)
    ))
    const neighborsByTitle = new Map<string, Set<string>>()
    for (const edge of allEdges) {
      if (edge.sourceTitle === edge.targetTitle) continue
      const sourceNeighbors = neighborsByTitle.get(edge.sourceTitle) ?? new Set<string>()
      sourceNeighbors.add(edge.targetTitle)
      neighborsByTitle.set(edge.sourceTitle, sourceNeighbors)
      const targetNeighbors = neighborsByTitle.get(edge.targetTitle) ?? new Set<string>()
      targetNeighbors.add(edge.sourceTitle)
      neighborsByTitle.set(edge.targetTitle, targetNeighbors)
    }

    const distanceByTitle = new Map([[center.title, 0]])
    const queue = [center.title]
    for (let index = 0; index < queue.length; index += 1) {
      const title = queue[index]
      const distance = distanceByTitle.get(title)
      if (distance === undefined || distance >= LOCAL_GRAPH_DEPTH) continue
      const neighbors = [...(neighborsByTitle.get(title) ?? [])].sort(compareTitles)
      for (const neighborTitle of neighbors) {
        if (distanceByTitle.has(neighborTitle)) continue
        distanceByTitle.set(neighborTitle, distance + 1)
        queue.push(neighborTitle)
      }
    }

    const localTitles = [...distanceByTitle.keys()].sort((left, right) => (
      (distanceByTitle.get(left) ?? 0) - (distanceByTitle.get(right) ?? 0)
      || compareTitles(left, right)
    ))
    const localTitleSet = new Set(localTitles)
    const nodes = localTitles.map((title) => {
      const statement = statementsByTitle.get(title)
      if (!statement) throw new Error(`Knowledge neighborhood 缺少 Statement：${title}`)
      return {
        title,
        excerpt: knowledgeStatementExcerpt(statement.content),
        distance: distanceByTitle.get(title) ?? 0
      }
    })
    const edges = allEdges.filter((edge) => (
      localTitleSet.has(edge.sourceTitle) && localTitleSet.has(edge.targetTitle)
    ))

    return {
      centerTitle: center.title,
      depth: LOCAL_GRAPH_DEPTH,
      nodes,
      edges,
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

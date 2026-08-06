export const MAX_KNOWLEDGE_STATEMENT_CONTENT_LENGTH = 1_024 * 1_024
export const MAX_KNOWLEDGE_STATEMENT_TITLE_LENGTH = 2_048

/** The complete MVP knowledge object: one canonical title and its free-text body. */
export interface KnowledgeStatement {
  title: string
  content: string
}


export interface ListKnowledgeStatementsOptions {
  limit?: number
  offset?: number
}

export interface BrowseKnowledgeInput extends ListKnowledgeStatementsOptions {
  query?: string
}

export interface KnowledgeStatementSummary {
  title: string
  preview: string
}

export interface KnowledgeBrowseResult {
  statements: KnowledgeStatementSummary[]
  total: number
  nextOffset?: number
}

export interface KnowledgeNeighborhoodNode {
  title: string
  excerpt: string
  /** Undirected shortest-path distance from the center in this local projection. */
  distance: number
}

export interface KnowledgeReferenceEdge {
  /** The Statement whose body contains the reference. */
  sourceTitle: string
  /** The dynamically resolved canonical title. */
  targetTitle: string
  occurrenceCount: number
}

export interface UnresolvedKnowledgeReference {
  sourceTitle: string
  targetTitle: string
  occurrenceCount: number
}

/** Rebuildable, UI-independent local reference projection over one current Statement. */
export interface KnowledgeNeighborhoodProjection {
  centerTitle: string
  /** Current extraction depth; it is a projection parameter rather than Statement semantics. */
  depth: number
  nodes: KnowledgeNeighborhoodNode[]
  edges: KnowledgeReferenceEdge[]
  unresolvedReferences: UnresolvedKnowledgeReference[]
}

export interface ClearKnowledgeResult {
  deletedStatementCount: number
}

export interface KnowledgeApi {
  browse(input?: BrowseKnowledgeInput): Promise<KnowledgeBrowseResult>
  read(title: string): Promise<KnowledgeStatement | undefined>
  getNeighborhood(title: string): Promise<KnowledgeNeighborhoodProjection | undefined>
  clear(): Promise<ClearKnowledgeResult>
}

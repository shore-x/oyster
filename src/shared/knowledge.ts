/** Per-Statement persistence boundary shared by producers and the Store. */
export const MAX_KNOWLEDGE_STATEMENT_CONTENT_LENGTH = 1_024 * 1_024
export const MAX_KNOWLEDGE_STATEMENT_TITLE_LENGTH = 2_048

/** Runtime envelope metadata. It is not part of Statement semantics. */
export interface KnowledgeContributionRecord {
  runRef: string
  createdAt: string
}

/** The complete MVP knowledge object: one canonical title and its free-text body. */
export interface KnowledgeStatement {
  title: string
  content: string
}

export interface KnowledgeStatementDraft {
  title: string
  content: string
}

export interface KnowledgeContributionDraft {
  /** Identifies the processing run that submitted this atomic write envelope. */
  runRef: string
  statements: KnowledgeStatementDraft[]
}

export interface KnowledgeCommitResult {
  contribution: KnowledgeContributionRecord
  statements: KnowledgeStatement[]
  createdTitles: string[]
  updatedTitles: string[]
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

export type KnowledgeNeighborhoodRole = 'incoming' | 'outgoing'

export interface KnowledgeNeighborhoodNode {
  title: string
  excerpt: string
  /** A node may have both roles when it and the center reference each other. */
  roles: KnowledgeNeighborhoodRole[]
}

export interface KnowledgeReferenceEdge {
  /** The Statement whose body contains the reference. */
  sourceTitle: string
  /** The dynamically resolved canonical title. */
  targetTitle: string
  occurrenceCount: number
}

export interface KnowledgeNeighborhoodGroup {
  kind: KnowledgeNeighborhoodRole
  memberTitles: string[]
}

export interface UnresolvedKnowledgeReference {
  sourceTitle: string
  targetTitle: string
  occurrenceCount: number
}

/** Rebuildable, UI-independent projection over one current Statement. */
export interface KnowledgeNeighborhoodProjection {
  centerTitle: string
  nodes: KnowledgeNeighborhoodNode[]
  edges: KnowledgeReferenceEdge[]
  groups: KnowledgeNeighborhoodGroup[]
  unresolvedReferences: UnresolvedKnowledgeReference[]
}

export interface ClearKnowledgeResult {
  deletedStatementCount: number
  deletedContributionCount: number
}

export interface KnowledgeApi {
  browse(input?: BrowseKnowledgeInput): Promise<KnowledgeBrowseResult>
  read(title: string): Promise<KnowledgeStatement | undefined>
  getNeighborhood(title: string): Promise<KnowledgeNeighborhoodProjection | undefined>
  clear(): Promise<ClearKnowledgeResult>
}

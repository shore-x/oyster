export const KNOWLEDGE_RELATION_KINDS = ['derived_from', 'revises'] as const

/** Per-Statement persistence boundary shared by producers and the authoritative Store. */
export const MAX_KNOWLEDGE_STATEMENT_CONTENT_LENGTH = 1_024 * 1_024

export type KnowledgeRelationKind = typeof KNOWLEDGE_RELATION_KINDS[number]

export interface KnowledgeContributionRecord {
  id: string
  runRef: string
  createdAt: string
}

export interface KnowledgeStatement {
  id: string
  title: string
  content: string
  originRef: string
  createdAt: string
}

export interface KnowledgeStatementSource {
  statementId: string
  sourceRef: string
  selector?: string
}

export interface KnowledgeStatementRelation {
  sourceStatementId: string
  relation: KnowledgeRelationKind
  targetStatementId: string
}

export interface KnowledgeSourceDraft {
  sourceRef: string
  selector?: string
}

export type KnowledgeRelationTarget =
  | { kind: 'statement'; statementId: string }
  | { kind: 'draft'; localRef: string }

export interface KnowledgeRelationDraft {
  relation: KnowledgeRelationKind
  target: KnowledgeRelationTarget
}

export interface KnowledgeStatementDraft {
  /**
   * A contribution-local handle. It is never persisted as the Statement identity.
   * Oyster Core allocates every persistent Statement ID at commit time.
   */
  localRef: string
  title: string
  content: string
  sources?: KnowledgeSourceDraft[]
  relations?: KnowledgeRelationDraft[]
}

export interface KnowledgeContributionDraft {
  /** Stable identity of the run that submitted this one final contribution. */
  runRef: string
  statements: KnowledgeStatementDraft[]
}

export interface KnowledgeCommitResult {
  contribution: KnowledgeContributionRecord
  statements: KnowledgeStatement[]
  sources: KnowledgeStatementSource[]
  relations: KnowledgeStatementRelation[]
  statementIdsByLocalRef: Record<string, string>
}

export interface KnowledgeStatementDetails {
  statement: KnowledgeStatement
  sources: KnowledgeStatementSource[]
  outgoingRelations: KnowledgeStatementRelation[]
  incomingRelations: KnowledgeStatementRelation[]
}

export interface ListKnowledgeStatementsOptions {
  /** Include Statements superseded by an incoming `revises` relation. */
  includeRevised?: boolean
  limit?: number
  offset?: number
}

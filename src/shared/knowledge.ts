/** Per-Statement persistence boundary shared by producers and the Store. */
export const MAX_KNOWLEDGE_STATEMENT_CONTENT_LENGTH = 1_024 * 1_024

/** Runtime envelope metadata. It is not part of Statement semantics. */
export interface KnowledgeContributionRecord {
  id: string
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

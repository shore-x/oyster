export * from '../../shared/knowledge'

import type { KnowledgeStatement } from '../../shared/knowledge'

export interface KnowledgeStatementRecord {
  title: string
  content: string
}

export interface KnowledgeReader {
  search(
    query: string,
    limit: number,
    offset?: number,
    signal?: AbortSignal
  ): Promise<KnowledgeStatementRecord[]>
  read(title: string, signal?: AbortSignal): Promise<KnowledgeStatement | undefined>
}

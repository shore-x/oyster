import {
  MAX_KNOWLEDGE_STATEMENT_CONTENT_LENGTH,
  MAX_KNOWLEDGE_STATEMENT_TITLE_LENGTH,
  type KnowledgeContributionDraft,
  type KnowledgeStatementDraft
} from '../../shared/knowledge'

const MAX_DRAFT_LIST_LIMIT = 100

export interface ContributionDraftListPage {
  statements: KnowledgeStatementDraft[]
  offset: number
  nextOffset?: number
  total: number
}

function requiredText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string') throw new Error(`${label} 必须是字符串`)
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} 不能为空`)
  if (normalized.length > maximum) throw new Error(`${label} 超出长度上限 ${maximum}`)
  return normalized
}

function listBoundary(value: number | undefined, fallback: number, maximum: number, label: string): number {
  const normalized = value ?? fallback
  if (!Number.isSafeInteger(normalized) || normalized < 0 || normalized > maximum) {
    throw new Error(`${label} 无效`)
  }
  return normalized
}

/** Run-local, disposable Statement drafts. Nothing is persisted until final submission. */
export class KnowledgeContributionWorkspace {
  private readonly statements = new Map<string, KnowledgeStatementDraft>()
  /** Stable insertion slots keep pagination valid while drafts are removed or replaced. */
  private readonly statementTitles: string[] = []
  private readonly knownTitles = new Set<string>()

  upsert(input: KnowledgeStatementDraft): KnowledgeStatementDraft {
    if (!input || typeof input !== 'object') throw new Error('Statement 草稿格式无效')
    const title = requiredText(
      input.title,
      'Statement title',
      MAX_KNOWLEDGE_STATEMENT_TITLE_LENGTH
    )
    if (typeof input.content !== 'string' || !input.content.trim()) {
      throw new Error(`${title} content 不能为空`)
    }
    if (input.content.length > MAX_KNOWLEDGE_STATEMENT_CONTENT_LENGTH) {
      throw new Error(`${title} content 超出长度上限 ${MAX_KNOWLEDGE_STATEMENT_CONTENT_LENGTH}`)
    }
    const statement = { title, content: input.content }
    if (!this.knownTitles.has(title)) {
      this.knownTitles.add(title)
      this.statementTitles.push(title)
    }
    this.statements.set(title, statement)
    return structuredClone(statement)
  }

  read(titleInput: string): KnowledgeStatementDraft | undefined {
    const title = requiredText(
      titleInput,
      'Statement title',
      MAX_KNOWLEDGE_STATEMENT_TITLE_LENGTH
    )
    const statement = this.statements.get(title)
    return statement ? structuredClone(statement) : undefined
  }

  remove(titleInput: string): boolean {
    const title = requiredText(
      titleInput,
      'Statement title',
      MAX_KNOWLEDGE_STATEMENT_TITLE_LENGTH
    )
    return this.statements.delete(title)
  }

  list(limitInput?: number, offsetInput?: number): ContributionDraftListPage {
    const limit = listBoundary(limitInput, 20, MAX_DRAFT_LIST_LIMIT, 'limit')
    if (limit < 1) throw new Error('limit 必须大于 0')
    const offset = listBoundary(offsetInput, 0, Number.MAX_SAFE_INTEGER, 'offset')
    const statements: KnowledgeStatementDraft[] = []
    let nextTitleIndex = Math.min(offset, this.statementTitles.length)
    while (nextTitleIndex < this.statementTitles.length && statements.length < limit) {
      const statement = this.statements.get(this.statementTitles[nextTitleIndex++])
      if (statement) statements.push(structuredClone(statement))
    }
    const nextOffset = this.statementTitles
      .slice(nextTitleIndex)
      .some((title) => this.statements.has(title))
      ? nextTitleIndex
      : undefined
    return {
      statements,
      offset,
      ...(nextOffset === undefined ? {} : { nextOffset }),
      total: this.statements.size
    }
  }

  get size(): number {
    return this.statements.size
  }

  contribution(runRef: string): KnowledgeContributionDraft {
    const normalizedRunRef = requiredText(runRef, 'runRef', 1_024)
    return {
      runRef: normalizedRunRef,
      statements: this.statementTitles.flatMap((title) => {
        const statement = this.statements.get(title)
        return statement ? [structuredClone(statement)] : []
      })
    }
  }
}

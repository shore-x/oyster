import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import type {
  BrowseKnowledgeInput,
  ClearKnowledgeResult,
  KnowledgeBrowseResult,
  KnowledgeStatement,
  ListKnowledgeStatementsOptions
} from '../../shared/knowledge'
import {
  MAX_KNOWLEDGE_STATEMENT_TITLE_LENGTH
} from '../../shared/knowledge'
import type { KnowledgeReader, KnowledgeStatementRecord } from './model'

const MAX_LIST_LIMIT = 1_000
const MAX_SEARCH_LIMIT = 100

function requiredTitle(value: unknown): string {
  if (typeof value !== 'string') throw new Error('title 必须是字符串')
  const title = value.trim()
  if (!title) throw new Error('title 不能为空')
  if (title.length > MAX_KNOWLEDGE_STATEMENT_TITLE_LENGTH) {
    throw new Error(`title 超出长度上限 ${MAX_KNOWLEDGE_STATEMENT_TITLE_LENGTH}`)
  }
  return title
}

function normalizeLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`limit 必须是 1 到 ${maximum} 之间的整数`)
  }
  return value
}

function normalizeOffset(value: number | undefined): number {
  if (value === undefined) return 0
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('offset 必须是非负整数')
  return value
}

function markdownPaths(rootPath: string, currentPath = rootPath): string[] {
  const paths: string[] = []
  for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const path = join(currentPath, entry.name)
    if (entry.isDirectory()) paths.push(...markdownPaths(rootPath, path))
    else if (entry.isFile() && entry.name.endsWith('.md')) paths.push(path)
  }
  return paths.sort((left, right) => left.localeCompare(right))
}

function parseStatement(path: string, document: string): KnowledgeStatement {
  const normalized = document.replace(/\r\n/g, '\n')
  const firstBreak = normalized.indexOf('\n')
  if (firstBreak < 0 || !normalized.startsWith('# ')) {
    throw new Error(`Knowledge 文件必须以 canonical title H1 开始：${path}`)
  }
  const title = requiredTitle(normalized.slice(2, firstBreak))
  if (normalized[firstBreak + 1] !== '\n') {
    throw new Error(`Knowledge title 与正文之间必须有一个空行：${path}`)
  }
  const rawContent = normalized.slice(firstBreak + 2)
  const content = rawContent.endsWith('\n') ? rawContent.slice(0, -1) : rawContent
  if (!content.trim()) throw new Error(`Knowledge content 不能为空：${path}`)
  return { title, content }
}

function compareTitles(left: KnowledgeStatement, right: KnowledgeStatement): number {
  return left.title.localeCompare(right.title, undefined, { sensitivity: 'base' })
    || left.title.localeCompare(right.title)
}

/** File-backed view over the repository's authoritative knowledge/ layer. */
export class FileKnowledgeStore implements KnowledgeReader {
  readonly knowledgePath: string

  constructor(knowledgePath: string) {
    this.knowledgePath = resolve(knowledgePath)
    mkdirSync(this.knowledgePath, { recursive: true })
  }

  private statements(): KnowledgeStatement[] {
    const statements = markdownPaths(this.knowledgePath).map((path) => (
      parseStatement(relative(this.knowledgePath, path), readFileSync(path, 'utf8'))
    ))
    const titles = new Set<string>()
    for (const statement of statements) {
      if (titles.has(statement.title)) {
        throw new Error(`canonical title 重复：${statement.title}`)
      }
      titles.add(statement.title)
    }
    return statements.sort(compareTitles)
  }

  async search(
    query: string,
    limit = 8,
    offset = 0,
    signal?: AbortSignal
  ): Promise<KnowledgeStatementRecord[]> {
    signal?.throwIfAborted()
    const normalizedQuery = requiredTitle(query).toLocaleLowerCase()
    const normalizedLimit = normalizeLimit(limit, 8, MAX_SEARCH_LIMIT)
    const normalizedOffset = normalizeOffset(offset)
    const matches = this.statements().filter((statement) => (
      statement.title.toLocaleLowerCase().includes(normalizedQuery)
      || statement.content.toLocaleLowerCase().includes(normalizedQuery)
    ))
    signal?.throwIfAborted()
    return matches.slice(normalizedOffset, normalizedOffset + normalizedLimit)
  }

  async read(title: string, signal?: AbortSignal): Promise<KnowledgeStatement | undefined> {
    signal?.throwIfAborted()
    const statement = this.getStatement(title)
    signal?.throwIfAborted()
    return statement
  }

  listStatements(options: ListKnowledgeStatementsOptions = {}): KnowledgeStatement[] {
    const limit = normalizeLimit(options.limit, 100, MAX_LIST_LIMIT)
    const offset = normalizeOffset(options.offset)
    return this.statements().slice(offset, offset + limit)
  }

  browse(input: BrowseKnowledgeInput = {}): KnowledgeBrowseResult {
    const limit = normalizeLimit(input.limit, 100, MAX_LIST_LIMIT)
    const offset = normalizeOffset(input.offset)
    const query = typeof input.query === 'string' ? input.query.trim().toLocaleLowerCase() : ''
    if (query.length > 1_024) throw new Error('搜索 query 超出长度上限 1024')
    const matches = query
      ? this.statements().filter((statement) => (
          statement.title.toLocaleLowerCase().includes(query)
          || statement.content.toLocaleLowerCase().includes(query)
        ))
      : this.statements()
    const page = matches.slice(offset, offset + limit)
    return {
      statements: page.map((statement) => ({
        title: statement.title,
        preview: statement.content.slice(0, 280)
      })),
      total: matches.length,
      ...(offset + page.length < matches.length ? { nextOffset: offset + page.length } : {})
    }
  }

  getStatement(title: string): KnowledgeStatement | undefined {
    const normalizedTitle = requiredTitle(title)
    return this.statements().find((statement) => statement.title === normalizedTitle)
  }

  clear(): ClearKnowledgeResult {
    const paths = markdownPaths(this.knowledgePath)
    for (const path of paths) rmSync(path)
    for (const path of [...new Set(paths.map((path) => resolve(path, '..')))]) {
      if (path !== this.knowledgePath && statSync(path).isDirectory()) {
        try { rmSync(path, { recursive: false }) } catch { /* non-empty parent remains */ }
      }
    }
    writeFileSync(join(this.knowledgePath, '.gitkeep'), '', { flag: 'a' })
    return { deletedStatementCount: paths.length }
  }
}

import {
  Agent,
  type AgentMessage,
  type AgentTool,
  type StreamFn
} from '@earendil-works/pi-agent-core'
import {
  Type,
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
  type Usage
} from '@earendil-works/pi-ai'
import { ModelConnectionFailureError } from '../ai-backends/model'
import type { ModelRuntime } from '../ai-backends/model'
import {
  createPiContextCompactor,
  PiContextCompactionOutputError,
  PiContextWindowError
} from '../agent-runtime/pi-context-compactor'
import {
  formatEvidenceLocation,
  formatEvidenceReadPage,
  MAX_EVIDENCE_READ_LIMIT,
  observationLineAddress,
  readEvidencePage,
  splitsSurrogatePair
} from '../observation/evidence-location'
import {
  MAX_KNOWLEDGE_STATEMENT_CONTENT_LENGTH,
  MAX_KNOWLEDGE_STATEMENT_TITLE_LENGTH,
  type KnowledgeContributionDraft,
  type KnowledgeStatement,
  type KnowledgeStatementDraft
} from '../../shared/knowledge'
import { REASONING_EFFORTS } from '../../shared/ai-backends'
import type {
  KnowledgeAgentRunInput,
  KnowledgeAgentRunResult,
  KnowledgeAgentRuntime,
  KnowledgeReader,
  KnowledgeStatementRecord
} from './model'
import {
  InMemoryStatementCandidateAgenda,
  MAX_STATEMENT_CANDIDATE_EXPRESSION_CHARACTERS,
  MAX_STATEMENT_CANDIDATE_QUESTION_CHARACTERS,
  type StatementCandidateInput
} from './statement-candidate-agenda'
import { KnowledgeContributionWorkspace } from './knowledge-contribution-workspace'

const MAX_EVIDENCE_OUTPUT_CHARS = 64 * 1_024
const MAX_SEARCH_RESULTS = 20
const MAX_WORKSPACE_LIST_RESULTS = 100
const WORKSPACE_STATUS_CONTEXT_TOKENS = 2_048
const UNKNOWN_TRACE_TOOL_NAME = '未知工具'

const TRACEABLE_TOOL_NAMES = new Set([
  'search_knowledge',
  'read_knowledge_statement',
  'list_statement_candidates',
  'add_statement_candidates',
  'resolve_statement_candidates',
  'upsert_contribution_statement',
  'read_contribution_statement',
  'list_contribution_statements',
  'remove_contribution_statement',
  'read_evidence',
  'submit_knowledge_contribution'
])

const searchKnowledgeParameters = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 1_024 }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SEARCH_RESULTS })),
  offset: Type.Optional(Type.Integer({ minimum: 0 }))
}, { additionalProperties: false })

const readKnowledgeParameters = Type.Object({
  title: Type.String({ minLength: 1, maxLength: MAX_KNOWLEDGE_STATEMENT_TITLE_LENGTH })
}, { additionalProperties: false })

const readEvidenceParameters = Type.Object({
  line: Type.Integer({ minimum: 1 }),
  offset: Type.Integer({ minimum: 0 }),
  limit: Type.Integer({ minimum: 2 })
}, { additionalProperties: false })

const listStatementCandidatesParameters = Type.Object({
  status: Type.Optional(Type.Union([Type.Literal('open'), Type.Literal('resolved')])),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_WORKSPACE_LIST_RESULTS })),
  offset: Type.Optional(Type.Integer({ minimum: 0 }))
}, { additionalProperties: false })

const candidateLocationParameters = Type.Object({
  line: Type.Integer({ minimum: 1 }),
  offset: Type.Integer({ minimum: 0 })
}, { additionalProperties: false })

const addStatementCandidatesParameters = Type.Object({
  candidates: Type.Array(Type.Object({
    expression: Type.String({ minLength: 1, maxLength: MAX_STATEMENT_CANDIDATE_EXPRESSION_CHARACTERS }),
    question: Type.String({ minLength: 1, maxLength: MAX_STATEMENT_CANDIDATE_QUESTION_CHARACTERS }),
    locations: Type.Optional(Type.Array(candidateLocationParameters))
  }, { additionalProperties: false }))
}, { additionalProperties: false })

const resolveStatementCandidatesParameters = Type.Object({
  resolutions: Type.Array(Type.Object({
    ref: Type.String({ minLength: 1, maxLength: 64 }),
    resolution: Type.String({ minLength: 1, maxLength: 16 * 1_024 })
  }, { additionalProperties: false }))
}, { additionalProperties: false })

const contributionStatementParameters = Type.Object({
  title: Type.String({
    minLength: 1,
    maxLength: MAX_KNOWLEDGE_STATEMENT_TITLE_LENGTH,
    description: 'The established proper name, term, or natural noun phrase that identifies this Statement subject. Put scenarios, attributes, and relationships in content instead of turning them into a topic-style title.'
  }),
  content: Type.String({
    minLength: 1,
    maxLength: MAX_KNOWLEDGE_STATEMENT_CONTENT_LENGTH,
    description: 'The self-explaining free-text knowledge about the named subject, including its scope, properties, constraints, and natural-language relationships to [[other Statements]].'
  })
}, { additionalProperties: false })

const readContributionStatementParameters = Type.Object({
  title: Type.String({ minLength: 1, maxLength: MAX_KNOWLEDGE_STATEMENT_TITLE_LENGTH })
}, { additionalProperties: false })

const listContributionStatementsParameters = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_WORKSPACE_LIST_RESULTS })),
  offset: Type.Optional(Type.Integer({ minimum: 0 }))
}, { additionalProperties: false })

const removeContributionStatementParameters = Type.Object({
  title: Type.String({ minLength: 1, maxLength: MAX_KNOWLEDGE_STATEMENT_TITLE_LENGTH })
}, { additionalProperties: false })

const submitContributionParameters = Type.Object({
}, { additionalProperties: false })

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  }
}

function failedModelStream(model: Model<Api>, message: string) {
  const stream = createAssistantMessageEventStream()
  const output: AssistantMessage = {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: 'error',
    errorMessage: message,
    timestamp: Date.now()
  }
  stream.push({ type: 'error', reason: 'error', error: output })
  stream.end(output)
  return stream
}

function asError(error: unknown, fallback: string): Error {
  if (error instanceof Error) return error
  if (typeof error === 'string' && error) return new Error(error)
  return new Error(fallback)
}

function compactInline(value: string, maximum: number): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  if (compact.length <= maximum) return compact
  return `${compact.slice(0, maximum - 1)}…`
}

function safeTraceInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined
}

function safeTraceToolName(value: string): string {
  return TRACEABLE_TOOL_NAMES.has(value) ? value : UNKNOWN_TRACE_TOOL_NAME
}

function safeToolErrorCategory(toolName: string, result: unknown): string {
  if (!TRACEABLE_TOOL_NAMES.has(toolName)) return '工具调用失败'
  const errorText = result instanceof Error
    ? result.message
    : typeof result === 'string'
      ? result
      : (() => {
          try {
            return JSON.stringify(result)
          } catch {
            return ''
          }
        })()
  if (toolName === 'read_evidence') {
    if (/不存在|失效|revision|unavailable/i.test(errorText)) return '原始证据不可用'
    if (/line|offset|location|位置|参数|property|integer|unicode/i.test(errorText)) {
      return '证据读取位置或参数无效'
    }
    if (/预算|上限|output/i.test(errorText)) return '证据读取预算不足'
  }
  return '工具调用失败'
}

function safeTraceDetails(toolName: string, result: unknown, isError: boolean): string | undefined {
  if (isError) return safeToolErrorCategory(toolName, result)
  if (!result || typeof result !== 'object') return undefined
  const details = (result as { details?: unknown }).details
  if (!details || typeof details !== 'object') return undefined
  const record = details as Record<string, unknown>
  if (toolName === 'search_knowledge') {
    const count = safeTraceInteger(record.count)
    return count === undefined ? undefined : `返回 ${count} 条候选知识`
  }
  if (toolName === 'read_knowledge_statement') {
    return typeof record.found === 'boolean' ? (record.found ? '已找到 Statement' : '未找到 Statement') : undefined
  }
  if (
    toolName === 'list_statement_candidates'
    || toolName === 'add_statement_candidates'
    || toolName === 'resolve_statement_candidates'
  ) {
    const open = safeTraceInteger(record.open)
    const resolved = safeTraceInteger(record.resolved)
    const total = safeTraceInteger(record.total)
    return open === undefined || resolved === undefined || total === undefined
      ? undefined
      : `候选 ${resolved}/${total} 已处置 · ${open} 个待处理`
  }
  if (
    toolName === 'upsert_contribution_statement'
    || toolName === 'read_contribution_statement'
    || toolName === 'list_contribution_statements'
    || toolName === 'remove_contribution_statement'
  ) {
    const draftStatementCount = safeTraceInteger(record.draftStatementCount)
    return draftStatementCount === undefined ? undefined : `Contribution 草稿 ${draftStatementCount} 条`
  }
  if (toolName === 'read_evidence') {
    const start = typeof record.start === 'string' && /^L\d{6,}:C\d+$/.test(record.start)
      ? record.start
      : undefined
    const end = typeof record.end === 'string' && /^L\d{6,}:C\d+$/.test(record.end)
      ? record.end
      : undefined
    const returnedCharacters = safeTraceInteger(record.returnedCharacters)
    const next = typeof record.next === 'string' && /^L\d{6,}:C\d+$/.test(record.next)
      ? `next ${record.next}`
      : record.next === null
        ? 'EOF'
        : undefined
    return [
      start && end ? `${start}-${end}` : start,
      returnedCharacters === undefined ? undefined : `${returnedCharacters} 字符`,
      next
    ].filter(Boolean).join(' · ') || undefined
  }
  if (toolName === 'submit_knowledge_contribution') {
    const statementCount = safeTraceInteger(record.statementCount)
    const accepted = record.accepted === true
    const open = safeTraceInteger(record.open)
    if (!accepted && open !== undefined) return `仍有 ${open} 个候选待处理`
    return statementCount === undefined ? undefined : `提交 ${statementCount} 条 Statement 草稿`
  }
  return undefined
}

function modelTraceDetail(message: AssistantMessage): string {
  const toolNames = message.content
    .filter((content) => content.type === 'toolCall')
    .map((content) => safeTraceToolName(content.name))
  return [
    `stop=${message.stopReason}`,
    `tokens=${message.usage.totalTokens}`,
    toolNames.length ? `tools=${toolNames.join(', ')}` : undefined
  ].filter((part): part is string => Boolean(part)).join(' · ')
}

function traceJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

function modelTraceOutput(message: AssistantMessage): string | undefined {
  const blocks = message.content.flatMap((content) => {
    if (content.type === 'text') return content.text.trim() ? [content.text] : []
    if (content.type === 'thinking') {
      if (content.redacted) return ['Reasoning\n[redacted by provider]']
      return content.thinking.trim() ? [`Reasoning\n${content.thinking}`] : []
    }
    const toolName = safeTraceToolName(content.name)
    return [toolName === UNKNOWN_TRACE_TOOL_NAME
      ? `Tool call · ${toolName}\n[arguments hidden]`
      : `Tool call · ${toolName}\n${traceJson(content.arguments)}`]
  })
  if (message.errorMessage) blocks.push(`Error\n${message.errorMessage}`)
  return blocks.length ? blocks.join('\n\n') : undefined
}

function toolTraceOutput(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return result === undefined ? undefined : traceJson(result)
  const record = result as { content?: unknown; details?: unknown }
  const blocks: string[] = []
  if (Array.isArray(record.content)) {
    for (const content of record.content) {
      if (!content || typeof content !== 'object') {
        blocks.push(traceJson(content))
        continue
      }
      const item = content as Record<string, unknown>
      if (item.type === 'text' && typeof item.text === 'string') {
        blocks.push(item.text)
      } else if (item.type === 'image' && typeof item.mimeType === 'string') {
        blocks.push(`[Image result · ${item.mimeType}]`)
      } else {
        blocks.push(traceJson(item))
      }
    }
  }
  if (record.details !== undefined) blocks.push(`Details\n${traceJson(record.details)}`)
  return blocks.filter((block) => block.trim()).join('\n\n') || undefined
}

function searchResultText(
  records: KnowledgeStatementRecord[],
  offset: number,
  hasNextPage: boolean
): string {
  if (!records.length) return '没有找到更多相关 Knowledge Statement。\nNext offset: none'
  const lines = records.map((record) => [
    `- 标题: ${compactInline(record.title, 512)}`,
    `  内容预览: ${compactInline(record.content, 1_024)}`
  ].join('\n'))
  const nextOffset = hasNextPage ? offset + records.length : undefined
  return [
    ...lines,
    '',
    `Next offset: ${nextOffset ?? 'none'}`
  ].join('\n')
}

function statementResultText(statement: KnowledgeStatement): string {
  return [
    `Title: ${statement.title}`,
    'Content:',
    statement.content
  ].join('\n')
}

function validateRunInput(input: KnowledgeAgentRunInput): void {
  if (!input.systemPrompt.trim()) throw new Error('Knowledge Maintenance Agent 的 System Prompt 不能为空')
  if (!input.sourceRef.trim() || input.sourceRef.length > 512) throw new Error('Observation sourceRef 无效')
  if (!input.contributionRunRef.trim() || input.contributionRunRef.length > 1_024) {
    throw new Error('Knowledge Contribution runRef 无效')
  }
  if (input.reasoningEffort && !REASONING_EFFORTS.includes(input.reasoningEffort)) {
    throw new Error('思考强度无效')
  }
  if (!Array.isArray(input.observationLines)) throw new Error('Observation 行数据无效')
  if (
    typeof input.observationFormatVersion !== 'string'
    || !input.observationFormatVersion.trim()
    || input.observationFormatVersion.length > 128
  ) {
    throw new Error('Observation View 版本无效')
  }
  if (input.observationLines.some((line) => typeof line !== 'string' || /[\r\n]/.test(line))) {
    throw new Error('Observation 必须按单行数组提供')
  }
  if (!Array.isArray(input.statementCandidates)) throw new Error('Statement 候选清单无效')
  for (const [candidateIndex, candidate] of input.statementCandidates.entries()) {
    if (
      !candidate
      || typeof candidate.expression !== 'string'
      || !candidate.expression.trim()
      || candidate.expression.trim().length > MAX_STATEMENT_CANDIDATE_EXPRESSION_CHARACTERS
      || typeof candidate.question !== 'string'
      || !candidate.question.trim()
      || !Array.isArray(candidate.locations)
      || !candidate.locations.length
    ) {
      throw new Error(`Statement 候选 ${candidateIndex + 1} 无效`)
    }
    for (const location of candidate.locations) {
      const line = Number(location?.line)
      const offset = Number(location?.offset)
      const sourceLine = Number.isSafeInteger(line) ? input.observationLines[line - 1] : undefined
      if (
        !Number.isSafeInteger(line)
        || !Number.isSafeInteger(offset)
        || line < 1
        || offset < 0
        || sourceLine === undefined
        || offset > sourceLine.length
        || splitsSurrogatePair(sourceLine, offset)
      ) {
        throw new Error(`Statement 候选 ${candidateIndex + 1} 的证据位置无效`)
      }
    }
  }
  input.signal.throwIfAborted()
}

function workspaceEvidenceLocation(
  input: KnowledgeAgentRunInput,
  location: { line: number; offset: number }
): string {
  const sourceLine = input.observationLines[location.line - 1]
  if (
    !Number.isSafeInteger(location.line)
    || !Number.isSafeInteger(location.offset)
    || location.line < 1
    || location.offset < 0
    || sourceLine === undefined
    || location.offset > sourceLine.length
    || splitsSurrogatePair(sourceLine, location.offset)
  ) {
    throw new Error('候选证据位置不属于当前 Observation Workspace')
  }
  return formatEvidenceLocation(location)
}

function agendaSeed(input: KnowledgeAgentRunInput): StatementCandidateInput[] {
  return input.statementCandidates.map((candidate) => ({
    expression: candidate.expression,
    question: candidate.question,
    evidenceLocations: candidate.locations.map((location) => workspaceEvidenceLocation(input, location))
  }))
}

function candidateCountsDetails(counts: { total: number; open: number; resolved: number }) {
  return { total: counts.total, open: counts.open, resolved: counts.resolved }
}

function candidatePageText(page: ReturnType<InMemoryStatementCandidateAgenda['list']>): string {
  const items = page.items.map((candidate) => [
    `- ${candidate.ref} [${candidate.status}] ${compactInline(candidate.expression, 512)}`,
    `  Question: ${compactInline(candidate.question, MAX_STATEMENT_CANDIDATE_QUESTION_CHARACTERS)}`,
    candidate.evidenceLocations.length
      ? `  Evidence: ${candidate.evidenceLocations.join(', ')}`
      : '  Evidence: not yet attached',
    candidate.resolution ? `  Resolution: ${compactInline(candidate.resolution, 2_048)}` : undefined
  ].filter((part): part is string => Boolean(part)).join('\n'))
  return [
    `Agenda: ${page.counts.resolved}/${page.counts.total} resolved; ${page.counts.open} open.`,
    ...items,
    `Next offset: ${page.nextOffset ?? 'none'}`
  ].join('\n')
}

function contributionDraftPageText(page: ReturnType<KnowledgeContributionWorkspace['list']>): string {
  const lines = page.statements.map((statement) => [
    `- Title: ${compactInline(statement.title, 512)}`,
    `  Content preview: ${compactInline(statement.content, 1_024)}`
  ].join('\n'))
  return [
    `Contribution Draft: ${page.total} Statements.`,
    ...lines,
    `Next offset: ${page.nextOffset ?? 'none'}`
  ].join('\n')
}

function workspaceStatusText(
  agenda: InMemoryStatementCandidateAgenda,
  draft: KnowledgeContributionWorkspace
): string {
  const snapshot = agenda.snapshot(3)
  const preview = snapshot.openPreview.map((candidate) => (
    `- ${candidate.ref}: ${compactInline(candidate.expression, 128)} — ${compactInline(candidate.question, 256)}`
  ))
  return [
    '<knowledge-maintenance-workspace-status>',
    'This is fresh Host-owned run state, not a new user request and not knowledge evidence.',
    `Candidates: ${snapshot.counts.total} total; ${snapshot.counts.open} open; ${snapshot.counts.resolved} resolved.`,
    `Contribution Draft: ${draft.size} Statements.`,
    ...(preview.length ? ['Next open candidates:', ...preview] : ['No open candidates remain.']),
    snapshot.remainingOpen ? `Additional open candidates not shown: ${snapshot.remainingOpen}.` : undefined,
    snapshot.counts.open
      ? 'Continue investigating and explicitly resolve open candidates. Use list_statement_candidates for the complete agenda.'
      : 'The agenda is closed. Review the Contribution Draft and call submit_knowledge_contribution when it is ready.',
    '</knowledge-maintenance-workspace-status>'
  ].filter((part): part is string => Boolean(part)).join('\n')
}

function taskPrompt(input: KnowledgeAgentRunInput): string {
  const lastLine = input.observationLines.length
  const readableRange = lastLine > 0
    ? `${observationLineAddress(1)}-${observationLineAddress(lastLine)}`
    : 'No readable lines'
  return [
    'Maintain knowledge in this authorized workspace. The Host owns an open Statement-candidate agenda and a run-local Contribution Draft. Use the provided tools to inspect and update both. Follow the System Prompt language policy.',
    `Observation sourceRef: ${input.sourceRef}`,
    `Observation view format: ${input.observationFormatVersion}`,
    `Range available to read_evidence: ${readableRange}. Candidate locations use one-based line and zero-based UTF-16 offset; limit is also measured in UTF-16 code units and must be at least 2 (maximum applied limit ${MAX_EVIDENCE_READ_LIMIT}). Always set a bounded limit and copy the returned Next location when more detail is needed.`,
    'Tool calls may be repeated when useful. Keep each read bounded and use returned continuation locations to inspect more material progressively.',
    input.attention?.trim() ? `Attention:\n${input.attention.trim()}` : undefined
  ].filter((part): part is string => Boolean(part)).join('\n\n')
}

export class PiKnowledgeMaintenanceAgent implements KnowledgeAgentRuntime {
  constructor(private readonly knowledgeReader: KnowledgeReader) {}

  async run(input: KnowledgeAgentRunInput): Promise<KnowledgeAgentRunResult> {
    validateRunInput(input)
    const runtime: ModelRuntime = input.runtime
    const agenda = new InMemoryStatementCandidateAgenda(agendaSeed(input))
    const contributionDraft = new KnowledgeContributionWorkspace()
    let modelCallCount = 0
    const toolCalls: string[] = []
    let contribution: KnowledgeContributionDraft | undefined
    let protocolError: Error | undefined
    let compactionError: Error | undefined
    let activeModelCall: number | undefined
    let activeCompactionCall: number | undefined

    const reportTrace = (event: Parameters<NonNullable<KnowledgeAgentRunInput['onTrace']>>[0]): void => {
      try {
        input.onTrace?.(event)
      } catch {
        // Diagnostics must not change Agent execution.
      }
    }

    const reportWorkspaceStatus = (): void => {
      reportTrace({
        type: 'workspace_status',
        candidates: candidateCountsDetails(agenda.snapshot(0).counts),
        draftStatementCount: contributionDraft.size
      })
    }

    reportWorkspaceStatus()

    const guardedStreamFn: StreamFn = (model, context, options) => {
      modelCallCount++
      activeModelCall = modelCallCount
      reportTrace({ type: 'model_started', callNumber: modelCallCount })
      try {
        return runtime.streamFn(model, context, options)
      } catch (error) {
        const normalized = asError(error, '模型 Runtime 调用失败')
        return failedModelStream(model, normalized.message)
      }
    }

    const tools: AgentTool[] = [
      {
        name: 'search_knowledge',
        label: '搜索知识',
        description: '按标题和正文文本搜索当前 Knowledge Statement，返回有界的候选列表；结果给出 Next offset 时可用相同 query 继续读取。',
        parameters: searchKnowledgeParameters,
        executionMode: 'sequential',
        execute: async (_toolCallId, parameters, signal) => {
          signal?.throwIfAborted()
          const query = parameters.query.trim()
          if (!query) throw new Error('搜索 query 去除空白后不能为空')
          let records: KnowledgeStatementRecord[]
          try {
            const limit = parameters.limit ?? 8
            const offset = parameters.offset ?? 0
            records = (await this.knowledgeReader.search(query, limit, offset, signal)).slice(0, limit)
          } catch (error) {
            throw asError(error, '搜索 Knowledge Statement 失败')
          }
          const limit = parameters.limit ?? 8
          const offset = parameters.offset ?? 0
          const hasNextPage = records.length === limit
          const text = searchResultText(records, offset, hasNextPage)
          return {
            content: [{ type: 'text', text }],
            details: {
              count: records.length,
              offset,
              nextOffset: hasNextPage ? offset + records.length : null
            }
          }
        }
      } as AgentTool<typeof searchKnowledgeParameters>,
      {
        name: 'read_knowledge_statement',
        label: '读取知识',
        description: '按完整 canonical title 精确读取当前 Knowledge Statement。正文中的 [[canonical title]] 引用可用同一工具继续展开。',
        parameters: readKnowledgeParameters,
        executionMode: 'sequential',
        execute: async (_toolCallId, parameters, signal) => {
          signal?.throwIfAborted()
          const title = parameters.title.trim()
          if (!title) throw new Error('Statement title 去除空白后不能为空')
          let record: KnowledgeStatement | undefined
          try {
            record = await this.knowledgeReader.read(title, signal)
          } catch (error) {
            throw asError(error, '读取 Knowledge Statement 失败')
          }
          const text = record ? statementResultText(record) : '未找到该 Knowledge Statement。'
          return {
            content: [{ type: 'text', text }],
            details: { found: Boolean(record) }
          }
        }
      } as AgentTool<typeof readKnowledgeParameters>,
      {
        name: 'list_statement_candidates',
        label: '查看 Statement 候选',
        description: '分页读取 Host 持有的开放调查清单。候选不是拟定的 canonical title，也不与 Statement 一一对应。',
        parameters: listStatementCandidatesParameters,
        executionMode: 'sequential',
        execute: async (_toolCallId, parameters, signal) => {
          signal?.throwIfAborted()
          const page = agenda.list({
            status: parameters.status,
            limit: parameters.limit,
            offset: parameters.offset
          })
          return {
            content: [{ type: 'text', text: candidatePageText(page) }],
            details: {
              ...candidateCountsDetails(page.counts),
              count: page.items.length,
              offset: page.offset,
              nextOffset: page.nextOffset
            }
          }
        }
      } as AgentTool<typeof listStatementCandidatesParameters>,
      {
        name: 'add_statement_candidates',
        label: '补充 Statement 候选',
        description: '把调查中新发现的名称、指代或必要背景问题加入开放清单；这不会创建 Knowledge Statement。',
        parameters: addStatementCandidatesParameters,
        executionMode: 'sequential',
        execute: async (_toolCallId, parameters, signal) => {
          signal?.throwIfAborted()
          const added = agenda.add(parameters.candidates.map((candidate) => ({
            expression: candidate.expression,
            question: candidate.question,
            evidenceLocations: candidate.locations?.map((location) => (
              workspaceEvidenceLocation(input, location)
            ))
          })))
          reportWorkspaceStatus()
          const counts = agenda.snapshot(0).counts
          return {
            content: [{
              type: 'text',
              text: [
                `Added ${added.length} open Statement candidates.`,
                ...added.map((candidate) => `- ${candidate.ref}: ${candidate.expression}`),
                `Agenda now has ${counts.open} open and ${counts.resolved} resolved candidates.`
              ].join('\n')
            }],
            details: { ...candidateCountsDetails(counts), added: added.length }
          }
        }
      } as AgentTool<typeof addStatementCandidatesParameters>,
      {
        name: 'resolve_statement_candidates',
        label: '处置 Statement 候选',
        description: '批量记录候选已经过调查及其自由文本处置结论；它不自动写入或更新 Statement。',
        parameters: resolveStatementCandidatesParameters,
        executionMode: 'sequential',
        execute: async (_toolCallId, parameters, signal) => {
          signal?.throwIfAborted()
          const resolved = agenda.resolve(parameters.resolutions)
          reportWorkspaceStatus()
          const counts = agenda.snapshot(0).counts
          return {
            content: [{
              type: 'text',
              text: [
                `Resolved ${resolved.length} Statement candidates.`,
                ...resolved.map((candidate) => `- ${candidate.ref}: ${candidate.resolution}`),
                `Agenda now has ${counts.open} open and ${counts.resolved} resolved candidates.`
              ].join('\n')
            }],
            details: { ...candidateCountsDetails(counts), addressed: resolved.length }
          }
        }
      } as AgentTool<typeof resolveStatementCandidatesParameters>,
      {
        name: 'upsert_contribution_statement',
        label: '暂存 Statement 草稿',
        description: 'Stage or replace one free-text Statement in the run-local Contribution Draft. The title names one searchable subject; its context, attributes, and relationships belong in the body. This does not write to the knowledge Store.',
        parameters: contributionStatementParameters,
        executionMode: 'sequential',
        execute: async (_toolCallId, parameters, signal) => {
          signal?.throwIfAborted()
          const statement = contributionDraft.upsert(parameters as KnowledgeStatementDraft)
          reportWorkspaceStatus()
          return {
            content: [{ type: 'text', text: `Staged Statement draft: ${statement.title}` }],
            details: { title: statement.title, draftStatementCount: contributionDraft.size }
          }
        }
      } as AgentTool<typeof contributionStatementParameters>,
      {
        name: 'read_contribution_statement',
        label: '读取 Statement 草稿',
        description: '按 canonical title 读取本次运行中已经暂存的完整 Statement 草稿。',
        parameters: readContributionStatementParameters,
        executionMode: 'sequential',
        execute: async (_toolCallId, parameters, signal) => {
          signal?.throwIfAborted()
          const statement = contributionDraft.read(parameters.title)
          return {
            content: [{
              type: 'text',
              text: statement ? statementResultText(statement) : '未找到该 Contribution Statement 草稿。'
            }],
            details: { found: Boolean(statement), draftStatementCount: contributionDraft.size }
          }
        }
      } as AgentTool<typeof readContributionStatementParameters>,
      {
        name: 'list_contribution_statements',
        label: '查看 Contribution 草稿',
        description: '分页查看本次运行已经暂存的 Statement 标题和正文预览。',
        parameters: listContributionStatementsParameters,
        executionMode: 'sequential',
        execute: async (_toolCallId, parameters, signal) => {
          signal?.throwIfAborted()
          const page = contributionDraft.list(parameters.limit, parameters.offset)
          return {
            content: [{ type: 'text', text: contributionDraftPageText(page) }],
            details: {
              draftStatementCount: contributionDraft.size,
              count: page.statements.length,
              offset: page.offset,
              nextOffset: page.nextOffset ?? null
            }
          }
        }
      } as AgentTool<typeof listContributionStatementsParameters>,
      {
        name: 'remove_contribution_statement',
        label: '移除 Statement 草稿',
        description: '从本次运行的 Contribution Draft 移除一条尚未提交的 Statement。',
        parameters: removeContributionStatementParameters,
        executionMode: 'sequential',
        execute: async (_toolCallId, parameters, signal) => {
          signal?.throwIfAborted()
          const removed = contributionDraft.remove(parameters.title)
          reportWorkspaceStatus()
          return {
            content: [{
              type: 'text',
              text: removed ? `Removed Statement draft: ${parameters.title.trim()}` : '未找到该 Statement 草稿。'
            }],
            details: { removed, draftStatementCount: contributionDraft.size }
          }
        }
      } as AgentTool<typeof removeContributionStatementParameters>,
      {
        name: 'read_evidence',
        label: '读取观察证据',
        description: '从候选提供的原始行与行内 offset 开始读取有界 Observation；offset 和 limit 使用 UTF-16 code unit，limit 至少为 2，并在需要时直接使用返回的 Next 位置续读。',
        parameters: readEvidenceParameters,
        executionMode: 'sequential',
        execute: async (_toolCallId, parameters, signal) => {
          signal?.throwIfAborted()
          const page = readEvidencePage(
            input.observationLines,
            { line: parameters.line, offset: parameters.offset },
            parameters.limit
          )
          const text = formatEvidenceReadPage(page)
          if (text.length > MAX_EVIDENCE_OUTPUT_CHARS) {
            throw new Error('read_evidence 内部输出超过安全上限')
          }
          return {
            content: [{ type: 'text', text }],
            details: {
              start: formatEvidenceLocation(page.start),
              end: formatEvidenceLocation(page.end),
              next: page.next ? formatEvidenceLocation(page.next) : null,
              eof: page.eof,
              returnedCharacters: page.returnedCharacters,
              returnedLines: page.returnedLines,
              requestedLimit: page.requestedLimit,
              appliedLimit: page.appliedLimit
            }
          }
        }
      } as AgentTool<typeof readEvidenceParameters>,
      {
        name: 'submit_knowledge_contribution',
        label: '提交 Knowledge Contribution',
        description: '在所有 Statement 候选均已明确处置后，原子提交当前 Contribution Draft；开放候选仍存在时不会结束 Agent。',
        parameters: submitContributionParameters,
        executionMode: 'sequential',
        execute: async (_toolCallId, _parameters, signal) => {
          signal?.throwIfAborted()
          const snapshot = agenda.snapshot(5)
          if (snapshot.counts.open) {
            return {
              content: [{
                type: 'text',
                text: [
                  `Submission was not accepted because ${snapshot.counts.open} Statement candidates remain open.`,
                  ...snapshot.openPreview.map((candidate) => `- ${candidate.ref}: ${candidate.expression}`),
                  snapshot.remainingOpen ? `- ...and ${snapshot.remainingOpen} more. Use list_statement_candidates.` : undefined
                ].filter((part): part is string => Boolean(part)).join('\n')
              }],
              details: {
                accepted: false,
                ...candidateCountsDetails(snapshot.counts),
                statementCount: contributionDraft.size
              }
            }
          }
          contribution = contributionDraft.contribution(input.contributionRunRef)
          return {
            content: [{ type: 'text', text: 'The Knowledge Contribution has been captured for host validation and commit.' }],
            details: {
              accepted: true,
              ...candidateCountsDetails(snapshot.counts),
              statementCount: contribution.statements.length
            },
            terminate: true
          }
        }
      } as AgentTool<typeof submitContributionParameters>
    ]

    const thinkingLevel = runtime.model.reasoning ? (input.reasoningEffort ?? 'off') : 'off'
    const compactContext = createPiContextCompactor({
      model: runtime.model,
      streamFn: runtime.streamFn,
      systemPrompt: input.systemPrompt,
      tools,
      thinkingLevel,
      reservedContextTokens: WORKSPACE_STATUS_CONTEXT_TOKENS,
      onModelCall: (event) => {
        if (event.type === 'started') {
          modelCallCount++
          activeCompactionCall = modelCallCount
          reportTrace({
            type: 'model_started',
            callNumber: modelCallCount,
            purpose: 'context_compaction'
          })
          return
        }
        if (event.type === 'failed') {
          compactionError = event.error ?? new Error('Context compaction failed')
        }
        if (activeCompactionCall === undefined) return
        reportTrace({
          type: 'model_completed',
          callNumber: activeCompactionCall,
          status: event.type === 'completed'
            ? 'completed'
            : input.signal.aborted ? 'cancelled' : 'failed',
          detail: event.message
            ? `context compaction · ${modelTraceDetail(event.message)}`
            : input.signal.aborted
              ? 'context compaction cancelled'
              : 'context compaction failed',
          output: event.message ? modelTraceOutput(event.message) : undefined
        })
        activeCompactionCall = undefined
      }
    })
    const transformContext = async (
      messages: Parameters<typeof compactContext>[0],
      signal?: AbortSignal
    ): ReturnType<typeof compactContext> => {
      try {
        const compacted = await compactContext(messages, signal)
        const statusMessage: AgentMessage = {
          role: 'user',
          content: [{ type: 'text', text: workspaceStatusText(agenda, contributionDraft) }],
          timestamp: Date.now()
        }
        return [...compacted, statusMessage]
      } catch (error) {
        compactionError = asError(error, 'Context compaction failed')
        throw compactionError
      }
    }

    const agent = new Agent({
      initialState: {
        systemPrompt: input.systemPrompt,
        model: runtime.model,
        thinkingLevel,
        tools
      },
      streamFn: guardedStreamFn,
      transformContext,
      toolExecution: 'sequential',
      beforeToolCall: async ({ toolCall }) => {
        if (contribution !== undefined) {
          const message = toolCall.name === 'submit_knowledge_contribution'
            ? 'Knowledge Contribution 只能提交一次'
            : '提交 Knowledge Contribution 后不能继续调用工具'
          protocolError ??= new Error(message)
          return { block: true, reason: message }
        }
        return undefined
      },
      afterToolCall: async ({ assistantMessage, toolCall }) => {
        const batchSubmits = assistantMessage.content.some((content) =>
          content.type === 'toolCall' && content.name === 'submit_knowledge_contribution')
        if (!batchSubmits) return undefined

        // Pi ends a batch only when every result carries the hint. Other calls in a submit batch
        // can terminate; a rejected first submit remains a normal tool error so the model can retry.
        return toolCall.name !== 'submit_knowledge_contribution' || contribution !== undefined
          ? { terminate: true }
          : undefined
      }
    })

    agent.subscribe((event) => {
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        if (activeModelCall !== undefined) {
          const status = event.message.stopReason === 'aborted' && input.signal.aborted
            ? 'cancelled'
            : event.message.stopReason === 'error' || event.message.stopReason === 'aborted'
              ? 'failed'
              : 'completed'
          reportTrace({
            type: 'model_completed',
            callNumber: activeModelCall,
            status,
            detail: modelTraceDetail(event.message),
            output: modelTraceOutput(event.message)
          })
          activeModelCall = undefined
        }
        return
      }
      if (event.type === 'tool_execution_end') {
        const toolName = safeTraceToolName(event.toolName)
        const traceable = TRACEABLE_TOOL_NAMES.has(event.toolName)
        const status = event.isError
          ? (input.signal.aborted ? 'cancelled' : 'failed')
          : 'completed'
        reportTrace({
          type: 'tool_completed',
          toolCallId: event.toolCallId,
          toolName,
          status,
          detail: status === 'cancelled'
            ? '工具调用已取消'
            : safeTraceDetails(event.toolName, event.result, event.isError),
          output: traceable ? toolTraceOutput(event.result) : undefined
        })
        return
      }
      if (event.type === 'tool_execution_start') {
        const toolName = safeTraceToolName(event.toolName)
        const traceable = TRACEABLE_TOOL_NAMES.has(event.toolName)
        reportTrace({
          type: 'tool_started',
          toolCallId: event.toolCallId,
          toolName,
          input: traceable ? traceJson(event.args) : undefined
        })
        toolCalls.push(toolName)
        return
      }
      if (
        event.type === 'turn_end'
        && event.toolResults.length === 0
        && contribution === undefined
        && event.message.role === 'assistant'
        && event.message.stopReason !== 'error'
        && event.message.stopReason !== 'aborted'
      ) {
        const counts = agenda.snapshot(0).counts
        agent.followUp({
          role: 'user',
          content: [{
            type: 'text',
            text: counts.open
              ? `The run is not complete: ${counts.open} Statement candidates remain open. Continue investigating and resolving the agenda; use list_statement_candidates for the complete list.`
              : 'The agenda is closed, but the current Contribution Draft has not been submitted. Review it and call submit_knowledge_contribution when it is ready.'
          }],
          timestamp: Date.now()
        })
      }
    })

    const abortAgent = (): void => agent.abort()
    input.signal.addEventListener('abort', abortAgent, { once: true })

    try {
      const run = agent.prompt(taskPrompt(input))
      if (input.signal.aborted) agent.abort()
      await run
    } finally {
      input.signal.removeEventListener('abort', abortAgent)
      if (activeModelCall !== undefined) {
        reportTrace({
          type: 'model_completed',
          callNumber: activeModelCall,
          status: input.signal.aborted ? 'cancelled' : 'failed',
          detail: '模型调用未正常完成'
        })
        activeModelCall = undefined
      }
      if (activeCompactionCall !== undefined) {
        reportTrace({
          type: 'model_completed',
          callNumber: activeCompactionCall,
          status: input.signal.aborted ? 'cancelled' : 'failed',
          detail: 'context compaction did not complete normally'
        })
        activeCompactionCall = undefined
      }
    }

    if (input.signal.aborted) throw asError(input.signal.reason, 'Knowledge Maintenance Agent 运行已取消')
    if (protocolError) throw protocolError
    if (
      compactionError instanceof PiContextWindowError
      || compactionError instanceof PiContextCompactionOutputError
    ) throw compactionError
    if (compactionError) {
      throw new ModelConnectionFailureError(compactionError)
    }
    if (agent.state.errorMessage) {
      throw new ModelConnectionFailureError(
        new Error(`Knowledge Maintenance Agent 模型调用失败：${agent.state.errorMessage}`)
      )
    }
    if (contribution === undefined) throw new Error('Knowledge Maintenance Agent 未提交 Knowledge Contribution')

    return {
      contribution,
      statementCandidates: agenda.all(),
      modelCallCount,
      toolCalls: [...toolCalls]
    }
  }
}

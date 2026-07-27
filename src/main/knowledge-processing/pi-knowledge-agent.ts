import {
  Agent,
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
import type { KnowledgeContributionDraft, KnowledgeStatementDraft } from '../../shared/knowledge'
import { REASONING_EFFORTS } from '../../shared/ai-backends'
import type {
  KnowledgeAgentRunInput,
  KnowledgeAgentRunResult,
  KnowledgeAgentRuntime,
  KnowledgeReader,
  KnowledgeStatementRecord
} from './model'

const MAX_MODEL_CALLS = 4
const MAX_TOOL_CALLS = 12
const RUN_TIMEOUT_MS = 5 * 60_000
const MAX_EVIDENCE_LINES_PER_READ = 200
const MAX_EVIDENCE_OUTPUT_CHARS = 64 * 1_024
const MAX_TOTAL_EVIDENCE_LINES = 400
const MAX_TOTAL_TOOL_OUTPUT_CHARS = 96 * 1_024
const MAX_SEARCH_RESULTS = 20
const MAX_SEARCH_OUTPUT_CHARS = 16 * 1_024
const MAX_STATEMENT_OUTPUT_CHARS = 32 * 1_024
const MAX_EVIDENCE_MAP_SECTION_OUTPUT_CHARS = 32 * 1_024
const MAX_CONTRIBUTION_CHARS = 64 * 1_024
const MAX_STATEMENTS_PER_CONTRIBUTION = 100
const MAX_EVIDENCE_MAP_CHARS = 128 * 1_024
const MAX_ATTENTION_CHARS = 16 * 1_024
const UNKNOWN_TRACE_TOOL_NAME = '未知工具'

const TRACEABLE_TOOL_NAMES = new Set([
  'search_knowledge',
  'read_knowledge_statement',
  'read_evidence_map_section',
  'read_evidence',
  'submit_knowledge_contribution'
])

const SOURCE_SELECTOR = /^L(\d{6})-L(\d{6})$/

const searchKnowledgeParameters = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 1_024 }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SEARCH_RESULTS }))
}, { additionalProperties: false })

const readKnowledgeParameters = Type.Object({
  statementId: Type.String({ minLength: 1, maxLength: 512 })
}, { additionalProperties: false })

const readEvidenceParameters = Type.Object({
  sourceRef: Type.String({ minLength: 1, maxLength: 512 }),
  selector: Type.String({ pattern: '^L\\d{6}-L\\d{6}$' })
}, { additionalProperties: false })

const readEvidenceMapSectionParameters = Type.Object({
  sectionId: Type.String({ minLength: 1, maxLength: 64 })
}, { additionalProperties: false })

const contributionSourceParameters = Type.Object({
  sourceRef: Type.String({ minLength: 1, maxLength: 2_048 }),
  selector: Type.Optional(Type.String({ pattern: '^L\\d{6}-L\\d{6}$' }))
}, { additionalProperties: false })

const contributionRelationParameters = Type.Object({
  relation: Type.Union([Type.Literal('derived_from'), Type.Literal('revises')]),
  target: Type.Union([
    Type.Object({
      kind: Type.Literal('statement'),
      statementId: Type.String({ minLength: 1, maxLength: 2_048 })
    }, { additionalProperties: false }),
    Type.Object({
      kind: Type.Literal('draft'),
      localRef: Type.String({ minLength: 1, maxLength: 128 })
    }, { additionalProperties: false })
  ])
}, { additionalProperties: false })

const contributionStatementParameters = Type.Object({
  localRef: Type.String({ minLength: 1, maxLength: 128 }),
  title: Type.String({ minLength: 1, maxLength: 2_048 }),
  content: Type.String({ minLength: 1, maxLength: MAX_CONTRIBUTION_CHARS }),
  sources: Type.Optional(Type.Array(contributionSourceParameters, { maxItems: 100 })),
  relations: Type.Optional(Type.Array(contributionRelationParameters, { maxItems: 100 }))
}, { additionalProperties: false })

const submitContributionParameters = Type.Object({
  statements: Type.Array(contributionStatementParameters, {
    maxItems: MAX_STATEMENTS_PER_CONTRIBUTION
  })
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

function truncateWithNotice(value: string, maximum: number): string {
  if (value.length <= maximum) return value
  const notice = '\n\n[内容因工具输出上限而截断]'
  return `${value.slice(0, Math.max(0, maximum - notice.length))}${notice}`
}

function normalizedSearchKey(query: string): string {
  return query.replace(/\s+/g, ' ').trim().toLowerCase()
}

function safeTraceInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined
}

function safeTraceToolName(value: string): string {
  return TRACEABLE_TOOL_NAMES.has(value) ? value : UNKNOWN_TRACE_TOOL_NAME
}

function safeTraceDetails(toolName: string, result: unknown, isError: boolean): string | undefined {
  if (isError) return '工具调用失败'
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
  if (toolName === 'read_evidence_map_section') {
    const sectionId = typeof record.sectionId === 'string' && /^M\d{6}$/.test(record.sectionId)
      ? record.sectionId
      : undefined
    const selector = typeof record.selector === 'string' && /^L\d{6}-L\d{6}$/.test(record.selector)
      ? record.selector
      : undefined
    return [sectionId, selector].filter(Boolean).join(' · ') || undefined
  }
  if (toolName === 'read_evidence') {
    const selector = typeof record.selector === 'string' && /^L\d{6}-L\d{6}$/.test(record.selector)
      ? record.selector
      : undefined
    const lineCount = safeTraceInteger(record.lineCount)
    return [selector, lineCount === undefined ? undefined : `${lineCount} 行`].filter(Boolean).join(' · ') || undefined
  }
  if (toolName === 'submit_knowledge_contribution') {
    const statementCount = safeTraceInteger(record.statementCount)
    return statementCount === undefined ? undefined : `捕获 ${statementCount} 条候选 Statement`
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

function rangesOverlap(
  left: { start: number; end: number },
  right: { start: number; end: number }
): boolean {
  return left.start <= right.end && right.start <= left.end
}

function searchResultText(records: KnowledgeStatementRecord[]): string {
  if (!records.length) return '没有找到相关 Knowledge Statement。'
  const lines = records.map((record) => [
    `- ID: ${compactInline(record.id, 256)}`,
    `  标题: ${compactInline(record.title, 512)}`,
    `  内容预览: ${compactInline(record.content, 1_024)}`
  ].join('\n'))
  return truncateWithNotice(lines.join('\n'), MAX_SEARCH_OUTPUT_CHARS)
}

function statementResultText(record: KnowledgeStatementRecord): string {
  return truncateWithNotice([
    `ID: ${compactInline(record.id, 512)}`,
    `标题: ${compactInline(record.title, 1_024)}`,
    '内容:',
    record.content
  ].join('\n'), MAX_STATEMENT_OUTPUT_CHARS)
}

function validateRunInput(input: KnowledgeAgentRunInput): void {
  if (!input.systemPrompt.trim()) throw new Error('Knowledge Maintenance Agent 的 System Prompt 不能为空')
  if (!input.evidenceMap.trim()) throw new Error('Evidence Map 不能为空')
  if (input.evidenceMap.length > MAX_EVIDENCE_MAP_CHARS) throw new Error('Evidence Map 超出运行上限')
  if (!input.sourceRef.trim() || input.sourceRef.length > 512) throw new Error('Observation sourceRef 无效')
  if (!input.contributionRunRef.trim() || input.contributionRunRef.length > 1_024) {
    throw new Error('Knowledge Contribution runRef 无效')
  }
  if (input.attention && input.attention.length > MAX_ATTENTION_CHARS) throw new Error('Attention 超出运行上限')
  if (input.reasoningEffort && !REASONING_EFFORTS.includes(input.reasoningEffort)) {
    throw new Error('思考强度无效')
  }
  if (!Array.isArray(input.observationLines)) throw new Error('Observation 行数据无效')
  if (input.observationLines.some((line) => typeof line !== 'string' || /[\r\n]/.test(line))) {
    throw new Error('Observation 必须按单行数组提供')
  }
  if (!Array.isArray(input.evidenceMapSections)) throw new Error('Evidence Map 局部材料无效')
  const sectionIds = new Set<string>()
  for (const section of input.evidenceMapSections) {
    const selector = section && typeof section.selector === 'string'
      ? SOURCE_SELECTOR.exec(section.selector)
      : undefined
    if (
      !section
      || !/^M\d{6}$/.test(section.id)
      || !selector
      || !section.content.trim()
      || section.content.length > MAX_EVIDENCE_MAP_SECTION_OUTPUT_CHARS
      || sectionIds.has(section.id)
    ) {
      throw new Error('Evidence Map 局部材料无效')
    }
    const start = Number(selector[1])
    const end = Number(selector[2])
    if (start < 1 || end < start || end > input.observationLines.length) {
      throw new Error('Evidence Map 局部材料超出当前 Observation 范围')
    }
    sectionIds.add(section.id)
  }
  input.signal.throwIfAborted()
}

function contributionFromSubmission(
  input: KnowledgeAgentRunInput,
  statements: KnowledgeStatementDraft[]
): KnowledgeContributionDraft {
  const contribution: KnowledgeContributionDraft = {
    runRef: input.contributionRunRef,
    statements: structuredClone(statements)
  }
  if (JSON.stringify(contribution).length > MAX_CONTRIBUTION_CHARS) {
    throw new Error(`Knowledge Contribution 总大小不能超过 ${MAX_CONTRIBUTION_CHARS} 个字符`)
  }
  for (const statement of contribution.statements) {
    for (const source of statement.sources ?? []) {
      if (source.sourceRef !== input.sourceRef) {
        throw new Error('Statement sourceRef 必须精确指向当前授权的 Observation revision')
      }
      if (!source.selector) continue
      const match = SOURCE_SELECTOR.exec(source.selector)
      if (!match) throw new Error('Statement selector 必须使用 L000001-L000010 格式')
      const start = Number(match[1])
      const end = Number(match[2])
      if (start < 1 || end < start || end > input.observationLines.length) {
        throw new Error('Statement selector 超出当前 Observation 范围')
      }
    }
  }
  return contribution
}

function taskPrompt(input: KnowledgeAgentRunInput): string {
  const lastLine = Math.min(input.observationLines.length, 999_999)
  const readableRange = lastLine > 0
    ? `L000001-L${String(lastLine).padStart(6, '0')}`
    : 'No readable lines'
  const mapSections = input.evidenceMapSections.length
    ? [
        'Expandable Evidence Map sections available through read_evidence_map_section:',
        ...input.evidenceMapSections.map((section) => `- ${section.id}: ${section.selector}`)
      ].join('\n')
    : undefined
  return [
    'Maintain the knowledge in this authorized workspace. The Evidence Map is navigation only; use tools to verify details when necessary. Follow the System Prompt\'s language policy and write Statements in the primary language of the original observation.',
    `Observation sourceRef: ${input.sourceRef}`,
    `Range available to read_evidence: ${readableRange}`,
    `Run budget: at most ${MAX_TOTAL_TOOL_OUTPUT_CHARS} total tool-output characters and ${MAX_TOTAL_EVIDENCE_LINES} original-evidence lines. Do not repeat searches, reread a Statement, or read overlapping evidence ranges.`,
    mapSections,
    input.attention?.trim() ? `Attention:\n${input.attention.trim()}` : undefined,
    `Evidence Map:\n${input.evidenceMap.trim()}`
  ].filter((part): part is string => Boolean(part)).join('\n\n')
}

export class PiKnowledgeMaintenanceAgent implements KnowledgeAgentRuntime {
  constructor(private readonly knowledgeReader: KnowledgeReader) {}

  async run(input: KnowledgeAgentRunInput): Promise<KnowledgeAgentRunResult> {
    validateRunInput(input)
    const runtime: ModelRuntime = input.runtime
    let modelCallCount = 0
    let toolCallCount = 0
    const toolCalls: string[] = []
    const completedSearches = new Set<string>()
    const completedStatementReads = new Set<string>()
    const completedEvidenceMapSections = new Set<string>()
    const completedEvidenceRanges: Array<{ start: number; end: number }> = []
    let totalToolOutputCharacters = 0
    let totalEvidenceLines = 0
    let contribution: KnowledgeContributionDraft | undefined
    let fatalError: Error | undefined
    let timedOut = false
    let activeModelCall: number | undefined

    const reportTrace = (event: Parameters<NonNullable<KnowledgeAgentRunInput['onTrace']>>[0]): void => {
      try {
        input.onTrace?.(event)
      } catch {
        // Diagnostics must not change Agent execution.
      }
    }

    const fail = (error: unknown, fallback: string): Error => {
      const normalized = asError(error, fallback)
      fatalError ??= normalized
      return normalized
    }

    const recordToolOutput = (text: string): void => {
      if (totalToolOutputCharacters + text.length > MAX_TOTAL_TOOL_OUTPUT_CHARS) {
        throw new Error(
          `本次运行的工具输出累计最多 ${MAX_TOTAL_TOOL_OUTPUT_CHARS} 个字符；请减少搜索结果、缩小读取范围，或复用已有结果提交`
        )
      }
      totalToolOutputCharacters += text.length
    }

    const guardedStreamFn: StreamFn = (model, context, options) => {
      if (fatalError) return failedModelStream(model, fatalError.message)
      if (modelCallCount >= MAX_MODEL_CALLS) {
        const error = fail(new Error(`Knowledge Maintenance Agent 最多允许 ${MAX_MODEL_CALLS} 次模型调用`), '模型调用次数超限')
        return failedModelStream(model, error.message)
      }
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
        description: '按语义查询获得授权的 Knowledge Statement，返回有界的候选列表。',
        parameters: searchKnowledgeParameters,
        executionMode: 'sequential',
        execute: async (_toolCallId, parameters, signal) => {
          signal?.throwIfAborted()
          const query = parameters.query.trim()
          const searchKey = normalizedSearchKey(query)
          if (!searchKey) throw new Error('搜索 query 去除空白后不能为空')
          if (completedSearches.has(searchKey)) {
            throw new Error('重复搜索已拒绝；请复用已有结果或改写 query')
          }
          let records: KnowledgeStatementRecord[]
          try {
            const limit = parameters.limit ?? 8
            records = (await this.knowledgeReader.search(query, limit, signal)).slice(0, limit)
          } catch (error) {
            throw fail(error, '搜索 Knowledge Statement 失败')
          }
          const text = searchResultText(records)
          recordToolOutput(text)
          completedSearches.add(searchKey)
          return {
            content: [{ type: 'text', text }],
            details: { count: records.length }
          }
        }
      } as AgentTool<typeof searchKnowledgeParameters>,
      {
        name: 'read_knowledge_statement',
        label: '读取知识',
        description: '按稳定 ID 读取一条获得授权的不可变 Knowledge Statement。',
        parameters: readKnowledgeParameters,
        executionMode: 'sequential',
        execute: async (_toolCallId, parameters, signal) => {
          signal?.throwIfAborted()
          const statementId = parameters.statementId.trim()
          if (!statementId) throw new Error('Statement ID 去除空白后不能为空')
          if (completedStatementReads.has(statementId)) {
            throw new Error('该 Knowledge Statement 已读取；请复用已有结果或读取其他 Statement')
          }
          let record: KnowledgeStatementRecord | undefined
          try {
            record = await this.knowledgeReader.read(statementId, signal)
          } catch (error) {
            throw fail(error, '读取 Knowledge Statement 失败')
          }
          const text = record ? statementResultText(record) : '未找到该 Knowledge Statement。'
          recordToolOutput(text)
          completedStatementReads.add(statementId)
          return {
            content: [{ type: 'text', text }],
            details: { found: Boolean(record) }
          }
        }
      } as AgentTool<typeof readKnowledgeParameters>,
      ...(input.evidenceMapSections.length ? [{
        name: 'read_evidence_map_section',
        label: '展开 Evidence Map',
        description: '按当前工作区提供的 section ID 展开一段局部 Evidence Map；内容仍需通过原始 Observation 核查。',
        parameters: readEvidenceMapSectionParameters,
        executionMode: 'sequential' as const,
        execute: async (_toolCallId, parameters, signal) => {
          signal?.throwIfAborted()
          const sectionId = parameters.sectionId.trim()
          const section = input.evidenceMapSections.find((candidate) => candidate.id === sectionId)
          if (!section) throw new Error('Evidence Map section 不属于当前授权工作区')
          if (completedEvidenceMapSections.has(sectionId)) {
            throw new Error('该 Evidence Map section 已读取；请复用已有结果或展开其他 section')
          }
          const text = truncateWithNotice([
            `Section: ${section.id}`,
            `Observation range: ${section.selector}`,
            section.content
          ].join('\n'), MAX_EVIDENCE_MAP_SECTION_OUTPUT_CHARS)
          recordToolOutput(text)
          completedEvidenceMapSections.add(sectionId)
          return {
            content: [{ type: 'text' as const, text }],
            details: { sectionId: section.id, selector: section.selector }
          }
        }
      } as AgentTool<typeof readEvidenceMapSectionParameters>] : []),
      {
        name: 'read_evidence',
        label: '读取观察证据',
        description: '使用当前工作区的 sourceRef 和精确行范围读取最小必要的原始 Observation。',
        parameters: readEvidenceParameters,
        executionMode: 'sequential',
        execute: async (_toolCallId, parameters, signal) => {
          signal?.throwIfAborted()
          if (parameters.sourceRef !== input.sourceRef) throw new Error('sourceRef 不属于当前授权工作区')
          const match = SOURCE_SELECTOR.exec(parameters.selector)
          if (!match) throw new Error('selector 必须使用 L000001-L000010 格式')
          const start = Number(match[1])
          const end = Number(match[2])
          if (start < 1 || end < start) throw new Error('selector 行范围无效')
          const lineCount = end - start + 1
          if (lineCount > MAX_EVIDENCE_LINES_PER_READ) {
            throw new Error(`read_evidence 单次最多读取 ${MAX_EVIDENCE_LINES_PER_READ} 行`)
          }
          if (end > input.observationLines.length) throw new Error('selector 超出当前 Observation 范围')
          const overlapping = completedEvidenceRanges.find((range) => rangesOverlap(range, { start, end }))
          if (overlapping) {
            const previous = `L${String(overlapping.start).padStart(6, '0')}-L${String(overlapping.end).padStart(6, '0')}`
            throw new Error(`selector 与已读取范围 ${previous} 重叠；请选择尚未读取的范围`)
          }
          if (totalEvidenceLines + lineCount > MAX_TOTAL_EVIDENCE_LINES) {
            throw new Error(
              `本次运行累计最多读取 ${MAX_TOTAL_EVIDENCE_LINES} 行原始证据；请复用已有结果或直接提交`
            )
          }
          const text = input.observationLines
            .slice(start - 1, end)
            .map((line, index) => `L${String(start + index).padStart(6, '0')} ${line}`)
            .join('\n')
          if (text.length > MAX_EVIDENCE_OUTPUT_CHARS) {
            throw new Error('所选证据内容过大，请缩小 selector 范围')
          }
          recordToolOutput(text)
          totalEvidenceLines += lineCount
          completedEvidenceRanges.push({ start, end })
          return {
            content: [{ type: 'text', text }],
            details: { sourceRef: input.sourceRef, selector: parameters.selector, lineCount }
          }
        }
      } as AgentTool<typeof readEvidenceParameters>,
      {
        name: 'submit_knowledge_contribution',
        label: '提交 Knowledge Contribution',
        description: '提交本次运行唯一的结构化 Contribution。每条 Statement 的正文仍是自由文本；没有持久知识时提交空 statements。',
        parameters: submitContributionParameters,
        executionMode: 'sequential',
        execute: async (_toolCallId, parameters, signal) => {
          signal?.throwIfAborted()
          if (contribution !== undefined) throw fail(new Error('Knowledge Contribution 只能提交一次'), '重复提交')
          contribution = contributionFromSubmission(
            input,
            parameters.statements as KnowledgeStatementDraft[]
          )
          return {
            content: [{ type: 'text', text: 'The Knowledge Contribution has been captured for host validation and commit.' }],
            details: { captured: true, statementCount: contribution.statements.length },
            terminate: true
          }
        }
      } as AgentTool<typeof submitContributionParameters>
    ]

    const agent = new Agent({
      initialState: {
        systemPrompt: input.systemPrompt,
        model: runtime.model,
        thinkingLevel: runtime.model.reasoning ? (input.reasoningEffort ?? 'off') : 'off',
        tools
      },
      streamFn: guardedStreamFn,
      toolExecution: 'sequential',
      beforeToolCall: async ({ toolCall }) => {
        if (fatalError) return { block: true, reason: fatalError.message }
        if (contribution !== undefined) {
          const message = toolCall.name === 'submit_knowledge_contribution'
            ? 'Knowledge Contribution 只能提交一次'
            : '提交 Knowledge Contribution 后不能继续调用工具'
          return { block: true, reason: fail(new Error(message), message).message }
        }
        return undefined
      },
      afterToolCall: async ({ assistantMessage }) => {
        const batchSubmits = assistantMessage.content.some((content) =>
          content.type === 'toolCall' && content.name === 'submit_knowledge_contribution')
        return batchSubmits ? { terminate: true } : undefined
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
            detail: modelTraceDetail(event.message)
          })
          activeModelCall = undefined
        }
        return
      }
      if (event.type === 'tool_execution_end') {
        const toolName = safeTraceToolName(event.toolName)
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
            : safeTraceDetails(event.toolName, event.result, event.isError)
        })
        return
      }
      if (event.type === 'tool_execution_start') {
        const toolName = safeTraceToolName(event.toolName)
        reportTrace({
          type: 'tool_started',
          toolCallId: event.toolCallId,
          toolName
        })
        toolCallCount++
        toolCalls.push(toolName)
        if (toolCallCount > MAX_TOOL_CALLS) {
          fail(new Error(`Knowledge Maintenance Agent 最多允许 ${MAX_TOOL_CALLS} 次工具调用`), '工具调用次数超限')
          return
        }
        if (contribution !== undefined) {
          const message = event.toolName === 'submit_knowledge_contribution'
            ? 'Knowledge Contribution 只能提交一次'
            : '提交 Knowledge Contribution 后不能继续调用工具'
          fail(new Error(message), message)
        }
      }
    })

    const abortAgent = (): void => agent.abort()
    input.signal.addEventListener('abort', abortAgent, { once: true })
    const timeout = setTimeout(() => {
      timedOut = true
      agent.abort()
    }, RUN_TIMEOUT_MS)

    try {
      const run = agent.prompt(taskPrompt(input))
      if (input.signal.aborted) agent.abort()
      await run
    } finally {
      clearTimeout(timeout)
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
    }

    if (timedOut) throw new Error('Knowledge Maintenance Agent 运行超时（5 分钟）')
    if (input.signal.aborted) throw asError(input.signal.reason, 'Knowledge Maintenance Agent 运行已取消')
    if (fatalError) throw fatalError
    if (agent.state.errorMessage) {
      throw new ModelConnectionFailureError(
        new Error(`Knowledge Maintenance Agent 模型调用失败：${agent.state.errorMessage}`)
      )
    }
    if (contribution === undefined) throw new Error('Knowledge Maintenance Agent 未提交 Knowledge Contribution')

    return {
      contribution,
      modelCallCount,
      toolCalls: [...toolCalls]
    }
  }
}

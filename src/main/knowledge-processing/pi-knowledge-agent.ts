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
import {
  createPiContextCompactor,
  PiContextCompactionOutputError,
  PiContextWindowError
} from '../agent-runtime/pi-context-compactor'
import {
  evidenceReadCallHint,
  formatEvidenceLocation,
  formatEvidenceReadPage,
  MAX_EVIDENCE_READ_LIMIT,
  observationLineAddress,
  readEvidencePage,
  splitsSurrogatePair
} from '../observation/evidence-location'
import {
  MAX_KNOWLEDGE_STATEMENT_CONTENT_LENGTH,
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

const MAX_EVIDENCE_OUTPUT_CHARS = 64 * 1_024
const MAX_SEARCH_RESULTS = 20
const UNKNOWN_TRACE_TOOL_NAME = '未知工具'

const TRACEABLE_TOOL_NAMES = new Set([
  'search_knowledge',
  'read_knowledge_statement',
  'read_evidence_map_section',
  'read_evidence',
  'submit_knowledge_contribution'
])

const SOURCE_SELECTOR = /^L(\d{6,})-L(\d{6,})$/

const searchKnowledgeParameters = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 1_024 }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SEARCH_RESULTS })),
  offset: Type.Optional(Type.Integer({ minimum: 0 }))
}, { additionalProperties: false })

const readKnowledgeParameters = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 2_048 })
}, { additionalProperties: false })

const readEvidenceParameters = Type.Object({
  line: Type.Integer({ minimum: 1 }),
  offset: Type.Integer({ minimum: 0 }),
  limit: Type.Integer({ minimum: 2 })
}, { additionalProperties: false })

const readEvidenceMapSectionParameters = Type.Object({
  sectionId: Type.String({ minLength: 1, maxLength: 64 })
}, { additionalProperties: false })

const contributionStatementParameters = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 2_048 }),
  content: Type.String({ minLength: 1, maxLength: MAX_KNOWLEDGE_STATEMENT_CONTENT_LENGTH })
}, { additionalProperties: false })

const submitContributionParameters = Type.Object({
  statements: Type.Array(contributionStatementParameters)
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
  if (toolName === 'read_evidence_map_section') {
    const sectionId = typeof record.sectionId === 'string' && /^M\d{6,}$/.test(record.sectionId)
      ? record.sectionId
      : undefined
    const selectors = Array.isArray(record.selectors)
      ? record.selectors.filter((selector): selector is string => (
          typeof selector === 'string' && /^L\d{6,}-L\d{6,}$/.test(selector)
        ))
      : []
    return [sectionId, selectors.length ? selectors.join(', ') : undefined]
      .filter(Boolean)
      .join(' · ') || undefined
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
  if (!input.evidenceMap.trim()) throw new Error('Evidence Map 不能为空')
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
  if (!Array.isArray(input.evidenceMapSections)) throw new Error('Evidence Map 局部材料无效')
  const sectionIds = new Set<string>()
  for (const section of input.evidenceMapSections) {
    if (
      !section
      || !/^M\d{6,}$/.test(section.id)
      || !Array.isArray(section.selectors)
      || !section.selectors.length
      || !section.content.trim()
      || sectionIds.has(section.id)
    ) {
      throw new Error('Evidence Map 局部材料无效')
    }
    let previousEnd = 0
    const parsedSelectors = section.selectors.map((value) => {
      const selector = typeof value === 'string' ? SOURCE_SELECTOR.exec(value) : undefined
      if (!selector) throw new Error('Evidence Map 局部材料无效')
      const start = Number(selector[1])
      const end = Number(selector[2])
      if (start < 1 || end < start || end > input.observationLines.length) {
        throw new Error('Evidence Map 局部材料超出当前 Observation 范围')
      }
      if (start <= previousEnd + (previousEnd ? 1 : 0)) {
        throw new Error('Evidence Map source ranges 必须按顺序且已合并')
      }
      previousEnd = end
      return { start, end }
    })
    if (!parsedSelectors.length) {
      throw new Error('Evidence Map 局部材料无效')
    }
    const { line, offset } = section.readLocation ?? {}
    const readLine = typeof line === 'number' ? input.observationLines[line - 1] : undefined
    if (
      !Number.isSafeInteger(line)
      || !Number.isSafeInteger(offset)
      || line < 1
      || offset < 0
      || readLine === undefined
      || offset > readLine.length
      || splitsSurrogatePair(readLine, offset)
      || !parsedSelectors.some((range) => line >= range.start && line <= range.end)
    ) {
      throw new Error('Evidence Map 读取位置无效')
    }
    if (section.children?.some((child) => !/^M\d{6,}$/.test(child))) {
      throw new Error('Evidence Map 子节点引用无效')
    }
    if (section.characterWindow) {
      const { startCharacter, endCharacter, totalCharacters } = section.characterWindow
      const [{ start, end }] = parsedSelectors
      if (
        parsedSelectors.length !== 1
        || start !== end
        || !Number.isSafeInteger(startCharacter)
        || !Number.isSafeInteger(endCharacter)
        || !Number.isSafeInteger(totalCharacters)
        || startCharacter < 0
        || endCharacter <= startCharacter
        || endCharacter > totalCharacters
        || totalCharacters !== input.observationLines[start - 1].length
        || line !== start
        || offset !== startCharacter
      ) {
        throw new Error('Evidence Map 字符窗口无效')
      }
    }
    sectionIds.add(section.id)
  }
  for (const section of input.evidenceMapSections) {
    if (section.children?.some((child) => !sectionIds.has(child))) {
      throw new Error('Evidence Map 子节点不属于当前工作区')
    }
  }
  input.signal.throwIfAborted()
}

function contributionFromSubmission(
  input: KnowledgeAgentRunInput,
  statements: KnowledgeStatementDraft[]
): KnowledgeContributionDraft {
  return {
    runRef: input.contributionRunRef,
    statements: structuredClone(statements)
  }
}

function taskPrompt(input: KnowledgeAgentRunInput): string {
  const lastLine = input.observationLines.length
  const readableRange = lastLine > 0
    ? `${observationLineAddress(1)}-${observationLineAddress(lastLine)}`
    : 'No readable lines'
  return [
    'Maintain the knowledge in this authorized workspace. The Evidence Map is navigation only; use tools to verify details when necessary. Follow the System Prompt\'s language policy and write Statements in the primary language of the original observation.',
    `Observation sourceRef: ${input.sourceRef}`,
    `Observation view format: ${input.observationFormatVersion}`,
    `Range available to read_evidence: ${readableRange}. Evidence Map locations use one-based line and zero-based UTF-16 offset; limit is also measured in UTF-16 code units and must be at least 2 (maximum applied limit ${MAX_EVIDENCE_READ_LIMIT}). Always set a bounded limit and copy the returned Next location when more detail is needed.`,
    'Tool calls may be repeated when useful. Keep each read bounded and use returned continuation locations to inspect more material progressively.',
    input.evidenceMapSections.length
      ? 'Expandable map section IDs and their immediate children are disclosed progressively inside the Evidence Map. Use read_evidence_map_section only for IDs you discover there.'
      : undefined,
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
          const hasChildren = Boolean(section.children?.length)
          const sourceDisclosure = hasChildren
            ? `Source coverage extent (navigation only; not exact selectors): ${section.selectors[0].split('-')[0]}-${section.selectors[section.selectors.length - 1].split('-')[1]}`
            : `Selected source ranges: ${section.selectors.join(', ')}`
          const text = [
            `Section: ${section.id}`,
            sourceDisclosure,
            hasChildren
              ? `Immediate child sections: ${section.children?.join(', ')}`
              : 'Immediate child sections: none',
            `First evidence read location: ${formatEvidenceLocation(section.readLocation)}`,
            `First bounded read call: ${evidenceReadCallHint(section.readLocation)}`,
            section.characterWindow
              ? `Character window: [${section.characterWindow.startCharacter}, ${section.characterWindow.endCharacter}) of ${section.characterWindow.totalCharacters}`
              : undefined,
            section.content
          ].filter((part): part is string => Boolean(part)).join('\n')
          return {
            content: [{ type: 'text' as const, text }],
            details: { sectionId: section.id, selectors: [...section.selectors] }
          }
        }
      } as AgentTool<typeof readEvidenceMapSectionParameters>] : []),
      {
        name: 'read_evidence',
        label: '读取观察证据',
        description: '从 Evidence Map 给出的原始行与行内 offset 开始读取有界 Observation；offset 和 limit 使用 UTF-16 code unit，limit 至少为 2，并在需要时直接使用返回的 Next 位置续读。',
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
        description: '提交本次运行唯一的原子 Contribution。每条 Statement 只有 canonical title 与自由文本正文；同名 title 更新当前正文，新 title 创建 Statement；没有变更时提交空 statements。',
        parameters: submitContributionParameters,
        executionMode: 'sequential',
        execute: async (_toolCallId, parameters, signal) => {
          signal?.throwIfAborted()
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

    const thinkingLevel = runtime.model.reasoning ? (input.reasoningEffort ?? 'off') : 'off'
    const compactContext = createPiContextCompactor({
      model: runtime.model,
      streamFn: runtime.streamFn,
      systemPrompt: input.systemPrompt,
      tools,
      thinkingLevel,
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
              : 'context compaction failed'
        })
        activeCompactionCall = undefined
      }
    })
    const transformContext = async (
      messages: Parameters<typeof compactContext>[0],
      signal?: AbortSignal
    ): ReturnType<typeof compactContext> => {
      try {
        return await compactContext(messages, signal)
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
        toolCalls.push(toolName)
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
      modelCallCount,
      toolCalls: [...toolCalls]
    }
  }
}

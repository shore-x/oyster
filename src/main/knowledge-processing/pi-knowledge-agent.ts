import {
  Agent,
  type AgentTool,
  type StreamFn
} from '@earendil-works/pi-agent-core'
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
  type Usage
} from '@earendil-works/pi-ai'
import {
  ModelConnectionFailureError,
  ModelOutputTruncatedError
} from '../ai-backends/model'
import type { ModelRuntime } from '../ai-backends/model'
import {
  createPiContextCompactor,
  PiContextCompactionOutputError,
  PiContextWindowError
} from '../agent-runtime/pi-context-compactor'
import {
  convertPiAgentMessages,
  createPiAgentRuntime
} from '../agent-runtime/pi-agent-runtime'
import {
  formatEvidenceLocation,
  formatEvidenceReadPage,
  MAX_EVIDENCE_READ_LIMIT,
  observationLineAddress,
  readEvidencePage
} from '../observation/evidence-location'
import {
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
import { KnowledgeContributionWorkspace } from './knowledge-contribution-workspace'
import {
  contributionStatementParameters,
  knowledgeMaintenanceToolDefinition,
  listContributionStatementsParameters,
  MAX_KNOWLEDGE_SEARCH_RESULTS as MAX_SEARCH_RESULTS,
  MAX_KNOWLEDGE_WORKSPACE_LIST_RESULTS as MAX_WORKSPACE_LIST_RESULTS,
  readContributionStatementParameters,
  readEvidenceParameters,
  readKnowledgeParameters,
  removeContributionStatementParameters,
  searchKnowledgeParameters
} from './knowledge-maintenance-tool-catalog'

const MAX_EVIDENCE_OUTPUT_CHARS = 64 * 1_024

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
  if (!Array.isArray(input.evidenceLines)) throw new Error('Raw Evidence 行数据无效')
  if (
    typeof input.evidenceFormatVersion !== 'string'
    || !input.evidenceFormatVersion.trim()
    || input.evidenceFormatVersion.length > 128
  ) {
    throw new Error('Raw Evidence 格式版本无效')
  }
  if (input.evidenceLines.some((line) => typeof line !== 'string' || /[\r\n]/.test(line))) {
    throw new Error('Raw Evidence 必须按单行数组提供')
  }
  input.signal.throwIfAborted()
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

function taskPrompt(input: KnowledgeAgentRunInput): string {
  const lastLine = input.evidenceLines.length
  const readableRange = lastLine > 0
    ? `${observationLineAddress(1)}-${observationLineAddress(lastLine)}`
    : 'No readable lines'
  return [
    'Maintain knowledge in this authorized workspace. The Host owns a general-purpose Todo list and a run-local Contribution Draft. Begin with list_todos, use the provided tools to complete the work, and follow the System Prompt language policy.',
    `Raw Evidence sourceRef: ${input.sourceRef}`,
    `Raw Evidence format: ${input.evidenceFormatVersion}`,
    `Range available to read_evidence: ${readableRange}. Evidence locations use one-based line and zero-based UTF-16 offset; limit is also measured in UTF-16 code units and must be at least 2 (maximum applied limit ${MAX_EVIDENCE_READ_LIMIT}). Always set a bounded limit and copy the returned Next location when more detail is needed.`,
    'Tool calls may be repeated when useful. Keep each read bounded and use returned continuation locations to inspect more material progressively.',
    input.attention?.trim() ? `Attention:\n${input.attention.trim()}` : undefined
  ].filter((part): part is string => Boolean(part)).join('\n\n')
}

export class PiKnowledgeMaintenanceAgent implements KnowledgeAgentRuntime {
  constructor(private readonly knowledgeReader: KnowledgeReader) {}

  async run(input: KnowledgeAgentRunInput): Promise<KnowledgeAgentRunResult> {
    validateRunInput(input)
    const runtime: ModelRuntime = input.runtime
    const contributionDraft = new KnowledgeContributionWorkspace()
    let compactionError: Error | undefined

    const agentRuntime = createPiAgentRuntime({
      initialTodos: input.initialTodos ?? [],
      run: { runId: input.runId, onUpdate: input.onRunUpdate }
    })

    const reportWorkspaceStatus = (): void => {
      const todos = agentRuntime.todos.list()
      const pending = todos.filter((todo) => todo.status === 'pending').length
      try {
        input.onWorkspaceStatus?.({
          todos: {
            total: todos.length,
            pending,
            completed: todos.length - pending
          },
          draftStatementCount: contributionDraft.size
        })
      } catch {
        // Business UI observation must not change Agent execution.
      }
    }

    reportWorkspaceStatus()

    const guardedStreamFn: StreamFn = async (model, context, options) => {
      try {
        return await runtime.streamFn(model, context, options)
      } catch (error) {
        const normalized = asError(error, '模型 Runtime 调用失败')
        return failedModelStream(model, normalized.message)
      }
    }

    const tools: AgentTool[] = [
      {
        ...knowledgeMaintenanceToolDefinition('search_knowledge'),
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
        ...knowledgeMaintenanceToolDefinition('read_knowledge'),
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
        ...knowledgeMaintenanceToolDefinition('upsert_contribution_statement'),
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
        ...knowledgeMaintenanceToolDefinition('read_contribution_statement'),
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
        ...knowledgeMaintenanceToolDefinition('list_contribution_statements'),
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
        ...knowledgeMaintenanceToolDefinition('remove_contribution_statement'),
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
        ...knowledgeMaintenanceToolDefinition('read_evidence'),
        executionMode: 'sequential',
        execute: async (_toolCallId, parameters, signal) => {
          signal?.throwIfAborted()
          const page = readEvidencePage(
            input.evidenceLines,
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
      ...agentRuntime.tools
    ]

    const thinkingLevel = runtime.model.reasoning ? (input.reasoningEffort ?? 'off') : 'off'
    const compactContext = createPiContextCompactor({
      model: runtime.model,
      streamFn: agentRuntime.run.wrapStreamFn(guardedStreamFn, 'context_compaction'),
      systemPrompt: input.systemPrompt,
      tools,
      thinkingLevel
    })
    const agent = new Agent({
      initialState: {
        systemPrompt: input.systemPrompt,
        model: runtime.model,
        thinkingLevel,
        tools
      },
      streamFn: agentRuntime.run.wrapStreamFn(guardedStreamFn),
      convertToLlm: convertPiAgentMessages,
      transformContext: async (messages, signal) => {
        try {
          return await compactContext(messages, signal)
        } catch (error) {
          compactionError = asError(error, 'Context compaction failed')
          throw compactionError
        }
      },
      toolExecution: 'sequential'
    })

    const detachRuntime = agentRuntime.attach(agent)

    agent.subscribe((event) => {
      if (event.type === 'tool_execution_end') {
        if (
          !event.isError
          && (event.toolName === 'list_todos'
            || event.toolName === 'add_todos'
            || event.toolName === 'complete_todos')
        ) reportWorkspaceStatus()
      }
    })

    const abortAgent = (): void => agent.abort()
    input.signal.addEventListener('abort', abortAgent, { once: true })

    try {
      const run = agent.prompt(taskPrompt(input))
      if (input.signal.aborted) agent.abort()
      await run
      if (input.signal.aborted) throw asError(input.signal.reason, 'Knowledge Maintenance Agent 运行已取消')
      if (
        compactionError instanceof PiContextWindowError
        || compactionError instanceof PiContextCompactionOutputError
      ) throw compactionError
      if (compactionError) throw new ModelConnectionFailureError(compactionError)
      if (agent.state.errorMessage) {
        throw new ModelConnectionFailureError(
          new Error(`Knowledge Maintenance Agent 模型调用失败：${agent.state.errorMessage}`)
        )
      }
      let finalAssistantMessage: AssistantMessage | undefined
      for (let index = agent.state.messages.length - 1; index >= 0; index--) {
        const message = agent.state.messages[index]
        if (message.role !== 'assistant') continue
        finalAssistantMessage = message
        break
      }
      if (finalAssistantMessage?.stopReason === 'length') {
        throw new ModelOutputTruncatedError('Knowledge Maintenance Agent 的最终模型输出达到长度上限，运行结果不完整')
      }
      if (!finalAssistantMessage || finalAssistantMessage.stopReason !== 'stop') {
        throw new Error('Knowledge Maintenance Agent 未正常自然结束')
      }
      if (agentRuntime.todos.pendingCount) {
        throw new Error('Knowledge Maintenance Agent 结束时仍有 pending Todo')
      }
      const contribution = contributionDraft.contribution(input.contributionRunRef)
      const recordedRun = agentRuntime.run.complete('completed')
      return {
        contribution,
        todos: agentRuntime.todos.list(),
        run: recordedRun,
        modelCallCount: recordedRun.modelCalls.length,
        toolCalls: recordedRun.toolCalls.map((call) => call.name)
      }
    } catch (error) {
      agentRuntime.run.complete(input.signal.aborted ? 'cancelled' : 'failed', error)
      throw error
    } finally {
      input.signal.removeEventListener('abort', abortAgent)
      detachRuntime()
    }
  }
}

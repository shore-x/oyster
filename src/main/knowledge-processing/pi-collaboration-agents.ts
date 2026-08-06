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
import { createCodingTools } from '@earendil-works/pi-coding-agent'
import {
  ModelConnectionFailureError,
  ModelOutputTruncatedError,
  type ModelRuntime
} from '../ai-backends/model'
import {
  createPiContextCompactor,
  PiContextCompactionOutputError,
  PiContextWindowError
} from '../agent-runtime/pi-context-compactor'
import {
  convertPiAgentMessages,
  createPiAgentRuntime
} from '../agent-runtime/pi-agent-runtime'
import { createArtifactGitEnvironment } from '../artifacts/git-runtime'
import {
  formatActivityLocation,
  formatActivityReadPage,
  MAX_ACTIVITY_READ_LIMIT,
  readActivityPage
} from '../observation/activity-location'
import {
  formatEvidenceLocation,
  formatEvidenceReadPage,
  MAX_EVIDENCE_READ_LIMIT,
  observationLineAddress,
  readEvidencePage
} from '../observation/evidence-location'
import { REASONING_EFFORTS } from '../../shared/ai-backends'
import type { AgentRunRecord } from '../../shared/agent-runtime'
import {
  REVIEW_MARKER_COMMENT,
  REVIEW_MARKER_END,
  REVIEW_MARKER_START,
  type ProcessingRun
} from './processing-repository'
import {
  knowledgeMaintenanceToolDefinition,
  readActivityAttachmentParameters,
  readActivityParameters,
  readEvidenceParameters
} from './knowledge-maintenance-tool-catalog'
import type {
  KnowledgeMaintainerRunInput,
  KnowledgeMaintainerRuntime,
  KnowledgeReviewerRunInput,
  KnowledgeReviewerRuntime,
  RepositoryAgentRunResult
} from './model'

const MAX_TOOL_OUTPUT_CHARACTERS = 64 * 1_024

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

function validateBaseInput(input: KnowledgeMaintainerRunInput | KnowledgeReviewerRunInput): void {
  if (!input.systemPrompt.trim()) throw new Error('Agent System Prompt 不能为空')
  if (input.reasoningEffort && !REASONING_EFFORTS.includes(input.reasoningEffort)) {
    throw new Error('思考强度无效')
  }
  if (!input.run?.repositoryPath || !input.run.workPath || !input.run.branchName) {
    throw new Error('Processing Run 无效')
  }
  input.signal.throwIfAborted()
}

function codingTools(run: ProcessingRun): AgentTool[] {
  return createCodingTools(run.repositoryPath, {
    bash: {
      spawnHook: (context) => ({
        ...context,
        env: createArtifactGitEnvironment(context.env)
      })
    }
  })
}

function observationTools(input: KnowledgeMaintainerRunInput): AgentTool[] {
  const { rawEvidence, canonicalActivity } = input.observation
  const runtime = input.runtime
  return [
    {
      ...knowledgeMaintenanceToolDefinition('read_activity'),
      executionMode: 'sequential',
      execute: async (_toolCallId, parameters, signal) => {
        signal?.throwIfAborted()
        const page = readActivityPage(
          canonicalActivity,
          { activity: parameters.activity, offset: parameters.offset },
          parameters.limit
        )
        const output = formatActivityReadPage(page)
        if (output.length > MAX_TOOL_OUTPUT_CHARACTERS) {
          throw new Error('read_activity 内部输出超过安全上限')
        }
        return {
          content: [{ type: 'text', text: output }],
          details: {
            start: formatActivityLocation(page.start),
            end: formatActivityLocation(page.end),
            next: page.next ? formatActivityLocation(page.next) : null,
            eof: page.eof,
            returnedCharacters: page.returnedCharacters,
            returnedActivities: page.returnedActivities
          }
        }
      }
    } as AgentTool<typeof readActivityParameters>,
    {
      ...knowledgeMaintenanceToolDefinition('read_activity_attachment'),
      executionMode: 'sequential',
      execute: async (_toolCallId, parameters, signal) => {
        signal?.throwIfAborted()
        const attachment = canonicalActivity.attachments.find((item) => item.id === parameters.id)
        if (!attachment) throw new Error(`Canonical Activity Attachment 不存在：${parameters.id}`)
        if (!attachment.mimeType.startsWith('image/')) {
          throw new Error(`当前不支持读取 ${attachment.mimeType} 附件`)
        }
        if (!runtime.model.input?.includes('image')) {
          throw new Error(`当前 Maintainer Model 不支持图片输入，无法检查 ${parameters.id}`)
        }
        return {
          content: [
            {
              type: 'text',
              text: [
                `Attachment: ${attachment.id}`,
                `Media type: ${attachment.mimeType}`,
                `Bytes: ${attachment.byteLength}`,
                `SHA-256: ${attachment.sha256}`,
                `Raw source: ${formatEvidenceLocation(attachment.rawRange.start)}`
              ].join('\n')
            },
            { type: 'image', data: attachment.data, mimeType: attachment.mimeType }
          ],
          details: {
            id: attachment.id,
            mimeType: attachment.mimeType,
            byteLength: attachment.byteLength,
            sha256: attachment.sha256
          }
        }
      }
    } as AgentTool<typeof readActivityAttachmentParameters>,
    {
      ...knowledgeMaintenanceToolDefinition('read_evidence'),
      executionMode: 'sequential',
      execute: async (_toolCallId, parameters, signal) => {
        signal?.throwIfAborted()
        const page = readEvidencePage(
          rawEvidence.lines,
          { line: parameters.line, offset: parameters.offset },
          parameters.limit
        )
        const output = formatEvidenceReadPage(page)
        if (output.length > MAX_TOOL_OUTPUT_CHARACTERS) {
          throw new Error('read_evidence 内部输出超过安全上限')
        }
        return {
          content: [{ type: 'text', text: output }],
          details: {
            start: formatEvidenceLocation(page.start),
            end: formatEvidenceLocation(page.end),
            next: page.next ? formatEvidenceLocation(page.next) : null,
            eof: page.eof,
            returnedCharacters: page.returnedCharacters,
            returnedLines: page.returnedLines
          }
        }
      }
    } as AgentTool<typeof readEvidenceParameters>
  ]
}

interface RunRepositoryAgentInput {
  agentId: 'knowledge_maintenance_agent' | 'knowledge_reviewer_agent'
  runtime: ModelRuntime
  systemPrompt: string
  taskPrompt: string
  reasoningEffort?: KnowledgeMaintainerRunInput['reasoningEffort']
  runId: string
  onRunUpdate?: (run: AgentRunRecord) => void
  signal: AbortSignal
  tools: AgentTool[]
}

async function runRepositoryAgent(input: RunRepositoryAgentInput): Promise<RepositoryAgentRunResult> {
  let compactionError: Error | undefined
  const agentRuntime = createPiAgentRuntime({
    agentId: input.agentId,
    run: { runId: input.runId, onUpdate: input.onRunUpdate }
  })
  const guardedStreamFn: StreamFn = async (model, context, options) => {
    try {
      return await input.runtime.streamFn(model, context, options)
    } catch (error) {
      return failedModelStream(model, asError(error, '模型 Runtime 调用失败').message)
    }
  }
  const thinkingLevel = input.runtime.model.reasoning ? (input.reasoningEffort ?? 'off') : 'off'
  const compactContext = createPiContextCompactor({
    model: input.runtime.model,
    streamFn: agentRuntime.run.wrapStreamFn(guardedStreamFn, 'context_compaction'),
    systemPrompt: input.systemPrompt,
    tools: input.tools,
    thinkingLevel
  })
  const agent = new Agent({
    initialState: {
      systemPrompt: input.systemPrompt,
      model: input.runtime.model,
      thinkingLevel,
      tools: input.tools
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
  const abortAgent = (): void => agent.abort()
  input.signal.addEventListener('abort', abortAgent, { once: true })
  try {
    const active = agent.prompt(input.taskPrompt)
    if (input.signal.aborted) agent.abort()
    await active
    if (input.signal.aborted) throw asError(input.signal.reason, 'Agent 运行已取消')
    if (
      compactionError instanceof PiContextWindowError
      || compactionError instanceof PiContextCompactionOutputError
    ) throw compactionError
    if (compactionError) throw new ModelConnectionFailureError(compactionError)
    if (agent.state.errorMessage) {
      throw new ModelConnectionFailureError(new Error(`Agent 模型调用失败：${agent.state.errorMessage}`))
    }
    const finalMessage = [...agent.state.messages].reverse().find((message) => message.role === 'assistant')
    if (finalMessage?.stopReason === 'length') {
      throw new ModelOutputTruncatedError('Agent 最终模型输出达到长度上限，运行结果不完整')
    }
    if (!finalMessage || finalMessage.stopReason !== 'stop') throw new Error('Agent 未正常自然结束')
    const run = agentRuntime.run.complete('completed')
    return {
      run,
      modelCallCount: run.modelCalls.length,
      toolCalls: run.toolCalls.map((call) => call.name)
    }
  } catch (error) {
    agentRuntime.run.complete(input.signal.aborted ? 'cancelled' : 'failed', error)
    throw error
  } finally {
    input.signal.removeEventListener('abort', abortAgent)
    detachRuntime()
  }
}

function maintainerTaskPrompt(input: KnowledgeMaintainerRunInput): string {
  const { rawEvidence, canonicalActivity } = input.observation
  const lastLine = rawEvidence.lines.length
  return [
    `Repository root: ${input.run.repositoryPath}`,
    `Run directory: ${input.run.runPath}`,
    `Processing branch: ${input.run.branchName}`,
    `Previous handoff revision: ${input.previousRevision}`,
    `Base revision: ${input.run.baseRevision}`,
    `Work state: ${input.run.workPath}`,
    `Raw Evidence sourceRef: ${input.sourceRef}`,
    `Canonical Activity format: ${canonicalActivity.formatVersion}. Range: A000001-A${String(canonicalActivity.items.length).padStart(6, '0')}. Maximum read limit: ${MAX_ACTIVITY_READ_LIMIT}.`,
    `Raw Evidence format: ${rawEvidence.formatVersion}. Range: ${observationLineAddress(1)}-${observationLineAddress(lastLine)}. Maximum read limit: ${MAX_EVIDENCE_READ_LIMIT}.`,
    'Begin by reading the work order. It is the authoritative checklist for this run. Complete its work, mark every checkbox complete, update Knowledge and Artifact files directly, and commit one clean Maintainer handoff.'
  ].join('\n\n')
}

function reviewerTaskPrompt(input: KnowledgeReviewerRunInput): string {
  return [
    `Repository root: ${input.run.repositoryPath}`,
    `Run directory: ${input.run.runPath}`,
    `Processing branch: ${input.run.branchName}`,
    `Base revision: ${input.run.baseRevision}`,
    `Exact revision to review: ${input.reviewedRevision}`,
    `Run work state: ${input.run.workPath}`,
    'Review only if HEAD still equals the exact revision above. If changes are required, add REVIEW blocks to the affected files, append at least one unchecked item to WORK.md, and commit the Knowledge/Artifact corrections. If the tree is acceptable, finish without creating another commit. The Harness records the validated Reviewer handoff in WORK.md. Never merge the target branch.'
  ].join('\n\n')
}

export class PiKnowledgeMaintainerAgent implements KnowledgeMaintainerRuntime {
  async run(input: KnowledgeMaintainerRunInput): Promise<RepositoryAgentRunResult> {
    validateBaseInput(input)
    if (!input.sourceRef.trim()) throw new Error('Raw Evidence sourceRef 无效')
    return runRepositoryAgent({
      agentId: 'knowledge_maintenance_agent',
      runtime: input.runtime,
      systemPrompt: input.systemPrompt,
      taskPrompt: maintainerTaskPrompt(input),
      reasoningEffort: input.reasoningEffort,
      runId: input.runId,
      onRunUpdate: input.onRunUpdate,
      signal: input.signal,
      tools: [...codingTools(input.run), ...observationTools(input)]
    })
  }
}

export class PiKnowledgeReviewerAgent implements KnowledgeReviewerRuntime {
  async run(input: KnowledgeReviewerRunInput): Promise<RepositoryAgentRunResult> {
    validateBaseInput(input)
    if (!/^[a-f0-9]{40,64}$/i.test(input.reviewedRevision)) {
      throw new Error('Reviewer revision 无效')
    }
    return runRepositoryAgent({
      agentId: 'knowledge_reviewer_agent',
      runtime: input.runtime,
      systemPrompt: input.systemPrompt,
      taskPrompt: reviewerTaskPrompt(input),
      reasoningEffort: input.reasoningEffort,
      runId: input.runId,
      onRunUpdate: input.onRunUpdate,
      signal: input.signal,
      tools: codingTools(input.run)
    })
  }
}

export const REVIEW_MARKER_FORMAT = [
  REVIEW_MARKER_START,
  'content under review',
  REVIEW_MARKER_COMMENT,
  'actionable review explanation',
  REVIEW_MARKER_END
].join('\n')

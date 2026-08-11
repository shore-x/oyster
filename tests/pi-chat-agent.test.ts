import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createAssistantMessageEventStream,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall
} from '@earendil-works/pi-ai'
import type { SelectedModelStream } from '../src/main/ai-backends/model'
import { PiChatAgent } from '../src/main/chat/pi-chat-agent'
import { PiChatConversationRepository } from '../src/main/chat/pi-chat-conversation-repository'
import type { AgentInvocationDebugRecord } from '../src/shared/agent-runtime'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('PiChatAgent', () => {
  it('loads Pi ecosystem extensions from Oyster agentDir', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'oyster-pi-extension-'))
    temporaryPaths.push(rootPath)
    const agentDir = join(rootPath, 'pi-agent')
    await mkdir(join(agentDir, 'extensions'), { recursive: true })
    await writeFile(join(agentDir, 'extensions', 'oyster-context.js'), [
      'export default function (pi) {',
      '  pi.on("before_agent_start", async (event) => ({',
      '    systemPrompt: `${event.systemPrompt}\\n\\nPI_EXTENSION_ACTIVE`',
      '  }))',
      '}',
      ''
    ].join('\n'))
    const conversations = new PiChatConversationRepository(join(rootPath, 'conversations'))
    const binding = {
      connectionId: 'connection:test',
      modelId: 'extension-model',
      systemPrompt: 'Use configured extensions.'
    }
    const opened = await conversations.create(binding)
    const faux = fauxProvider()
    faux.setResponses([(context) => {
      expect(context.systemPrompt).toContain('PI_EXTENSION_ACTIVE')
      return fauxAssistantMessage('Extension observed.')
    }])
    const models = createModels()
    models.setProvider(faux.provider)

    await new PiChatAgent(rootPath, agentDir).invoke({
      conversationId: opened.id,
      rootInvocationId: randomUUID(),
      piSessionManager: opened.piSessionManager,
      binding,
      modelStream: {
        model: { ...faux.getModel(), id: binding.modelId },
        streamFn: (model, context, options) => models.streamSimple(model, context, options)
      },
      text: 'Use the extension.',
      signal: new AbortController().signal
    })

    expect((await conversations.detail(opened.id)).messages.at(-1)?.message).toMatchObject({
      role: 'assistant',
      text: 'Extension observed.'
    })
    await conversations.dispose()
  })

  it('does not execute project-local Pi extensions without an Oyster trust decision', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'oyster-pi-project-extension-'))
    temporaryPaths.push(rootPath)
    const agentDir = join(rootPath, 'pi-agent')
    await mkdir(join(rootPath, '.pi', 'extensions'), { recursive: true })
    await writeFile(join(rootPath, '.pi', 'extensions', 'untrusted.js'), [
      'export default function (pi) {',
      '  pi.on("before_agent_start", async (event) => ({',
      '    systemPrompt: `${event.systemPrompt}\\n\\nUNTRUSTED_PROJECT_EXTENSION`',
      '  }))',
      '}',
      ''
    ].join('\n'))
    const conversations = new PiChatConversationRepository(join(rootPath, 'conversations'))
    const binding = {
      connectionId: 'connection:test',
      modelId: 'project-extension-model',
      systemPrompt: 'Do not trust project extensions.'
    }
    const opened = await conversations.create(binding)
    const faux = fauxProvider()
    faux.setResponses([(context) => {
      expect(context.systemPrompt).not.toContain('UNTRUSTED_PROJECT_EXTENSION')
      return fauxAssistantMessage('Project extension ignored.')
    }])
    const models = createModels()
    models.setProvider(faux.provider)

    await new PiChatAgent(rootPath, agentDir).invoke({
      conversationId: opened.id,
      rootInvocationId: randomUUID(),
      piSessionManager: opened.piSessionManager,
      binding,
      modelStream: {
        model: { ...faux.getModel(), id: binding.modelId },
        streamFn: (model, context, options) => models.streamSimple(model, context, options)
      },
      text: 'Ignore the project extension.',
      signal: new AbortController().signal
    })

    expect((await conversations.detail(opened.id)).messages.at(-1)?.message).toMatchObject({
      role: 'assistant',
      text: 'Project extension ignored.'
    })
    await conversations.dispose()
  })

  it('compacts model context while retaining the complete persisted transcript', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'oyster-pi-chat-'))
    temporaryPaths.push(rootPath)
    const sessions = new PiChatConversationRepository(join(rootPath, 'sessions'))
    const binding = {
      connectionId: 'connection:test',
      modelId: 'small-model',
      systemPrompt: 'Answer with local knowledge.'
    }
    const opened = await sessions.create(binding)
    await opened.piSessionManager.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'durable history '.repeat(20_000) }],
      timestamp: 1
    })
    await opened.piSessionManager.appendMessage(fauxAssistantMessage('Acknowledged.', { timestamp: 2 }))
    await opened.piSessionManager.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'newer durable history '.repeat(20_000) }],
      timestamp: 3
    })
    await opened.piSessionManager.appendMessage(fauxAssistantMessage('Also acknowledged.', { timestamp: 4 }))

    const baseModel = fauxProvider().getModel()
    const model = { ...baseModel, id: 'small-model', contextWindow: 32_000, maxTokens: 512 }
    let compactionCalls = 0
    let normalCalls = 0
    let overflowReturned = false
    const modelStream: SelectedModelStream = {
      model,
      streamFn: (_requestedModel, context) => {
        const stream = createAssistantMessageEventStream()
        if (context.systemPrompt?.startsWith('You are a context summarization assistant')) {
          compactionCalls++
          stream.end(fauxAssistantMessage('The user supplied earlier durable history.'))
          return stream
        }
        normalCalls++
        if (!overflowReturned) {
          overflowReturned = true
          const overflow = fauxAssistantMessage('', {
            stopReason: 'error',
            errorMessage: "This model's maximum context length is 32000 tokens"
          })
          overflow.provider = model.provider
          overflow.model = model.id
          stream.end(overflow)
          return stream
        }
        expect(JSON.stringify(context.messages)).toContain('<summary>')
        stream.end(fauxAssistantMessage('Continued after compaction.'))
        return stream
      }
    }
    const metadata = { id: opened.id }
    const invocations = new Map<string, AgentInvocationDebugRecord>()
    await new PiChatAgent(rootPath).invoke({
      conversationId: metadata.id,
      rootInvocationId: randomUUID(),
      piSessionManager: opened.piSessionManager,
      binding,
      modelStream,
      text: 'Continue.',
      signal: new AbortController().signal,
      onInvocationUpdate: (invocation) => invocations.set(invocation.id, invocation)
    })
    for (const invocation of invocations.values()) {
      if (invocation.status !== 'in_progress') {
        await sessions.appendInvocation(metadata.id, invocation)
      }
    }

    expect(compactionCalls).toBeGreaterThan(0)
    expect(normalCalls).toBe(2)
    const detail = await sessions.detail(metadata.id)
    expect(detail.messages).toHaveLength(7)
    expect(detail.messages[0].message).toMatchObject({ role: 'user' })
    expect(detail.messages.at(-1)?.message).toMatchObject({
      role: 'assistant',
      text: 'Continued after compaction.'
    })
    expect(detail.invocations).toHaveLength(1)
    expect(detail.invocations[0].modelCalls.some((call) => call.purpose === 'context_compaction')).toBe(true)
    expect(detail.invocations[0].modelCalls.some((call) => call.purpose === 'agent')).toBe(true)
    expect(detail.invocations[0].modelCalls.find((call) => call.purpose === 'agent')?.context.messages)
      .toContainEqual(expect.objectContaining({ role: 'user' }))
    await sessions.dispose()
  })

  it('binds initial Todos outside messages and hides Runtime feedback from the Chat projection', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'oyster-pi-chat-todos-'))
    temporaryPaths.push(rootPath)
    const sessions = new PiChatConversationRepository(join(rootPath, 'sessions'))
    const binding = {
      connectionId: 'connection:test',
      modelId: 'todo-model',
      systemPrompt: 'Complete the task.'
    }
    const opened = await sessions.create(binding)
    const faux = fauxProvider()
    faux.setResponses([
      (context) => {
        expect(JSON.stringify(context.messages)).not.toContain('Inspect the artifact')
        return fauxAssistantMessage('Finished too early.')
      },
      (context) => {
        expect(JSON.stringify(context.messages)).toContain('1 Todos remain pending')
        return fauxAssistantMessage(
          fauxToolCall('list_todos', {}),
          { stopReason: 'toolUse' }
        )
      },
      (context) => {
        expect(JSON.stringify(context.messages)).toContain('T000001 [pending] Inspect the artifact')
        return fauxAssistantMessage(
          fauxToolCall('complete_todos', { ids: ['T000001'] }),
          { stopReason: 'toolUse' }
        )
      },
      fauxAssistantMessage('Finished after completing the Todo.')
    ])
    const models = createModels()
    models.setProvider(faux.provider)
    const modelStream: SelectedModelStream = {
      model: { ...faux.getModel(), id: 'todo-model' },
      streamFn: (model, context, options) => models.streamSimple(model, context, options)
    }
    const metadata = { id: opened.id }

    const invocations = new Map<string, AgentInvocationDebugRecord>()
    await new PiChatAgent(rootPath).invoke({
      conversationId: metadata.id,
      rootInvocationId: randomUUID(),
      piSessionManager: opened.piSessionManager,
      binding,
      modelStream,
      text: 'Start.',
      initialTodos: ['Inspect the artifact'],
      signal: new AbortController().signal,
      onInvocationUpdate: (invocation) => invocations.set(invocation.id, invocation)
    })
    for (const invocation of invocations.values()) {
      if (invocation.status !== 'in_progress') {
        await sessions.appendInvocation(metadata.id, invocation)
      }
    }

    const detail = await sessions.detail(metadata.id)
    expect(detail.messages.filter((entry) => entry.message.role === 'user')).toHaveLength(1)
    expect(JSON.stringify(detail.messages)).not.toContain('The Agent cannot finish yet')
    expect(detail.messages.at(-1)?.message).toMatchObject({
      role: 'assistant',
      text: 'Finished after completing the Todo.'
    })
    expect(detail.invocations).toHaveLength(1)
    expect(detail.invocations[0]).toMatchObject({ status: 'completed' })
    expect(detail.invocations[0].modelCalls).toHaveLength(4)
    const rawContext = opened.piSessionManager.buildSessionContext()
    expect(rawContext.messages).toContainEqual(expect.objectContaining({
      role: 'custom',
      customType: 'oyster-runtime-feedback-v1'
    }))

    await sessions.dispose()
  })
})
import { randomUUID } from 'node:crypto'

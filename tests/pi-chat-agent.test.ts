import { mkdtemp, rm } from 'node:fs/promises'
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
import type { ModelRuntime } from '../src/main/ai-backends/model'
import { PiChatAgent } from '../src/main/chat/pi-chat-agent'
import { PiChatSessionRepository } from '../src/main/chat/pi-chat-session-repository'
import { SqliteKnowledgeStore } from '../src/main/knowledge-store/sqlite-knowledge-store'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('PiChatAgent', () => {
  it('compacts model context while retaining the complete persisted transcript', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'oyster-pi-chat-'))
    temporaryPaths.push(rootPath)
    const sessions = new PiChatSessionRepository(join(rootPath, 'sessions'))
    const knowledgeStore = new SqliteKnowledgeStore(join(rootPath, 'knowledge.sqlite'))
    const binding = {
      connectionId: 'connection:test',
      modelId: 'small-model',
      systemPrompt: 'Answer with local knowledge.'
    }
    const opened = await sessions.create(binding)
    await opened.session.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'durable history '.repeat(4_000) }],
      timestamp: 1
    })
    await opened.session.appendMessage(fauxAssistantMessage('Acknowledged.', { timestamp: 2 }))

    const baseModel = fauxProvider().getModel()
    const model = { ...baseModel, id: 'small-model', contextWindow: 8_000, maxTokens: 512 }
    let compactionCalls = 0
    let normalCalls = 0
    const runtime: ModelRuntime = {
      model,
      streamFn: (_requestedModel, context) => {
        const stream = createAssistantMessageEventStream()
        if (context.systemPrompt?.startsWith('You compact an agent')) {
          compactionCalls++
          stream.end(fauxAssistantMessage('The user supplied earlier durable history.'))
          return stream
        }
        normalCalls++
        expect(JSON.stringify(context.messages)).toContain('<context-summary>')
        stream.end(fauxAssistantMessage('Continued after compaction.'))
        return stream
      }
    }
    const metadata = await opened.session.getMetadata()
    await new PiChatAgent(knowledgeStore, join(rootPath, 'artifacts')).run({
      sessionId: metadata.id,
      session: opened.session,
      binding,
      runtime,
      text: 'Continue.',
      signal: new AbortController().signal
    })

    expect(compactionCalls).toBeGreaterThan(0)
    expect(normalCalls).toBe(1)
    const detail = await sessions.detail(metadata.id)
    expect(detail.messages).toHaveLength(4)
    expect(detail.messages[0].message).toMatchObject({ role: 'user' })
    expect(detail.messages.at(-1)?.message).toMatchObject({
      role: 'assistant',
      text: 'Continued after compaction.'
    })
    expect(detail.runs).toHaveLength(1)
    expect(detail.runs[0].modelCalls.some((call) => call.purpose === 'context_compaction')).toBe(true)
    expect(detail.runs[0].modelCalls.some((call) => call.purpose === 'agent')).toBe(true)
    expect(detail.runs[0].modelCalls.find((call) => call.purpose === 'agent')?.context.messages)
      .toContainEqual(expect.objectContaining({ role: 'user' }))
    knowledgeStore.close()
    await sessions.dispose()
  })

  it('binds initial Todos outside messages and hides Runtime feedback from the Chat projection', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'oyster-pi-chat-todos-'))
    temporaryPaths.push(rootPath)
    const sessions = new PiChatSessionRepository(join(rootPath, 'sessions'))
    const knowledgeStore = new SqliteKnowledgeStore(join(rootPath, 'knowledge.sqlite'))
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
    const runtime: ModelRuntime = {
      model: { ...faux.getModel(), id: 'todo-model' },
      streamFn: (model, context, options) => models.streamSimple(model, context, options)
    }
    const metadata = await opened.session.getMetadata()

    await new PiChatAgent(knowledgeStore, join(rootPath, 'artifacts')).run({
      sessionId: metadata.id,
      session: opened.session,
      binding,
      runtime,
      text: 'Start.',
      initialTodos: ['Inspect the artifact'],
      signal: new AbortController().signal
    })

    const detail = await sessions.detail(metadata.id)
    expect(detail.messages.filter((entry) => entry.message.role === 'user')).toHaveLength(1)
    expect(JSON.stringify(detail.messages)).not.toContain('The Agent cannot finish yet')
    expect(detail.messages.at(-1)?.message).toMatchObject({
      role: 'assistant',
      text: 'Finished after completing the Todo.'
    })
    expect(detail.runs).toHaveLength(1)
    expect(detail.runs[0]).toMatchObject({ status: 'completed' })
    expect(detail.runs[0].modelCalls).toHaveLength(4)
    const rawContext = await opened.session.buildContext()
    expect(rawContext.messages).toContainEqual(expect.objectContaining({ role: 'runtimeFeedback' }))

    knowledgeStore.close()
    await sessions.dispose()
  })
})

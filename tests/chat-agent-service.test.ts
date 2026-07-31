import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createAssistantMessageEventStream,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type AssistantMessage,
  type FauxResponseStep
} from '@earendil-works/pi-ai'
import type { AiBackendSnapshot } from '../src/shared/ai-backends'
import type { ModelRuntime } from '../src/main/ai-backends/model'
import type { ChatAiBackendPort, ChatConfigurationRepository } from '../src/main/chat/model'
import { ChatAgentService } from '../src/main/chat/chat-agent-service'
import { InMemoryChatConfigurationRepository } from '../src/main/chat/chat-configuration-repository'
import { PiChatSessionRepository } from '../src/main/chat/pi-chat-session-repository'
import {
  DEFAULT_CHAT_AGENT_SYSTEM_PROMPT,
  chatAgentSystemPrompt
} from '../src/main/chat/prompt'
import { ARTIFACT_GIT_BINARY_PATH } from '../src/main/artifacts/git-runtime'
import { SqliteKnowledgeStore } from '../src/main/knowledge-store/sqlite-knowledge-store'
import type { ChatEvent } from '../src/shared/chat'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function fauxRuntime(responses: FauxResponseStep[]): { runtime: ModelRuntime; callCount: () => number } {
  const faux = fauxProvider()
  faux.setResponses(responses)
  const models = createModels()
  models.setProvider(faux.provider)
  return {
    runtime: {
      model: faux.getModel(),
      streamFn: (model, context, options) => models.streamSimple(model, context, options)
    },
    callCount: () => faux.state.callCount
  }
}

class FauxAiBackend implements ChatAiBackendPort {
  constructor(readonly runtime: ModelRuntime) {}

  snapshot(): AiBackendSnapshot {
    return {
      options: [],
      connections: [{
        id: 'connection:test',
        adapterId: 'openai-compatible',
        backendKind: 'api',
        providerId: 'openai_compatible',
        displayName: 'Test',
        credentialMode: 'oyster_keychain',
        status: 'ready',
        models: [{ id: this.runtime.model.id, displayName: 'Test Model', reasoningEfforts: [] }]
      }]
    }
  }

  async withModelRuntime<T>(
    _connectionId: string,
    _modelId: string,
    operation: (runtime: ModelRuntime) => Promise<T>
  ): Promise<T> {
    return operation(this.runtime)
  }
}

async function serviceFixture(
  responses: FauxResponseStep[] | ((paths: {
    rootPath: string
    artifactRepositoryPath: string
  }) => FauxResponseStep[]),
  configuration: ChatConfigurationRepository = new InMemoryChatConfigurationRepository()
) {
  const rootPath = await mkdtemp(join(tmpdir(), 'oyster-chat-service-'))
  temporaryPaths.push(rootPath)
  const artifactRepositoryPath = join(rootPath, 'artifacts')
  await mkdir(artifactRepositoryPath)
  const sessions = new PiChatSessionRepository(join(rootPath, 'sessions'))
  const knowledgeStore = new SqliteKnowledgeStore(join(rootPath, 'knowledge.sqlite'))
  const prepared = fauxRuntime(typeof responses === 'function'
    ? responses({ rootPath, artifactRepositoryPath })
    : responses)
  const service = new ChatAgentService({
    sessions,
    configuration,
    aiBackend: new FauxAiBackend(prepared.runtime),
    knowledgeStore,
    artifactRepositoryPath
  })
  await service.initialize()
  return {
    rootPath,
    artifactRepositoryPath,
    sessions,
    knowledgeStore,
    configuration,
    service,
    ...prepared
  }
}

describe('ChatAgentService', () => {
  it('freezes the configured prompt and runs a persisted Pi conversation with direct Knowledge Store writes', async () => {
    const customPrompt = 'Use local knowledge and reply briefly.'
    const fixture = await serviceFixture(({ artifactRepositoryPath }) => [
      (context) => {
        expect(context.systemPrompt).toBe(chatAgentSystemPrompt(
          customPrompt,
          artifactRepositoryPath
        ))
        expect(context.tools?.map((tool) => tool.name)).toEqual([
          'read',
          'bash',
          'edit',
          'write',
          'search_knowledge',
          'read_knowledge',
          'upsert_knowledge'
        ])
        return fauxAssistantMessage(fauxToolCall('search_knowledge', { query: 'Project P' }), {
          stopReason: 'toolUse'
        })
      },
      fauxAssistantMessage(fauxToolCall('read_knowledge', { title: 'Project P' }), {
        stopReason: 'toolUse'
      }),
      fauxAssistantMessage(fauxToolCall('upsert_knowledge', {
        statements: [
          { title: 'Project P', content: '[[Project P]] now uses SQLite.' },
          { title: 'SQLite', content: 'SQLite is the database used by [[Project P]].' }
        ]
      }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('Knowledge was updated.')
    ])
    fixture.knowledgeStore.commit({
      runRef: 'seed',
      statements: [{ title: 'Project P', content: 'Project P is local.' }]
    })
    const events: ChatEvent[] = []
    fixture.service.subscribe((event) => events.push(event))

    await fixture.service.saveDefaultInstructions({ instructionsOverride: customPrompt })
    const session = await fixture.service.createSession({
      binding: { connectionId: 'connection:test', modelId: fixture.runtime.model.id }
    })
    await fixture.service.saveDefaultInstructions({ instructionsOverride: null })
    expect((await fixture.sessions.open(session.id)).binding.systemPrompt).toBe(customPrompt)

    const detail = await fixture.service.sendMessage({
      sessionId: session.id,
      text: 'Please update Project P and SQLite.'
    })
    expect(fixture.callCount()).toBe(4)
    expect(detail.title).toBe('Please update Project P and SQLite.')
    expect(detail.messages.map((entry) => entry.message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'tool',
      'assistant',
      'tool',
      'assistant'
    ])
    expect(detail.messages.find((entry) => entry.message.role === 'tool' && (
      entry.message.toolName === 'upsert_knowledge'
    ))?.message).toMatchObject({
      details: {
        statementCount: 2,
        createdTitles: ['SQLite'],
        updatedTitles: ['Project P']
      }
    })
    expect(fixture.knowledgeStore.getStatement('Project P')?.content).toContain('SQLite')
    expect(fixture.knowledgeStore.getStatement('SQLite')).toBeDefined()
    expect(events).toContainEqual(expect.objectContaining({
      type: 'run_state_changed',
      sessionId: session.id,
      status: 'completed'
    }))
    expect(events).toContainEqual(expect.objectContaining({
      type: 'message_updated',
      sessionId: session.id
    }))
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool_completed',
      toolName: 'upsert_knowledge',
      isError: false
    }))

    const snapshot = await fixture.service.getSnapshot()
    expect(snapshot.agent).toMatchObject({
      builtInInstructions: DEFAULT_CHAT_AGENT_SYSTEM_PROMPT,
      defaultInstructions: DEFAULT_CHAT_AGENT_SYSTEM_PROMPT,
      isDefaultCustomized: false
    })
    expect(snapshot.agent.tools.map((tool) => tool.name)).toEqual([
      'read',
      'bash',
      'edit',
      'write',
      'search_knowledge',
      'read_knowledge',
      'upsert_knowledge'
    ])
    expect(snapshot.agent.tools[6].parameters).toMatchObject({
      type: 'object',
      properties: { statements: { type: 'array', minItems: 1 } }
    })
    fixture.knowledgeStore.close()
    await fixture.sessions.dispose()
  })

  it('starts unrestricted coding tools in the shared Artifact Repository', async () => {
    let outsideRepositoryPath = ''
    const relativeRepositoryPath = 'relative-repository.txt'
    const fixture = await serviceFixture(({ rootPath }) => {
      outsideRepositoryPath = join(rootPath, 'outside-repository.txt')
      return [
        fauxAssistantMessage(fauxToolCall('write', {
          path: relativeRepositoryPath,
          content: 'first version\n'
        }), { stopReason: 'toolUse' }),
        fauxAssistantMessage(fauxToolCall('edit', {
          path: relativeRepositoryPath,
          edits: [{ oldText: 'first version', newText: 'second version' }]
        }), { stopReason: 'toolUse' }),
        fauxAssistantMessage(fauxToolCall('read', {
          path: relativeRepositoryPath
        }), { stopReason: 'toolUse' }),
        fauxAssistantMessage(fauxToolCall('write', {
          path: outsideRepositoryPath,
          content: 'outside repository\n'
        }), { stopReason: 'toolUse' }),
        fauxAssistantMessage(fauxToolCall('bash', {
          command: 'pwd && command -v git'
        }), { stopReason: 'toolUse' }),
        fauxAssistantMessage('Finished.')
      ]
    })
    const events: ChatEvent[] = []
    fixture.service.subscribe((event) => events.push(event))
    const session = await fixture.service.createSession({
      binding: { connectionId: 'connection:test', modelId: fixture.runtime.model.id }
    })

    const detail = await fixture.service.sendMessage({
      sessionId: session.id,
      text: 'Exercise the filesystem tools.'
    })

    expect(await readFile(
      join(fixture.artifactRepositoryPath, relativeRepositoryPath),
      'utf8'
    )).toBe('second version\n')
    expect(await readFile(outsideRepositoryPath, 'utf8')).toBe('outside repository\n')
    const toolMessages = detail.messages
      .map((entry) => entry.message)
      .filter((message) => message.role === 'tool')
    expect(toolMessages.map((message) => message.toolName)).toEqual([
      'write',
      'edit',
      'read',
      'write',
      'bash'
    ])
    expect(toolMessages[2]).toMatchObject({ text: expect.stringContaining('second version') })
    expect(toolMessages[4]).toMatchObject({
      text: expect.stringContaining(fixture.artifactRepositoryPath)
    })
    expect(toolMessages[4]).toMatchObject({
      text: expect.stringContaining(ARTIFACT_GIT_BINARY_PATH)
    })
    for (const toolName of ['write', 'edit', 'read', 'bash']) {
      expect(events).toContainEqual(expect.objectContaining({
        type: 'tool_started',
        toolName
      }))
      expect(events).toContainEqual(expect.objectContaining({
        type: 'tool_completed',
        toolName,
        isError: false
      }))
    }

    fixture.service.dispose()
    fixture.knowledgeStore.close()
    await fixture.sessions.dispose()
  })

  it('does not impose a model-call or tool-call quota', async () => {
    const searches = Array.from({ length: 12 }, (_, index) => fauxAssistantMessage(
      fauxToolCall('search_knowledge', { query: `query-${index}` }),
      { stopReason: 'toolUse' }
    ))
    const fixture = await serviceFixture([...searches, fauxAssistantMessage('Finished.')])
    const session = await fixture.service.createSession({
      binding: { connectionId: 'connection:test', modelId: fixture.runtime.model.id }
    })
    const detail = await fixture.service.sendMessage({ sessionId: session.id, text: 'Search widely.' })

    expect(fixture.callCount()).toBe(13)
    expect(detail.messages.filter((entry) => (
      entry.message.role === 'tool' && entry.message.toolName === 'search_knowledge'
    ))).toHaveLength(12)
    fixture.knowledgeStore.close()
    await fixture.sessions.dispose()
  })

  it('validates model bindings without requiring a prior connection test', async () => {
    const fixture = await serviceFixture([fauxAssistantMessage('Unused.')])
    await expect(fixture.service.createSession({
      binding: { connectionId: 'missing', modelId: fixture.runtime.model.id }
    })).rejects.toThrow('不存在')
    await expect(fixture.service.createSession({
      binding: { connectionId: 'connection:test', modelId: 'missing' }
    })).rejects.toThrow('不可用')
    fixture.knowledgeStore.close()
    await fixture.sessions.dispose()
  })

  it('keeps the active default unchanged when configuration persistence fails', async () => {
    const configuration: ChatConfigurationRepository = {
      async load() { return {} },
      async save() { throw new Error('disk unavailable') }
    }
    const fixture = await serviceFixture([fauxAssistantMessage('Unused.')], configuration)

    await expect(fixture.service.saveDefaultInstructions({
      instructionsOverride: 'This must not become active.'
    })).rejects.toThrow('disk unavailable')
    expect((await fixture.service.getSnapshot()).agent).toMatchObject({
      defaultInstructions: DEFAULT_CHAT_AGENT_SYSTEM_PROMPT,
      isDefaultCustomized: false
    })

    fixture.knowledgeStore.close()
    await fixture.sessions.dispose()
  })

  it('cancels an active model run through the Session-scoped controller', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'oyster-chat-cancel-'))
    temporaryPaths.push(rootPath)
    const sessions = new PiChatSessionRepository(join(rootPath, 'sessions'))
    const knowledgeStore = new SqliteKnowledgeStore(join(rootPath, 'knowledge.sqlite'))
    const model = fauxProvider().getModel()
    const runtime: ModelRuntime = {
      model,
      streamFn: (requestedModel, _context, options) => {
        const stream = createAssistantMessageEventStream()
        const abort = (): void => {
          const output: AssistantMessage = {
            role: 'assistant',
            content: [],
            api: requestedModel.api,
            provider: requestedModel.provider,
            model: requestedModel.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
            },
            stopReason: 'aborted',
            errorMessage: 'aborted',
            timestamp: Date.now()
          }
          stream.push({ type: 'error', reason: 'aborted', error: output })
          stream.end(output)
        }
        if (options?.signal?.aborted) abort()
        else options?.signal?.addEventListener('abort', abort, { once: true })
        return stream
      }
    }
    const service = new ChatAgentService({
      sessions,
      configuration: new InMemoryChatConfigurationRepository(),
      aiBackend: new FauxAiBackend(runtime),
      knowledgeStore,
      artifactRepositoryPath: join(rootPath, 'artifacts')
    })
    await service.initialize()
    const session = await service.createSession({
      binding: { connectionId: 'connection:test', modelId: model.id }
    })
    let markRunning: (() => void) | undefined
    const running = new Promise<void>((resolve) => { markRunning = resolve })
    const events: ChatEvent[] = []
    service.subscribe((event) => {
      events.push(event)
      if (event.type === 'run_state_changed' && event.status === 'running') markRunning?.()
    })

    const send = service.sendMessage({ sessionId: session.id, text: 'Wait.' })
    await Promise.race([
      running,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('run did not start')), 500))
    ])
    await service.cancelRun({ sessionId: session.id })
    await expect(Promise.race([
      send,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('run did not cancel')), 500))
    ])).rejects.toThrow('取消')
    expect(events).toContainEqual(expect.objectContaining({
      type: 'run_state_changed',
      status: 'cancelled'
    }))
    knowledgeStore.close()
    await sessions.dispose()
  })
})

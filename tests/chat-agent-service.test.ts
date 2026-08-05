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
          'upsert_knowledge',
          'spawn_agent',
          'add_todos',
          'complete_todos',
          'list_todos'
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
      'upsert_knowledge',
      'spawn_agent',
      'add_todos',
      'complete_todos',
      'list_todos'
    ])
    expect(snapshot.agent.tools[6].parameters).toMatchObject({
      type: 'object',
      properties: { statements: { type: 'array', minItems: 1 } }
    })
    expect(snapshot.agent.tools[7]).toMatchObject({
      name: 'spawn_agent',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['task'],
        properties: { task: { type: 'string', minLength: 1 } }
      }
    })
    fixture.knowledgeStore.close()
    await fixture.sessions.dispose()
  })

  it('delegates to a fresh general Agent context and keeps the child transcript inside the tool result', async () => {
    const delegatedTask = 'Read the exact Project P Statement and report its database.'
    const parentOnlyContext = 'PARENT_ONLY_CONTEXT'
    const expectedTools = [
      'read',
      'bash',
      'edit',
      'write',
      'search_knowledge',
      'read_knowledge',
      'upsert_knowledge',
      'spawn_agent',
      'add_todos',
      'complete_todos',
      'list_todos'
    ]
    const fixture = await serviceFixture(({ artifactRepositoryPath }) => [
      (context) => {
        expect(JSON.stringify(context.messages)).toContain(parentOnlyContext)
        return fauxAssistantMessage(fauxToolCall('spawn_agent', {
          task: delegatedTask
        }), { stopReason: 'toolUse' })
      },
      (context) => {
        expect(context.systemPrompt).toBe(chatAgentSystemPrompt(
          DEFAULT_CHAT_AGENT_SYSTEM_PROMPT,
          artifactRepositoryPath
        ))
        expect(context.tools?.map((tool) => tool.name)).toEqual(expectedTools)
        expect(context.messages).toHaveLength(1)
        expect(JSON.stringify(context.messages)).toContain(delegatedTask)
        expect(JSON.stringify(context.messages)).not.toContain(parentOnlyContext)
        return fauxAssistantMessage(fauxToolCall('read_knowledge', {
          title: 'Project P'
        }), { stopReason: 'toolUse' })
      },
      (context) => {
        expect(context.messages.map((message) => message.role)).toEqual([
          'user',
          'assistant',
          'toolResult'
        ])
        expect(JSON.stringify(context.messages)).toContain('Project P uses SQLite.')
        expect(JSON.stringify(context.messages)).not.toContain(parentOnlyContext)
        return fauxAssistantMessage('Child finding: Project P uses SQLite.')
      },
      (context) => {
        expect(context.messages.map((message) => message.role)).toEqual([
          'user',
          'assistant',
          'toolResult'
        ])
        expect(JSON.stringify(context.messages)).toContain(parentOnlyContext)
        expect(JSON.stringify(context.messages)).toContain('Child finding: Project P uses SQLite.')
        return fauxAssistantMessage('Parent accepted the child result.')
      }
    ])
    fixture.knowledgeStore.commit({
      runRef: 'seed',
      statements: [{ title: 'Project P', content: 'Project P uses SQLite.' }]
    })
    const session = await fixture.service.createSession({
      binding: { connectionId: 'connection:test', modelId: fixture.runtime.model.id }
    })

    const detail = await fixture.service.sendMessage({
      sessionId: session.id,
      text: `Delegate this without sharing ${parentOnlyContext}.`
    })

    expect(fixture.callCount()).toBe(4)
    expect(detail.messages.map((entry) => entry.message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant'
    ])
    const spawnResult = detail.messages
      .map((entry) => entry.message)
      .find((message) => message.role === 'tool' && message.toolName === 'spawn_agent')
    expect(spawnResult).toMatchObject({
      role: 'tool',
      toolName: 'spawn_agent',
      text: 'Child finding: Project P uses SQLite.',
      isError: false,
      details: {
        runId: expect.any(String),
        modelId: fixture.runtime.model.id,
        transcript: expect.any(Array)
      }
    })
    if (!spawnResult || spawnResult.role !== 'tool') throw new Error('spawn_agent result was not persisted')
    const details = spawnResult.details as {
      runId: string
      transcript: Array<{ role: string }>
    }
    expect(details.runId).not.toBe(session.id)
    expect(details.transcript.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'toolResult',
      'assistant'
    ])
    expect(JSON.stringify(details.transcript)).not.toContain(parentOnlyContext)

    fixture.knowledgeStore.close()
    await fixture.sessions.dispose()
  })

  it('returns a child model failure as a recoverable spawn_agent tool error', async () => {
    const fixture = await serviceFixture([
      fauxAssistantMessage(fauxToolCall('spawn_agent', {
        task: 'Investigate independently.'
      }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('', {
        stopReason: 'error',
        errorMessage: 'child model unavailable'
      }),
      (context) => {
        const toolResult = context.messages.at(-1)
        expect(toolResult).toMatchObject({
          role: 'toolResult',
          toolName: 'spawn_agent',
          isError: true
        })
        expect(JSON.stringify(toolResult)).toContain('child model unavailable')
        return fauxAssistantMessage('Parent recovered from the child failure.')
      }
    ])
    const session = await fixture.service.createSession({
      binding: { connectionId: 'connection:test', modelId: fixture.runtime.model.id }
    })

    const detail = await fixture.service.sendMessage({
      sessionId: session.id,
      text: 'Delegate the investigation.'
    })

    expect(fixture.callCount()).toBe(3)
    expect(detail.messages.find((entry) => (
      entry.message.role === 'tool' && entry.message.toolName === 'spawn_agent'
    ))?.message).toMatchObject({
      role: 'tool',
      isError: true,
      text: expect.stringContaining('child model unavailable')
    })
    expect(detail.messages.at(-1)?.message).toMatchObject({
      role: 'assistant',
      text: 'Parent recovered from the child failure.'
    })

    fixture.knowledgeStore.close()
    await fixture.sessions.dispose()
  })

  it('allows a delegated Agent to delegate again without inheriting either parent transcript', async () => {
    const parentTask = 'First-level delegated task.'
    const nestedTask = 'Nested delegated task.'
    const parentOnlyContext = 'TOP_LEVEL_ONLY'
    const fixture = await serviceFixture([
      fauxAssistantMessage(fauxToolCall('spawn_agent', {
        task: parentTask
      }), { stopReason: 'toolUse' }),
      (context) => {
        expect(context.messages).toHaveLength(1)
        expect(JSON.stringify(context.messages)).toContain(parentTask)
        expect(JSON.stringify(context.messages)).not.toContain(parentOnlyContext)
        return fauxAssistantMessage(fauxToolCall('spawn_agent', {
          task: nestedTask
        }), { stopReason: 'toolUse' })
      },
      (context) => {
        expect(context.messages).toHaveLength(1)
        expect(JSON.stringify(context.messages)).toContain(nestedTask)
        expect(JSON.stringify(context.messages)).not.toContain(parentTask)
        expect(JSON.stringify(context.messages)).not.toContain(parentOnlyContext)
        return fauxAssistantMessage('Grandchild result.')
      },
      (context) => {
        expect(JSON.stringify(context.messages)).toContain('Grandchild result.')
        expect(JSON.stringify(context.messages)).not.toContain(parentOnlyContext)
        return fauxAssistantMessage('Child combined the grandchild result.')
      },
      (context) => {
        expect(JSON.stringify(context.messages)).toContain(parentOnlyContext)
        expect(JSON.stringify(context.messages)).toContain('Child combined the grandchild result.')
        return fauxAssistantMessage('Parent completed the task.')
      }
    ])
    const session = await fixture.service.createSession({
      binding: { connectionId: 'connection:test', modelId: fixture.runtime.model.id }
    })

    const detail = await fixture.service.sendMessage({
      sessionId: session.id,
      text: `Delegate recursively while keeping ${parentOnlyContext} private.`
    })

    expect(fixture.callCount()).toBe(5)
    expect(detail.messages.map((entry) => entry.message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant'
    ])
    const spawnResult = detail.messages.find((entry) => (
      entry.message.role === 'tool' && entry.message.toolName === 'spawn_agent'
    ))?.message
    expect(spawnResult).toMatchObject({
      role: 'tool',
      text: 'Child combined the grandchild result.',
      isError: false
    })
    expect(JSON.stringify(spawnResult)).toContain('Grandchild result.')
    expect(JSON.stringify(spawnResult)).not.toContain(parentOnlyContext)

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

  it('propagates Session cancellation into an active child Agent run', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'oyster-chat-cancel-'))
    temporaryPaths.push(rootPath)
    const sessions = new PiChatSessionRepository(join(rootPath, 'sessions'))
    const knowledgeStore = new SqliteKnowledgeStore(join(rootPath, 'knowledge.sqlite'))
    const model = fauxProvider().getModel()
    let modelCalls = 0
    let childSignal: AbortSignal | undefined
    let markChildStarted: (() => void) | undefined
    const childStarted = new Promise<void>((resolve) => { markChildStarted = resolve })
    const runtime: ModelRuntime = {
      model,
      streamFn: (requestedModel, _context, options) => {
        modelCalls++
        const stream = createAssistantMessageEventStream()
        if (modelCalls === 1) {
          stream.end(fauxAssistantMessage(fauxToolCall('spawn_agent', {
            task: 'Wait independently until cancelled.'
          }), { stopReason: 'toolUse' }))
          return stream
        }
        childSignal = options?.signal
        markChildStarted?.()
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
    const events: ChatEvent[] = []
    service.subscribe((event) => {
      events.push(event)
    })

    const send = service.sendMessage({ sessionId: session.id, text: 'Delegate a wait.' })
    await Promise.race([
      childStarted,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('child run did not start')), 500))
    ])
    await service.cancelRun({ sessionId: session.id })
    await expect(Promise.race([
      send,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('run did not cancel')), 500))
    ])).rejects.toThrow('取消')
    expect(childSignal?.aborted).toBe(true)
    expect(events).toContainEqual(expect.objectContaining({
      type: 'run_state_changed',
      status: 'cancelled'
    }))
    knowledgeStore.close()
    await sessions.dispose()
  })
})

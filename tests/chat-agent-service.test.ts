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
import type { AiBackendSnapshot, LlmBinding } from '../src/shared/ai-backends'
import type { SelectedModelStream } from '../src/main/ai-backends/model'
import type { ChatAiBackendPort, ChatConfigurationRepository } from '../src/main/chat/model'
import { ChatAgentService } from '../src/main/chat/chat-agent-service'
import { InMemoryChatConfigurationRepository } from '../src/main/chat/chat-configuration-repository'
import { PiChatConversationRepository } from '../src/main/chat/pi-chat-conversation-repository'
import {
  DEFAULT_CHAT_AGENT_SYSTEM_PROMPT,
  chatAgentSystemPrompt
} from '../src/main/chat/prompt'
import { ARTIFACT_GIT_BINARY_PATH } from '../src/main/artifacts/git-runtime'
import type { ChatEvent } from '../src/shared/chat'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function fauxModelStream(
  responses: FauxResponseStep[]
): { modelStream: SelectedModelStream; callCount: () => number } {
  const faux = fauxProvider()
  faux.setResponses(responses)
  const models = createModels()
  models.setProvider(faux.provider)
  return {
    modelStream: {
      model: faux.getModel(),
      streamFn: (model, context, options) => models.streamSimple(model, context, options)
    },
    callCount: () => faux.state.callCount
  }
}

class FauxAiBackend implements ChatAiBackendPort {
  defaultLlm?: LlmBinding

  constructor(readonly modelStream: SelectedModelStream) {
    this.defaultLlm = { connectionId: 'connection:test', modelId: modelStream.model.id }
  }

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
        models: [
          { id: this.modelStream.model.id, displayName: 'Test Model', reasoningEfforts: [] },
          { id: 'next-default-model', displayName: 'Next Default Model', reasoningEfforts: ['low'] }
        ]
      }],
      ...(this.defaultLlm ? { defaultLlm: this.defaultLlm } : {})
    }
  }

  async withModelStream<T>(
    _connectionId: string,
    _modelId: string,
    operation: (modelStream: SelectedModelStream) => Promise<T>
  ): Promise<T> {
    return operation(this.modelStream)
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
  await Promise.all([mkdir(artifactRepositoryPath), mkdir(join(rootPath, 'knowledge'))])
  const conversations = new PiChatConversationRepository(join(rootPath, 'conversations'))
  const prepared = fauxModelStream(typeof responses === 'function'
    ? responses({ rootPath, artifactRepositoryPath })
    : responses)
  const backend = new FauxAiBackend(prepared.modelStream)
  const service = new ChatAgentService({
    conversations,
    configuration,
    aiBackend: backend,
    repositoryPath: rootPath
  })
  await service.initialize()
  return {
    rootPath,
    artifactRepositoryPath,
    conversations,
    configuration,
    backend,
    service,
    ...prepared
  }
}

describe('ChatAgentService', () => {
  it('captures the current default LLM for each new Conversation without changing existing Conversations', async () => {
    const fixture = await serviceFixture([fauxAssistantMessage('Unused.')])
    const first = await fixture.service.createConversation({})

    fixture.backend.defaultLlm = {
      connectionId: 'connection:test',
      modelId: 'next-default-model',
      reasoningEffort: 'low'
    }
    const second = await fixture.service.createConversation({})

    expect(first.binding).toEqual({
      connectionId: 'connection:test',
      modelId: fixture.modelStream.model.id
    })
    expect(second.binding).toEqual({
      connectionId: 'connection:test',
      modelId: 'next-default-model',
      reasoningEffort: 'low'
    })
    expect((await fixture.service.readConversation(first.id)).binding).toEqual(first.binding)
    await fixture.conversations.dispose()
  })

  it('freezes the configured prompt and exposes one repository through ordinary coding tools', async () => {
    const customPrompt = 'Use local knowledge and reply briefly.'
    const fixture = await serviceFixture(({ rootPath }) => [
      (context) => {
        expect(context.systemPrompt).toContain(chatAgentSystemPrompt(customPrompt, rootPath))
        expect(context.tools?.map((tool) => tool.name)).toEqual([
          'read', 'bash', 'edit', 'write', 'spawn_agent',
          'add_todos', 'complete_todos', 'list_todos'
        ])
        return fauxAssistantMessage('Repository inspected.')
      }
    ])
    const events: ChatEvent[] = []
    fixture.service.subscribe((event) => events.push(event))

    await fixture.service.saveDefaultInstructions({ instructionsOverride: customPrompt })
    const conversation = await fixture.service.createConversation({})
    await fixture.service.saveDefaultInstructions({ instructionsOverride: null })
    expect((await fixture.conversations.open(conversation.id)).binding.systemPrompt).toBe(customPrompt)

    const detail = await fixture.service.sendMessage({
      conversationId: conversation.id,
      text: 'Please inspect the repository.'
    })
    expect(fixture.callCount()).toBe(1)
    expect(detail.title).toBe('Please inspect the repository.')
    expect(detail.messages.map((entry) => entry.message.role)).toEqual(['user', 'assistant'])
    expect(detail.invocations).toHaveLength(1)
    expect(detail.invocations[0].modelCalls).toHaveLength(1)
    expect(detail.invocations[0].toolCalls).toEqual([])
    expect(events).toContainEqual(expect.objectContaining({
      type: 'invocation_state_changed',
      conversationId: conversation.id,
      status: 'completed'
    }))
    expect(events).toContainEqual(expect.objectContaining({
      type: 'invocation_updated',
      conversationId: conversation.id,
      invocation: expect.objectContaining({ status: 'completed' })
    }))
    const snapshot = await fixture.service.getState()
    expect(snapshot.agent).toMatchObject({
      builtInInstructions: DEFAULT_CHAT_AGENT_SYSTEM_PROMPT,
      defaultInstructions: DEFAULT_CHAT_AGENT_SYSTEM_PROMPT,
      isDefaultCustomized: false
    })
    expect(snapshot.agent.tools.map((tool) => tool.name)).toEqual([
      'read', 'bash', 'edit', 'write', 'spawn_agent',
      'add_todos', 'complete_todos', 'list_todos'
    ])
    expect(snapshot.agent.tools[4]).toMatchObject({
      name: 'spawn_agent',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['instruction'],
        properties: { instruction: { type: 'string', minLength: 1 } }
      }
    })
    await fixture.conversations.dispose()
  })

  it('delegates to a fresh persistent Pi Session without copying its transcript into the tool result', async () => {
    const delegatedTask = 'Read the exact Project P Statement and report its database.'
    const parentOnlyContext = 'PARENT_ONLY_CONTEXT'
    const expectedTools = [
      'read',
      'bash',
      'edit',
      'write',
      'spawn_agent',
      'add_todos',
      'complete_todos',
      'list_todos'
    ]
    const fixture = await serviceFixture(({ rootPath }) => [
      (context) => {
        expect(JSON.stringify(context.messages)).toContain(parentOnlyContext)
        return fauxAssistantMessage(fauxToolCall('spawn_agent', {
          instruction: delegatedTask
        }), { stopReason: 'toolUse' })
      },
      (context) => {
        expect(context.systemPrompt).toContain(chatAgentSystemPrompt(
          DEFAULT_CHAT_AGENT_SYSTEM_PROMPT,
          rootPath
        ))
        expect(context.tools?.map((tool) => tool.name)).toEqual(expectedTools)
        expect(context.messages).toHaveLength(1)
        expect(JSON.stringify(context.messages)).toContain(delegatedTask)
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
    const conversation = await fixture.service.createConversation({})

    const detail = await fixture.service.sendMessage({
      conversationId: conversation.id,
      text: `Delegate this without sharing ${parentOnlyContext}.`
    })

    expect(fixture.callCount()).toBe(3)
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
        invocationId: expect.any(String),
        modelId: fixture.modelStream.model.id,
        sessionId: expect.any(String)
      }
    })
    if (!spawnResult || spawnResult.role !== 'tool') throw new Error('spawn_agent result was not persisted')
    const details = spawnResult.details as {
      invocationId: string
      sessionId: string
    }
    expect(details.invocationId).not.toBe(conversation.id)
    expect(details.sessionId).toBe(details.invocationId)
    expect(JSON.stringify(details)).not.toContain(parentOnlyContext)
    expect(detail.invocations).toHaveLength(2)
    const rootInvocation = detail.invocations.find((invocation) => invocation.parentInvocationId === undefined)
    const childInvocation = detail.invocations.find((invocation) => invocation.id === details.invocationId)
    expect(rootInvocation).toMatchObject({
      formatVersion: 3,
      agentId: 'chat_agent',
      status: 'completed'
    })
    expect(childInvocation).toMatchObject({
      formatVersion: 3,
      agentId: 'chat_agent',
      parentInvocationId: rootInvocation?.id,
      status: 'completed'
    })

    await fixture.conversations.dispose()
  })

  it('returns a child model failure as a recoverable spawn_agent tool error', async () => {
    const fixture = await serviceFixture([
      fauxAssistantMessage(fauxToolCall('spawn_agent', {
        instruction: 'Investigate independently.'
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
    const conversation = await fixture.service.createConversation({})

    const detail = await fixture.service.sendMessage({
      conversationId: conversation.id,
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
    const rootInvocation = detail.invocations.find((invocation) => invocation.parentInvocationId === undefined)
    const childInvocation = detail.invocations.find((invocation) => invocation.parentInvocationId === rootInvocation?.id)
    expect(rootInvocation).toMatchObject({ agentId: 'chat_agent', status: 'completed' })
    expect(childInvocation).toMatchObject({
      agentId: 'chat_agent',
      status: 'failed',
      error: expect.stringContaining('child model unavailable')
    })

    await fixture.conversations.dispose()
  })

  it('allows a delegated Agent to delegate again without inheriting either parent transcript', async () => {
    const parentTask = 'First-level delegated task.'
    const nestedTask = 'Nested delegated task.'
    const parentOnlyContext = 'TOP_LEVEL_ONLY'
    const fixture = await serviceFixture([
      fauxAssistantMessage(fauxToolCall('spawn_agent', {
        instruction: parentTask
      }), { stopReason: 'toolUse' }),
      (context) => {
        expect(context.messages).toHaveLength(1)
        expect(JSON.stringify(context.messages)).toContain(parentTask)
        expect(JSON.stringify(context.messages)).not.toContain(parentOnlyContext)
        return fauxAssistantMessage(fauxToolCall('spawn_agent', {
          instruction: nestedTask
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
    const conversation = await fixture.service.createConversation({})

    const detail = await fixture.service.sendMessage({
      conversationId: conversation.id,
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
    expect(JSON.stringify(spawnResult)).not.toContain('Grandchild result.')
    expect(spawnResult).toMatchObject({
      details: { sessionId: expect.any(String) }
    })
    expect(JSON.stringify(spawnResult)).not.toContain(parentOnlyContext)

    await fixture.conversations.dispose()
  })

  it('starts unrestricted coding tools in the one Oyster Repository', async () => {
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
    const conversation = await fixture.service.createConversation({})

    const detail = await fixture.service.sendMessage({
      conversationId: conversation.id,
      text: 'Exercise the filesystem tools.'
    })

    expect(await readFile(
      join(fixture.rootPath, relativeRepositoryPath),
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
      text: expect.stringContaining(fixture.rootPath)
    })
    expect(toolMessages[4]).toMatchObject({
      text: expect.stringContaining(ARTIFACT_GIT_BINARY_PATH)
    })
    const latestInvocationEvent = events
      .filter((event): event is Extract<ChatEvent, { type: 'invocation_updated' }> => (
        event.type === 'invocation_updated'
      ))
      .at(-1)
    const expectedToolCalls = [
      ['write', 'completed', false],
      ['edit', 'completed', false],
      ['read', 'completed', false],
      ['write', 'completed', false],
      ['bash', 'completed', false]
    ]
    expect(latestInvocationEvent?.invocation.status).toBe('completed')
    expect(latestInvocationEvent?.invocation.toolCalls.map((call) => [
      call.name,
      call.status,
      call.isError
    ])).toEqual(expectedToolCalls)
    expect(detail.invocations.at(-1)?.toolCalls.map((call) => [
      call.name,
      call.status,
      call.isError
    ])).toEqual(expectedToolCalls)

    fixture.service.dispose()
    await fixture.conversations.dispose()
  })

  it('does not impose a model-call or tool-call quota', async () => {
    const toolCalls = Array.from({ length: 12 }, () => fauxAssistantMessage(
      fauxToolCall('list_todos', {}),
      { stopReason: 'toolUse' }
    ))
    const fixture = await serviceFixture([...toolCalls, fauxAssistantMessage('Finished.')])
    const conversation = await fixture.service.createConversation({})
    const detail = await fixture.service.sendMessage({ conversationId: conversation.id, text: 'Search widely.' })

    expect(fixture.callCount()).toBe(13)
    expect(detail.messages.filter((entry) => (
      entry.message.role === 'tool' && entry.message.toolName === 'list_todos'
    ))).toHaveLength(12)
    await fixture.conversations.dispose()
  })

  it('requires a valid default LLM without requiring a prior connection test', async () => {
    const fixture = await serviceFixture([fauxAssistantMessage('Unused.')])
    fixture.backend.defaultLlm = undefined
    await expect(fixture.service.createConversation({})).rejects.toThrow('配置默认 LLM')
    fixture.backend.defaultLlm = { connectionId: 'missing', modelId: fixture.modelStream.model.id }
    await expect(fixture.service.createConversation({})).rejects.toThrow('不存在')
    fixture.backend.defaultLlm = { connectionId: 'connection:test', modelId: 'missing' }
    await expect(fixture.service.createConversation({})).rejects.toThrow('不可用')
    await fixture.conversations.dispose()
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
    expect((await fixture.service.getState()).agent).toMatchObject({
      defaultInstructions: DEFAULT_CHAT_AGENT_SYSTEM_PROMPT,
      isDefaultCustomized: false
    })

    await fixture.conversations.dispose()
  })

  it('propagates Conversation cancellation into an active child Agent invocation', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'oyster-chat-cancel-'))
    temporaryPaths.push(rootPath)
    const conversations = new PiChatConversationRepository(join(rootPath, 'conversations'))
    const model = fauxProvider().getModel()
    let modelCalls = 0
    let childSignal: AbortSignal | undefined
    let markChildStarted: (() => void) | undefined
    const childStarted = new Promise<void>((resolve) => { markChildStarted = resolve })
    const modelStream: SelectedModelStream = {
      model,
      streamFn: (requestedModel, _context, options) => {
        modelCalls++
        const stream = createAssistantMessageEventStream()
        if (modelCalls === 1) {
          stream.end(fauxAssistantMessage(fauxToolCall('spawn_agent', {
            instruction: 'Wait independently until cancelled.'
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
      conversations,
      configuration: new InMemoryChatConfigurationRepository(),
      aiBackend: new FauxAiBackend(modelStream),
      repositoryPath: rootPath
    })
    await service.initialize()
    const conversation = await service.createConversation({})
    const events: ChatEvent[] = []
    service.subscribe((event) => {
      events.push(event)
    })

    const send = service.sendMessage({ conversationId: conversation.id, text: 'Delegate a wait.' })
    await Promise.race([
      childStarted,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('child invocation did not start')), 500))
    ])
    await service.cancelInvocation({ conversationId: conversation.id })
    await expect(Promise.race([
      send,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('invocation did not cancel')), 500))
    ])).rejects.toThrow('取消')
    expect(childSignal?.aborted).toBe(true)
    expect(events).toContainEqual(expect.objectContaining({
      type: 'invocation_state_changed',
      status: 'cancelled'
    }))
    await conversations.dispose()
  })
})

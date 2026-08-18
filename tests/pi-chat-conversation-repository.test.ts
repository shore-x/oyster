import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from '@earendil-works/pi-ai'
import {
  appendChatAgentInvocation,
  PiChatConversationRepository
} from '../src/main/chat/pi-chat-conversation-repository'
import { completedAgentInvocation } from './agent-invocation-fixture'

const temporaryPaths: string[] = []

async function temporaryPath(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'oyster-chat-conversations-'))
  temporaryPaths.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('PiChatConversationRepository', () => {
  it('persists immutable binding and complete Pi tool messages in a separate JSONL session', async () => {
    const rootPath = await temporaryPath()
    const repository = new PiChatConversationRepository(rootPath)
    const opened = await repository.create({
      connectionId: 'connection:one',
      modelId: 'model-small',
      reasoningEffort: 'low',
      systemPrompt: 'Use the Knowledge Store.'
    }, 'Knowledge chat')
    const metadata = { id: opened.conversationId }

    await opened.piSessionManager.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'Save Project P.' }],
      timestamp: 1
    })
    await opened.piSessionManager.appendMessage(fauxAssistantMessage(
      fauxToolCall('upsert_knowledge', {
        statements: [{ title: 'Project P', content: 'A local project.' }]
      }),
      { stopReason: 'toolUse', timestamp: 2 }
    ))
    const toolResult: ToolResultMessage = {
      role: 'toolResult',
      toolCallId: 'tool-1',
      toolName: 'upsert_knowledge',
      content: [{ type: 'text', text: 'Committed Project P.' }],
      details: { createdTitles: ['Project P'] },
      isError: false,
      timestamp: 3
    }
    await opened.piSessionManager.appendMessage(toolResult)

    const detail = await repository.detail(metadata.id)
    expect(detail).toMatchObject({
      title: 'Knowledge chat',
      messageCount: 3,
      binding: {
        connectionId: 'connection:one',
        modelId: 'model-small',
        reasoningEffort: 'low'
      }
    })
    expect(detail.binding).toEqual({
      connectionId: 'connection:one',
      modelId: 'model-small',
      reasoningEffort: 'low'
    })
    expect((await repository.open(metadata.id)).binding.systemPrompt).toBe('Use the Knowledge Store.')
    expect(detail.messages[1].message).toMatchObject({
      role: 'assistant',
      toolCalls: [{ name: 'upsert_knowledge' }]
    })
    expect(detail.messages[2].message).toMatchObject({
      role: 'tool',
      toolName: 'upsert_knowledge',
      details: { createdTitles: ['Project P'] }
    })

    const reopened = new PiChatConversationRepository(rootPath)
    await expect(reopened.detail(metadata.id)).resolves.toEqual(detail)
    const sessionFiles = (await readdir(rootPath, { recursive: true }))
      .filter((path) => path.endsWith('.jsonl'))
    expect(sessionFiles).toHaveLength(1)
    const raw = await readFile(join(rootPath, sessionFiles[0]), 'utf8')
    expect(raw).toContain('"role":"assistant"')
    expect(raw).toContain('"role":"toolResult"')
    expect(raw).toContain('"createdTitles":["Project P"]')

    await repository.dispose()
    await reopened.dispose()
  })

  it('persists only terminal, supported Agent Invocation records through the shared validator', async () => {
    const rootPath = await temporaryPath()
    const repository = new PiChatConversationRepository(rootPath)
    const opened = await repository.create({
      connectionId: 'connection:one',
      modelId: 'model-small',
      systemPrompt: 'Use the Knowledge Store.'
    })
    const metadata = { id: opened.conversationId }

    const inProgress = completedAgentInvocation('chat-in-progress', [], 1, 'chat_agent')
    inProgress.status = 'in_progress'
    delete inProgress.completedAt
    delete inProgress.durationMs
    await expect(appendChatAgentInvocation(opened.piSessionManager, inProgress)).rejects.toThrow('尚未终态化')

    const unknownVersion = completedAgentInvocation('chat-unknown', [], 1, 'chat_agent')
    unknownVersion.formatVersion = 99 as 4
    await expect(appendChatAgentInvocation(opened.piSessionManager, unknownVersion)).rejects.toThrow('格式版本无效')

    const completed = completedAgentInvocation('chat-completed', [], 1, 'chat_agent')
    await repository.appendInvocation(metadata.id, completed)
    expect((await repository.detail(metadata.id)).invocations).toEqual([completed])
    await expect(repository.referencedDebugRecordIds()).resolves.toEqual(
      new Set([completed.debugRecordId])
    )

    await repository.dispose()
  })

  it('reads and rewrites legacy descriptors with an unprefixed id', async () => {
    const rootPath = await temporaryPath()
    const repository = new PiChatConversationRepository(rootPath)
    const opened = await repository.create({
      connectionId: 'connection:one',
      modelId: 'model-small',
      systemPrompt: 'Use the Knowledge Store.'
    })
    const file = join(rootPath, `${encodeURIComponent(opened.conversationId)}.conversation.json`)
    const current = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    const legacy: Record<string, unknown> = {
      ...current,
      formatVersion: 1,
      id: opened.conversationId
    }
    delete legacy.conversationId
    await writeFile(file, `${JSON.stringify(legacy)}\n`, 'utf8')

    const reopened = new PiChatConversationRepository(rootPath)
    await expect(reopened.open(opened.conversationId)).resolves.toMatchObject({
      conversationId: opened.conversationId
    })
    const migrated = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    expect(migrated).toMatchObject({ formatVersion: 2, conversationId: opened.conversationId })
    expect(migrated).not.toHaveProperty('id')
    await repository.dispose()
    await reopened.dispose()
  })
})

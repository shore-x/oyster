import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from '@earendil-works/pi-ai'
import { PiChatSessionRepository } from '../src/main/chat/pi-chat-session-repository'

const temporaryPaths: string[] = []

async function temporaryPath(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'oyster-chat-sessions-'))
  temporaryPaths.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('PiChatSessionRepository', () => {
  it('persists immutable binding and complete Pi tool messages in a separate JSONL session', async () => {
    const rootPath = await temporaryPath()
    const repository = new PiChatSessionRepository(rootPath)
    const opened = await repository.create({
      connectionId: 'connection:one',
      modelId: 'model-small',
      reasoningEffort: 'low',
      systemPrompt: 'Use the Knowledge Store.'
    }, 'Knowledge chat')
    const metadata = await opened.session.getMetadata()

    await opened.session.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'Save Project P.' }],
      timestamp: 1
    })
    await opened.session.appendMessage(fauxAssistantMessage(
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
    await opened.session.appendMessage(toolResult)

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

    const reopened = new PiChatSessionRepository(rootPath)
    await expect(reopened.detail(metadata.id)).resolves.toEqual(detail)
    const sessionFiles = (await readdir(rootPath, { recursive: true }))
      .filter((path) => path.endsWith('.jsonl'))
    expect(sessionFiles).toHaveLength(1)
    const raw = await readFile(join(rootPath, sessionFiles[0]), 'utf8')
    expect(raw).toContain('"role":"assistant"')
    expect(raw).toContain('"role":"toolResult"')
    expect(raw).toContain('"createdTitles":["Project P"]')

    await reopened.delete(metadata.id)
    await expect(reopened.open(metadata.id)).rejects.toThrow('不存在')
    await repository.dispose()
    await reopened.dispose()
  })
})

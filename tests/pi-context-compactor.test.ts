import { describe, expect, it } from 'vitest'
import type { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core'
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxProvider,
  type AssistantMessage,
  type Context
} from '@earendil-works/pi-ai'
import {
  createPiContextCompactor,
  type PiContextCompactionEvent
} from '../src/main/agent-runtime/pi-context-compactor'

function completedStream(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream()
  stream.end(message)
  return stream
}

function userMessage(text: string): AgentMessage {
  return { role: 'user', content: text, timestamp: Date.now() }
}

describe('Pi context compactor', () => {
  it('leaves a small transcript untouched without another model call', async () => {
    const model = { ...fauxProvider().getModel(), contextWindow: 8_000, maxTokens: 512 }
    let calls = 0
    const transform = createPiContextCompactor({
      model,
      streamFn: (() => {
        calls++
        return completedStream(fauxAssistantMessage('unused'))
      }) as StreamFn,
      systemPrompt: 'Use the available tools.'
    })
    const messages = [userMessage('A short task.')]

    await expect(transform(messages)).resolves.toBe(messages)
    expect(calls).toBe(0)
  })

  it('iteratively summarizes an oversized transcript and keeps the full Agent state external', async () => {
    const model = { ...fauxProvider().getModel(), contextWindow: 3_000, maxTokens: 512 }
    const contexts: Context[] = []
    const events: PiContextCompactionEvent[] = []
    const transform = createPiContextCompactor({
      model,
      streamFn: ((_model, context) => {
        contexts.push(context)
        return completedStream(fauxAssistantMessage(`checkpoint ${contexts.length}`))
      }) as StreamFn,
      systemPrompt: 'Continue the task.',
      onModelCall: (event) => events.push(event)
    })
    const messages = [userMessage(`important evidence location L000001:C0 ${'x'.repeat(10_000)}`)]

    const compacted = await transform(messages)

    expect(contexts.length).toBeGreaterThan(1)
    expect(contexts[0]?.systemPrompt).toContain('task-specific distinctions')
    expect(contexts.at(-1)?.messages[0]?.role).toBe('user')
    expect(JSON.stringify(contexts.at(-1))).toContain('<previous-summary>')
    expect(compacted).toHaveLength(1)
    expect(compacted[0].role).toBe('user')
    expect(JSON.stringify(compacted[0])).toContain('<context-summary>')
    expect(JSON.stringify(compacted[0])).toContain(`checkpoint ${contexts.length}`)
    expect(messages[0]).toEqual(expect.objectContaining({ role: 'user' }))
    expect(events.filter((event) => event.type === 'started')).toHaveLength(contexts.length)
    expect(events.filter((event) => event.type === 'completed')).toHaveLength(contexts.length)

    const callsAfterCompaction = contexts.length
    await expect(transform(messages)).resolves.toEqual(compacted)
    expect(contexts).toHaveLength(callsAfterCompaction)
  })

  it('rejects instead of forwarding a known oversized transcript when summarization fails', async () => {
    const model = { ...fauxProvider().getModel(), contextWindow: 3_000, maxTokens: 512 }
    const events: PiContextCompactionEvent[] = []
    const transform = createPiContextCompactor({
      model,
      streamFn: (() => completedStream(fauxAssistantMessage('', {
        stopReason: 'error',
        errorMessage: 'summary unavailable'
      }))) as StreamFn,
      systemPrompt: 'Continue the task.',
      onModelCall: (event) => events.push(event)
    })
    const messages = [userMessage('x'.repeat(10_000))]

    await expect(transform(messages)).rejects.toThrow('summary unavailable')
    expect(events.map((event) => event.type)).toEqual(['started', 'failed'])
  })

  it('rejects a summary truncated by its output limit', async () => {
    const model = { ...fauxProvider().getModel(), contextWindow: 3_000, maxTokens: 512 }
    const events: PiContextCompactionEvent[] = []
    const transform = createPiContextCompactor({
      model,
      streamFn: (() => completedStream(fauxAssistantMessage('partial summary', {
        stopReason: 'length'
      }))) as StreamFn,
      systemPrompt: 'Continue the task.',
      onModelCall: (event) => events.push(event)
    })

    await expect(transform([userMessage('x'.repeat(10_000))])).rejects.toThrow(
      'incomplete summary (stop reason: length)'
    )
    expect(events.map((event) => event.type)).toEqual(['started', 'failed'])
  })

  it('reserves the normal model output allowance when deciding whether to compact', async () => {
    const model = { ...fauxProvider().getModel(), contextWindow: 8_000, maxTokens: 4_000 }
    let calls = 0
    const transform = createPiContextCompactor({
      model,
      streamFn: (() => {
        calls++
        return completedStream(fauxAssistantMessage('compact checkpoint'))
      }) as StreamFn,
      systemPrompt: 'Continue the task.'
    })

    const compacted = await transform([userMessage('x'.repeat(14_000))])

    expect(calls).toBeGreaterThan(0)
    expect(JSON.stringify(compacted)).toContain('<context-summary>')
  })

  it('reserves room for fresh external context appended after compaction', async () => {
    const model = { ...fauxProvider().getModel(), contextWindow: 8_000, maxTokens: 512 }
    let calls = 0
    const transform = createPiContextCompactor({
      model,
      streamFn: (() => {
        calls++
        return completedStream(fauxAssistantMessage('compact checkpoint'))
      }) as StreamFn,
      systemPrompt: 'Continue the task.',
      reservedContextTokens: 3_000
    })

    const compacted = await transform([userMessage('x'.repeat(18_000))])

    expect(calls).toBeGreaterThan(0)
    expect(JSON.stringify(compacted)).toContain('<context-summary>')
  })

  it('fails locally when fixed Agent context cannot fit the declared window', () => {
    const model = { ...fauxProvider().getModel(), contextWindow: 3_000, maxTokens: 512 }
    let calls = 0

    expect(() => createPiContextCompactor({
      model,
      streamFn: (() => {
        calls++
        return completedStream(fauxAssistantMessage('unused'))
      }) as StreamFn,
      systemPrompt: 'x'.repeat(8_000)
    })).toThrow(/fixed system prompt and tool context.*declared 3000-token context window/)
    expect(calls).toBe(0)
  })

  it('propagates cancellation without invoking the compaction model', async () => {
    const model = { ...fauxProvider().getModel(), contextWindow: 3_000, maxTokens: 512 }
    let calls = 0
    const transform = createPiContextCompactor({
      model,
      streamFn: (() => {
        calls++
        return completedStream(fauxAssistantMessage('unused'))
      }) as StreamFn,
      systemPrompt: 'Continue the task.'
    })
    const controller = new AbortController()
    controller.abort()

    await expect(transform([userMessage('x'.repeat(10_000))], controller.signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(calls).toBe(0)
  })

  it('rejects a compacted result that still exceeds the normal input budget', async () => {
    const model = { ...fauxProvider().getModel(), contextWindow: 8_000, maxTokens: 4_000 }
    const transform = createPiContextCompactor({
      model,
      streamFn: (() => completedStream(fauxAssistantMessage('s'.repeat(20_000)))) as StreamFn,
      systemPrompt: 'Continue the task.'
    })

    await expect(transform([userMessage('x'.repeat(14_000))])).rejects.toThrow(
      /compacted Agent context still requires.*only .* are available/
    )
  })
})

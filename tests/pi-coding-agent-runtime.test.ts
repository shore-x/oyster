import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxProvider,
  type AssistantMessage
} from '@earendil-works/pi-ai'
import type { SelectedModelStream } from '../src/main/ai-backends/model'
import { InMemoryAgentDebugStore } from '../src/main/agent-runtime/agent-debug-store'
import {
  createPiCodingAgentInvocation,
  promptPiCodingAgent,
  SessionManager
} from '../src/main/agent-runtime/pi-coding-agent-runtime'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(
    (path) => rm(path, { recursive: true, force: true })
  ))
})

async function retryInvocation(
  invocationId: string,
  response: (call: number) => AssistantMessage,
  options: {
    resourceMode?: 'ecosystem' | 'disabled'
    settings?: object
  } = {}
) {
  const rootPath = await mkdtemp(join(tmpdir(), 'oyster-pi-retry-'))
  temporaryPaths.push(rootPath)
  const agentDir = join(rootPath, 'agent')
  if (options.settings) {
    await mkdir(agentDir, { recursive: true })
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify(options.settings))
  }
  const model = fauxProvider().getModel()
  let calls = 0
  const modelStream: SelectedModelStream = {
    model,
    streamFn: () => {
      calls++
      const stream = createAssistantMessageEventStream()
      stream.end(response(calls))
      return stream
    }
  }
  const invocation = await createPiCodingAgentInvocation({
    agentId: 'retry_test_agent',
    invocationId,
    debugStore: new InMemoryAgentDebugStore(),
    modelStream,
    cwd: rootPath,
    agentDir,
    systemPrompt: 'Test bounded transient-error retries.',
    piSessionManager: SessionManager.create(rootPath, join(rootPath, 'sessions'), {
      id: invocationId
    }),
    resourceMode: options.resourceMode ?? 'disabled',
    tools: [],
    todoTools: false
  })
  return { invocation, calls: () => calls }
}

describe('Pi Coding Agent runtime retry', () => {
  it('recovers from a transient overload through the bounded Agent Turn policy', async () => {
    const { invocation, calls } = await retryInvocation(
      'retry-success',
      (call) => (
        call === 1
          ? fauxAssistantMessage('', {
              stopReason: 'error',
              errorMessage: 'OpenAI service overloaded (503)'
            })
          : fauxAssistantMessage('Recovered after retry.')
      ),
      {
        resourceMode: 'ecosystem',
        settings: {
          retry: {
            enabled: false,
            maxRetries: 99,
            baseDelayMs: 99_000,
            provider: { maxRetries: 99 }
          }
        }
      }
    )
    const retryStarts: Array<{ attempt: number, maxAttempts: number, delayMs: number }> = []
    const unsubscribe = invocation.session.subscribe((event) => {
      if (event.type === 'auto_retry_start') {
        retryStarts.push({
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs
        })
      }
    })

    try {
      expect(invocation.session.settingsManager.getRetrySettings()).toEqual({
        enabled: true,
        maxRetries: 3,
        baseDelayMs: 2_000
      })
      expect(invocation.session.settingsManager.getProviderRetrySettings().maxRetries).toBe(0)
      invocation.session.settingsManager.applyOverrides({ retry: { baseDelayMs: 1 } })

      await promptPiCodingAgent(
        invocation,
        'Retry a transient overload.',
        new AbortController().signal,
        'Test'
      )

      expect(calls()).toBe(2)
      expect(retryStarts).toEqual([{ attempt: 1, maxAttempts: 3, delayMs: 1 }])
    } finally {
      unsubscribe()
      invocation.dispose()
    }
  })

  it('stops after three retries when the overload persists', async () => {
    const { invocation, calls } = await retryInvocation('retry-exhausted', () => (
      fauxAssistantMessage('', {
        stopReason: 'error',
        errorMessage: 'OpenAI service overloaded (503)'
      })
    ))
    const retryAttempts: number[] = []
    const unsubscribe = invocation.session.subscribe((event) => {
      if (event.type === 'auto_retry_start') retryAttempts.push(event.attempt)
    })

    try {
      invocation.session.settingsManager.applyOverrides({ retry: { baseDelayMs: 1 } })

      await expect(promptPiCodingAgent(
        invocation,
        'Exhaust the retry budget.',
        new AbortController().signal,
        'Test'
      )).rejects.toThrow('OpenAI service overloaded (503)')

      expect(calls()).toBe(4)
      expect(retryAttempts).toEqual([1, 2, 3])
    } finally {
      unsubscribe()
      invocation.dispose()
    }
  })
})

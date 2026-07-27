import { describe, expect, it } from 'vitest'
import {
  ClaudeHistoryAdapter,
  CodexHistoryAdapter,
  PiHistoryAdapter
} from '../src/main/discovery/adapters'
import type { AgentType } from '../src/shared/discovery'

function inspect(agentType: AgentType, lines: Array<string | Record<string, unknown>>) {
  const inspector = {
    claude: new ClaudeHistoryAdapter(),
    pi: new PiHistoryAdapter(),
    codex: new CodexHistoryAdapter()
  }[agentType].createSessionInspector()
  for (const line of lines) {
    inspector.visitLine(typeof line === 'string' ? line : JSON.stringify(line))
  }
  return inspector.result()
}

describe('SessionInspector', () => {
  it('counts Claude user and assistant messages and derives their time range', () => {
    expect(inspect('claude', [
      { sessionId: 'claude-one', timestamp: '2026-07-01T00:00:00.000Z' },
      { type: 'user', timestamp: '2026-07-01T00:03:00.000Z', message: { role: 'user' } },
      '{malformed',
      { type: 'tool_result', timestamp: '2026-07-01T00:04:00.000Z' },
      { type: 'assistant', timestamp: '2026-07-01T00:01:00.000Z', message: { role: 'assistant' } },
      { type: 'progress', timestamp: '2026-07-01T00:05:00.000Z' }
    ])).toEqual({
      messageCount: 2,
      startedAt: '2026-07-01T00:01:00.000Z',
      endedAt: '2026-07-01T00:03:00.000Z'
    })
  })

  it('counts Pi message records while ignoring malformed, tool, and control records', () => {
    expect(inspect('pi', [
      { type: 'session', id: 'pi-one', timestamp: '2026-07-02T00:00:00.000Z' },
      { type: 'message', timestamp: '2026-07-02T00:02:00.000Z', message: { role: 'user' } },
      { type: 'message', timestamp: '2026-07-02T00:03:00.000Z', role: 'tool' },
      '{malformed',
      { type: 'tool_result', timestamp: '2026-07-02T00:04:00.000Z', role: 'assistant' },
      { type: 'message', createdAt: '2026-07-02T00:05:00.000Z', role: 'assistant' }
    ])).toEqual({
      messageCount: 2,
      startedAt: '2026-07-02T00:02:00.000Z',
      endedAt: '2026-07-02T00:05:00.000Z'
    })
  })

  it('counts canonical Codex message items without double-counting events or tool calls', () => {
    expect(inspect('codex', [
      { type: 'session_meta', timestamp: '2026-07-03T00:00:00.000Z', payload: { id: 'codex-one' } },
      {
        type: 'response_item',
        timestamp: '2026-07-03T00:04:00.000Z',
        payload: { type: 'message', role: 'assistant' }
      },
      {
        type: 'response_item',
        timestamp: '2026-07-03T00:05:00.000Z',
        payload: { type: 'function_call', role: 'assistant' }
      },
      { type: 'event_msg', timestamp: '2026-07-03T00:03:00.000Z', payload: { type: 'user_message' } },
      '{malformed',
      {
        type: 'response_item',
        payload: { type: 'message', role: 'user', timestamp: '2026-07-03T00:02:00.000Z' }
      }
    ])).toEqual({
      messageCount: 2,
      startedAt: '2026-07-03T00:02:00.000Z',
      endedAt: '2026-07-03T00:04:00.000Z'
    })
  })
})

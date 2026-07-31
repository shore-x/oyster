import { describe, expect, it } from 'vitest'
import { renderToString } from 'solid-js/web'
import type { AvailableSessionSummary } from '../src/shared/discovery'
import {
  SessionMetadata,
  sessionOptionLabel
} from '../src/renderer/src/components/SessionMetadata'

function session(overrides: Partial<AvailableSessionSummary> = {}): AvailableSessionSummary {
  return {
    sourceRecordId: 'source-record-1',
    sourceId: 'source:codex',
    agentType: 'codex',
    sourceDisplayName: 'Codex',
    externalId: 'session-1',
    title: 'Session one',
    projectPath: '/workspace/oyster',
    startedAt: '2026-07-28T08:00:00.000Z',
    sizeBytes: 2_048,
    revision: 'a'.repeat(64),
    ...overrides
  }
}

describe('sessionOptionLabel', () => {
  it('uses stable file metadata before the selected Session has been inspected', () => {
    const label = sessionOptionLabel(session())

    expect(label).toContain('Session one')
    expect(label).toContain('oyster')
    expect(label).toContain('2.0 KB 原始记录')
    expect(label).not.toContain('未读取')
  })

  it('uses readable units for a very large Session without inspecting its content', () => {
    const label = sessionOptionLabel(session({ sizeBytes: 1.5 * 1_024 * 1_024 * 1_024 }))

    expect(label).toContain('1.5 GB 原始记录')
    expect(label).not.toContain('消息')
  })

  it('shows source size instead of an unread message-count state in Session details', () => {
    const html = renderToString(() => SessionMetadata({
      session: session(),
      class: 'session-summary',
      testId: 'session-summary'
    }))

    expect(html).toContain('原始记录大小')
    expect(html).toContain('2.0 KB')
    expect(html).not.toContain('消息条数')
    expect(html).not.toContain('未读取')
  })
})

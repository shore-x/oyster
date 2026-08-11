import { describe, expect, it } from 'vitest'
import { renderToString } from 'solid-js/web'
import type { SourceConversationSummary } from '../src/shared/discovery'
import {
  SourceConversationMetadata,
  sourceConversationOptionLabel
} from '../src/renderer/src/components/SourceConversationMetadata'

function sourceConversation(
  overrides: Partial<SourceConversationSummary> = {}
): SourceConversationSummary {
  return {
    sourceConversationId: 'source-record-1',
    sourceId: 'source:codex',
    agentType: 'codex',
    sourceDisplayName: 'Codex',
    providerConversationId: 'conversation-1',
    title: 'Conversation one',
    projectPath: '/workspace/oyster',
    startedAt: '2026-07-28T08:00:00.000Z',
    sizeBytes: 2_048,
    sourceRevision: 'a'.repeat(64),
    ...overrides
  }
}

describe('sourceConversationOptionLabel', () => {
  it('uses stable file metadata before the selected Source Conversation has been inspected', () => {
    const label = sourceConversationOptionLabel(sourceConversation())

    expect(label).toContain('Conversation one')
    expect(label).toContain('oyster')
    expect(label).toContain('2.0 KB 原始记录')
    expect(label).not.toContain('未读取')
  })

  it('uses readable units for a very large Source Conversation without inspecting its content', () => {
    const label = sourceConversationOptionLabel(sourceConversation({
      sizeBytes: 1.5 * 1_024 * 1_024 * 1_024
    }))

    expect(label).toContain('1.5 GB 原始记录')
    expect(label).not.toContain('消息')
  })

  it('shows source size instead of an unread message-count state in conversation details', () => {
    const html = renderToString(() => SourceConversationMetadata({
      conversation: sourceConversation(),
      class: 'source-conversation-summary',
      testId: 'source-conversation-summary'
    }))

    expect(html).toContain('原始记录大小')
    expect(html).toContain('2.0 KB')
    expect(html).not.toContain('消息条数')
    expect(html).not.toContain('未读取')
  })
})

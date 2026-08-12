import { renderToString } from 'solid-js/web'
import { describe, expect, it, vi } from 'vitest'
import { ChatKnowledgeInspector } from '../src/renderer/src/components/ChatPage'

describe('ChatKnowledgeInspector', () => {
  it('uses the shared Inspector and exposes internal back only when history exists', () => {
    vi.stubGlobal('window', {
      oyster: {
        knowledge: { read: async () => undefined }
      }
    })

    const first = renderToString(() => ChatKnowledgeInspector({
      title: 'Current',
      canGoBack: false,
      onBack: vi.fn(),
      onOpen: vi.fn(),
      onClose: vi.fn()
    }))
    const nested = renderToString(() => ChatKnowledgeInspector({
      title: 'Nested',
      canGoBack: true,
      onBack: vi.fn(),
      onOpen: vi.fn(),
      onClose: vi.fn()
    }))

    expect(first).toContain('class="ui-inspector ui-inspector--narrow chat-knowledge-inspector')
    expect(first).not.toContain('ui-inspector__back')
    expect(nested).toContain('ui-inspector__back')
    expect(nested).toContain('返回上一条知识')
    vi.unstubAllGlobals()
  })
})

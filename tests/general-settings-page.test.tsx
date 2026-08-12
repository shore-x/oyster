import { renderToString } from 'solid-js/web'
import { describe, expect, it, vi } from 'vitest'
import { GeneralSettingsPage } from '../src/renderer/src/components/GeneralSettingsPage'

describe('GeneralSettingsPage', () => {
  it('exposes independent interface and Agent output language selectors', () => {
    const html = renderToString(() => GeneralSettingsPage({
      onBrowseDesignDocuments: vi.fn(),
      onOpenDesignDocuments: vi.fn()
    }))

    expect(html).toContain('data-testid="ui-language-select"')
    expect(html).toContain('data-testid="agent-language-select"')
    expect(html.match(/<select value="zh-CN"/g)).toHaveLength(2)
    expect(html).toContain('<option value="zh-CN">简体中文</option>')
    expect(html).toContain('<option value="en-US">English</option>')
    expect(html).toContain('Agent 输出语言')
    expect(html).toContain('已有内容保持不变')
    expect(html).toContain('Oyster 设计文档')
    expect(html).toContain('data-testid="browse-design-documents"')
    expect(html).toContain('data-testid="open-design-documents"')
  })
})

import { renderToString } from 'solid-js/web'
import { describe, expect, it, vi } from 'vitest'
import { GeneralSettingsPage } from '../src/renderer/src/components/GeneralSettingsPage'

describe('GeneralSettingsPage', () => {
  it('exposes the single application language selector', () => {
    const html = renderToString(() => GeneralSettingsPage({
      onBrowseDesignDocuments: vi.fn(),
      onOpenDesignDocuments: vi.fn()
    }))

    expect(html).toContain('data-testid="app-language-select"')
    expect(html).toContain('<select value="zh-CN"')
    expect(html).toContain('<option value="zh-CN">简体中文</option>')
    expect(html).toContain('<option value="en-US">English</option>')
    expect(html).toContain('新的 Agent Invocation 会自动收到相同的语言要求')
    expect(html).toContain('Oyster 设计文档')
    expect(html).toContain('data-testid="browse-design-documents"')
    expect(html).toContain('data-testid="open-design-documents"')
  })
})

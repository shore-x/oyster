import { renderToString } from 'solid-js/web'
import { describe, expect, it } from 'vitest'
import { GeneralSettingsPage } from '../src/renderer/src/components/GeneralSettingsPage'

describe('GeneralSettingsPage', () => {
  it('exposes the single application language selector', () => {
    const html = renderToString(() => GeneralSettingsPage())

    expect(html).toContain('data-testid="app-language-select"')
    expect(html).toContain('<select value="zh-CN"')
    expect(html).toContain('<option value="zh-CN">简体中文</option>')
    expect(html).toContain('<option value="en-US">English</option>')
    expect(html).toContain('新的 Agent Invocation 会自动收到相同的语言要求')
  })
})

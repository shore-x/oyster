import { describe, expect, it } from 'vitest'
import { markdownToSafeHtml } from '../src/renderer/src/ui/Markdown'

describe('Markdown', () => {
  it('renders common Markdown structures used by Agent messages', () => {
    const html = markdownToSafeHtml([
      '## 结论',
      '',
      '- **保留**列表',
      '- 渲染 `code`',
      '',
      '| 项目 | 状态 |',
      '| --- | --- |',
      '| Markdown | 可用 |'
    ].join('\n'))

    expect(html).toContain('<h2>结论</h2>')
    expect(html).toContain('<strong>保留</strong>列表')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('<table>')
  })

  it('keeps Knowledge Statement links interactive without treating raw HTML as markup', () => {
    const html = markdownToSafeHtml(
      '阅读 [[Knowledge Maintenance Agent|知识维护 Agent]]。<script>alert(1)</script>',
      true
    )

    expect(html).toContain('data-knowledge-title="Knowledge Maintenance Agent"')
    expect(html).toContain('>知识维护 Agent</button>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('does not emit navigable links for unsafe or local protocols', () => {
    const html = markdownToSafeHtml('[危险](javascript:alert(1)) [本地](file:///tmp/secret)')

    expect(html).not.toContain('href=')
    expect(html).toContain('markdown-link--disabled')
  })

  it('can preview external Markdown without loading image resources', () => {
    const html = markdownToSafeHtml([
      '![local](../../secret.png)',
      '![remote](https://tracking.example/pixel.png)',
      '![file](file:///etc/passwd)'
    ].join('\n'), false, false)

    expect(html).not.toContain('<img')
    expect(html).not.toContain('src=')
    expect(html).toContain('[图片：local]')
    expect(html).toContain('[图片：remote]')
    expect(html).toContain('[图片：file]')
  })
})

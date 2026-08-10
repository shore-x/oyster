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

  it('turns relative Markdown and wiki links into unresolved file targets in file mode', () => {
    const html = markdownToSafeHtml([
      '[架构](../architecture/system.md#runtime "架构说明")',
      '[[decisions/storage.md|存储决策]]'
    ].join(' '), false, true, true)

    expect(html).toContain('data-file-target="../architecture/system.md#runtime"')
    expect(html).toContain('title="架构说明"')
    expect(html).toContain('>架构</button>')
    expect(html).toContain('data-file-target="decisions/storage.md"')
    expect(html).toContain('>存储决策</button>')
  })

  it('keeps external and document-fragment links navigable in file mode', () => {
    const html = markdownToSafeHtml([
      '[网页](https://example.com/docs)',
      '[邮件](mailto:team@example.com)',
      '[章节](#details)'
    ].join(' '), false, true, true)

    expect(html).toContain('href="https://example.com/docs"')
    expect(html).toContain('target="_blank" rel="noreferrer noopener"')
    expect(html).toContain('href="mailto:team@example.com"')
    expect(html).toContain('href="#details"')
    expect(html).not.toContain('data-file-target="https://example.com/docs"')
  })

  it('still disables unsafe, local-protocol, and absolute paths in file mode', () => {
    const html = markdownToSafeHtml([
      '[危险](javascript:alert(1))',
      '[本地](file:///tmp/secret)',
      '[绝对](/tmp/secret.md)',
      '[[file:///tmp/secret|Wiki 本地]]'
    ].join(' '), false, true, true)

    expect(html).not.toContain('href="javascript:')
    expect(html).not.toContain('href="file:')
    expect(html).not.toContain('data-file-target="/tmp/secret.md"')
    expect(html).not.toContain('data-file-target="file:')
    expect(html.match(/markdown-link--disabled/g)).toHaveLength(4)
  })

  it('keeps Knowledge wiki-link behavior when both interactive modes are requested', () => {
    const html = markdownToSafeHtml(
      '[[Knowledge Maintenance Agent|知识维护 Agent]] [设计](design.md)',
      true,
      true,
      true
    )

    expect(html).toContain('data-knowledge-title="Knowledge Maintenance Agent"')
    expect(html).not.toContain('data-file-target="Knowledge Maintenance Agent"')
    expect(html).toContain('data-file-target="design.md"')
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

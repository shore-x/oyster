import { renderToString } from 'solid-js/web'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderSnapshot } from '../src/shared/folder-browser'

const controller = vi.hoisted(() => ({
  snapshot: vi.fn(),
  selectedPath: vi.fn(),
  document: vi.fn(),
  loadingFolder: vi.fn(),
  loadingFile: vi.fn(),
  error: vi.fn(),
  linkPreview: vi.fn(),
  canGoBack: vi.fn(),
  canGoForward: vi.fn(),
  load: vi.fn(),
  selectEntry: vi.fn(),
  openTarget: vi.fn(),
  previewTarget: vi.fn(),
  goBack: vi.fn(),
  goForward: vi.fn()
}))

vi.mock('../src/renderer/src/folder-browser-controller', () => ({
  createFolderBrowserController: () => controller
}))

import { FolderBrowserPage } from '../src/renderer/src/components/FolderBrowserPage'

const tree: FolderSnapshot = {
  path: '/workspace',
  entries: [{
    name: 'docs',
    path: '/workspace/docs',
    kind: 'directory',
    entries: [
      { name: 'README.md', path: '/workspace/docs/README.md', kind: 'file' },
      { name: 'notes.txt', path: '/workspace/docs/notes.txt', kind: 'file' },
      { name: 'linked.md', path: '/workspace/docs/linked.md', kind: 'symlink' },
      { name: 'socket', path: '/workspace/docs/socket', kind: 'other' }
    ]
  }]
}

beforeEach(() => {
  vi.clearAllMocks()
  controller.snapshot.mockReturnValue(tree)
  controller.selectedPath.mockReturnValue('/workspace/docs/README.md')
  controller.document.mockReturnValue({
    kind: 'markdown',
    path: '/workspace/docs/README.md',
    size: 20,
    text: '# Design\n\n[Guide](guide.md#details) and [[Reference|reference]].'
  })
  controller.loadingFolder.mockReturnValue(false)
  controller.loadingFile.mockReturnValue(false)
  controller.error.mockReturnValue(undefined)
  controller.linkPreview.mockReturnValue(undefined)
  controller.canGoBack.mockReturnValue(false)
  controller.canGoForward.mockReturnValue(false)
})

describe('FolderBrowserPage', () => {
  it('lists the complete tree and renders the selected Markdown document', () => {
    const html = renderToString(() => FolderBrowserPage({
      folderPath: '/workspace',
      label: 'Oyster Design',
      onBack: vi.fn()
    }))

    expect(html).toContain('data-testid="folder-browser-page"')
    expect(html).toContain('Oyster Design')
    expect(html).toContain('/workspace')
    expect(html).toContain('docs')
    expect(html).toContain('README.md')
    expect(html).toContain('notes.txt')
    expect(html).toContain('linked.md')
    expect(html).toContain('socket')
    expect(html.match(/data-testid="folder-browser-entry"/g)).toHaveLength(4)
    expect(html).toContain('data-kind="symlink"')
    expect(html).toContain('data-kind="other"')
    expect(html).toContain('data-testid="folder-browser-markdown"')
    expect(html).toContain('<h1>Design</h1>')
    expect(html).toContain('data-file-target="guide.md#details"')
    expect(html).toContain('data-file-target="Reference"')
    expect(html).toMatch(/data-testid="folder-browser-history-back"[^>]*disabled/)
    expect(html).toMatch(/data-testid="folder-browser-history-forward"[^>]*disabled/)
  })

  it('renders non-Markdown UTF-8 as escaped plain text', () => {
    controller.selectedPath.mockReturnValue('/workspace/docs/notes.txt')
    controller.document.mockReturnValue({
      kind: 'text',
      path: '/workspace/docs/notes.txt',
      size: 25,
      text: '<script>alert("x")</script>'
    })

    const html = renderToString(() => FolderBrowserPage({
      folderPath: '/workspace',
      label: 'Files',
      onBack: vi.fn()
    }))

    expect(html).toContain('data-testid="folder-browser-text"')
    expect(html).toContain('&lt;script>alert("x")&lt;/script>')
    expect(html).not.toContain('<script>')
  })

  it('shows a clear unsupported state for non-UTF-8 files', () => {
    controller.selectedPath.mockReturnValue('/workspace/docs/data.bin')
    controller.document.mockReturnValue({
      kind: 'unsupported',
      path: '/workspace/docs/data.bin',
      size: 2,
      reason: 'invalid-utf8'
    })

    const html = renderToString(() => FolderBrowserPage({
      folderPath: '/workspace',
      label: 'Files',
      onBack: vi.fn()
    }))

    expect(html).toContain('data-testid="folder-browser-unsupported"')
    expect(html).toContain('暂不支持预览')
    expect(html).toContain('严格 UTF-8')
    expect(html).not.toContain('folder-browser-markdown')
    expect(html).not.toContain('folder-browser-text')
  })

  it('renders concise ready, failed, and binary link preview states', () => {
    controller.linkPreview.mockReturnValue({
      kind: 'ready',
      target: 'guide',
      document: {
        kind: 'markdown',
        path: '/workspace/docs/guide.md',
        size: 19,
        text: '## Linked guide\n\nBody.'
      }
    })
    let html = renderToString(() => FolderBrowserPage({
      folderPath: '/workspace',
      label: 'Files',
      onBack: vi.fn()
    }))
    expect(html).toContain('data-testid="folder-browser-link-preview"')
    expect(html).toContain('只读预览')
    expect(html).toContain('<h2>Linked guide</h2>')

    controller.linkPreview.mockReturnValue({
      kind: 'error',
      target: 'missing',
      path: '/workspace/docs/missing',
      message: '文件不存在'
    })
    html = renderToString(() => FolderBrowserPage({
      folderPath: '/workspace',
      label: 'Files',
      onBack: vi.fn()
    }))
    expect(html).toContain('无法预览')
    expect(html).toContain('文件不存在')

    controller.linkPreview.mockReturnValue({
      kind: 'ready',
      target: 'data.bin',
      document: {
        kind: 'unsupported',
        path: '/workspace/docs/data.bin',
        size: 2,
        reason: 'invalid-utf8'
      }
    })
    html = renderToString(() => FolderBrowserPage({
      folderPath: '/workspace',
      label: 'Files',
      onBack: vi.fn()
    }))
    expect(html).toContain('目标文件无法按严格 UTF-8 文本解码')
  })
})

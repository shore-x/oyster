import { renderToString } from 'solid-js/web'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactSnapshot } from '../src/shared/artifacts'

const controller = vi.hoisted(() => ({
  snapshot: vi.fn(),
  busy: vi.fn(),
  error: vi.fn(),
  refresh: vi.fn(),
  createArtifact: vi.fn(),
  openRepository: vi.fn(),
  openFolder: vi.fn()
}))

vi.mock('../src/renderer/src/artifacts-controller', () => ({
  createArtifactsController: () => controller
}))

import { ArtifactsPage } from '../src/renderer/src/components/ArtifactsPage'

beforeEach(() => {
  vi.clearAllMocks()
  controller.snapshot.mockReturnValue(undefined)
  controller.busy.mockReturnValue(undefined)
  controller.error.mockReturnValue(undefined)
})

describe('ArtifactsPage', () => {
  it('does not present a failed initial load as an empty Repository', () => {
    controller.error.mockReturnValue('无法读取 Artifact Repository')

    const html = renderToString(() => ArtifactsPage({
      onBrowseDesignDocuments: vi.fn(),
      onOpenDesignDocuments: vi.fn(async () => undefined),
      onBrowseArtifact: vi.fn(),
      onManageSkill: vi.fn()
    }))

    expect(html).toContain('无法读取 Artifact')
    expect(html).not.toContain('还没有 Artifact')
    expect(html).toMatch(/data-testid="create-artifact"[^>]*disabled/)
    expect(html).toContain('data-testid="design-documents-card"')
    expect(html).toContain('data-testid="browse-design-documents"')
    expect(html).toContain('data-testid="open-design-documents"')
  })

  it('labels the AGENTS.md modification time and renders its Markdown', () => {
    const snapshot: ArtifactSnapshot = {
      repositoryPath: '/app-data/artifacts',
      artifacts: [{
        directoryName: 'agent-memory-tracking',
        directoryPath: '/app-data/artifacts/agent-memory-tracking',
        attention: '# Attention\n\nTrack agent memory research.',
        modifiedAt: '2026-07-30T09:00:00.000Z'
      }],
      invalidDirectories: []
    }
    controller.snapshot.mockReturnValue(snapshot)

    const html = renderToString(() => ArtifactsPage({
      onBrowseDesignDocuments: vi.fn(),
      onOpenDesignDocuments: vi.fn(async () => undefined),
      onBrowseArtifact: vi.fn(),
      onManageSkill: vi.fn()
    }))

    expect(html).toContain('<h1>产物</h1>')
    expect(html).toContain('data-testid="design-documents-card"')
    expect(html).toContain('<h2>Oyster 设计文档</h2>')
    expect(html).toContain('>内置</span>')
    expect(html).toContain('data-testid="browse-design-documents"')
    expect(html).toContain('data-testid="open-design-documents"')
    expect(html).toContain('agent-memory-tracking')
    expect(html).toContain('AGENTS.md 更新于')
    expect(html).toContain('<h1>Attention</h1>')
    expect(html).toContain('Track agent memory research.')
    expect(html).toContain('data-testid="browse-artifact"')
    expect(html).toContain('data-testid="open-artifact"')
    expect(html.match(/data-testid="artifact-card"/g)).toHaveLength(1)
    expect(html).not.toContain('data-testid="artifact-skill-badge"')
    expect(html).not.toContain('data-testid="manage-artifact-skill"')
  })

  it('marks a Skill Artifact and links its output to the dedicated Skills management view', () => {
    const onManageSkill = vi.fn()
    const snapshot: ArtifactSnapshot = {
      repositoryPath: '/app-data/artifacts',
      artifacts: [{
        directoryName: 'review-skill',
        directoryPath: '/app-data/artifacts/review-skill',
        attention: '# Attention\n\nMaintain review guidance.',
        modifiedAt: '2026-07-30T09:00:00.000Z',
        skill: {
          outputPath: '/app-data/artifacts/review-skill/output',
          documentPath: '/app-data/artifacts/review-skill/output/SKILL.md',
          name: 'review',
          description: 'Review changes before delivery.',
          status: 'ready'
        }
      }],
      invalidDirectories: []
    }
    controller.snapshot.mockReturnValue(snapshot)

    const html = renderToString(() => ArtifactsPage({
      onBrowseDesignDocuments: vi.fn(),
      onOpenDesignDocuments: vi.fn(async () => undefined),
      onBrowseArtifact: vi.fn(),
      onManageSkill
    }))

    expect(html).toContain('data-testid="artifact-skill-badge"')
    expect(html).toContain('data-testid="artifact-skill-summary"')
    expect(html).toContain('review')
    expect(html).toContain('可绑定')
    expect(html).toContain('/app-data/artifacts/review-skill/output')
    expect(html).toContain('data-testid="manage-artifact-skill"')
    expect(html).toContain('在 Skills 中管理')
    expect(html).not.toContain('data-testid="bind-managed-skill"')
  })

  it('shows an invalid Skill output as a diagnosable Artifact without binding controls', () => {
    const snapshot: ArtifactSnapshot = {
      repositoryPath: '/app-data/artifacts',
      artifacts: [{
        directoryName: 'broken-skill',
        directoryPath: '/app-data/artifacts/broken-skill',
        attention: '# Attention\n\nRepair this output.',
        modifiedAt: '2026-07-30T09:00:00.000Z',
        skill: {
          outputPath: '/app-data/artifacts/broken-skill/output',
          status: 'invalid',
          issue: '缺少 output/SKILL.md'
        }
      }],
      invalidDirectories: []
    }
    controller.snapshot.mockReturnValue(snapshot)

    const html = renderToString(() => ArtifactsPage({
      onBrowseDesignDocuments: vi.fn(),
      onOpenDesignDocuments: vi.fn(async () => undefined),
      onBrowseArtifact: vi.fn(),
      onManageSkill: vi.fn()
    }))

    expect(html).toContain('Skill')
    expect(html).toContain('输出无效')
    expect(html).toContain('缺少 output/SKILL.md')
    expect(html).toContain('在 Skills 中管理')
    expect(html).not.toContain('data-testid="bind-managed-skill"')
  })
})

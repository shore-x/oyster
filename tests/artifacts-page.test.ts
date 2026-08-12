import { renderToString } from 'solid-js/web'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactSnapshot } from '../src/shared/artifacts'

const controller = vi.hoisted(() => ({
  snapshot: vi.fn(),
  busy: vi.fn(),
  error: vi.fn(),
  refresh: vi.fn(),
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

function renderPage(props: { snapshot?: ArtifactSnapshot; onManageSkill?: () => void } = {}): string {
  controller.snapshot.mockReturnValue(props.snapshot)
  return renderToString(() => ArtifactsPage({
    onBrowseArtifact: vi.fn(),
    onStartConversation: vi.fn(),
    onManageSkill: props.onManageSkill ?? vi.fn()
  }))
}

describe('ArtifactsPage', () => {
  it('does not present a failed initial load as an empty Workbench', () => {
    controller.error.mockReturnValue('无法读取 Artifact Repository')
    const html = renderPage()

    expect(html).toContain('无法读取工作台内容')
    expect(html).not.toContain('工作台中还没有内容')
    expect(html).not.toContain('data-testid="create-artifact"')
    expect(html).not.toContain('data-testid="design-documents-card"')
  })

  it('presents existing Artifacts as Workbench content', () => {
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
    const html = renderPage({ snapshot })

    expect(html).toContain('<h1>工作台</h1>')
    expect(html).toContain('与 Agent 共同创建和维护')
    expect(html).toContain('data-testid="start-artifact-conversation"')
    expect(html).not.toContain('Oyster 设计文档')
    expect(html).toContain('agent-memory-tracking')
    expect(html).toContain('说明更新于')
    expect(html).toContain('目标与维护说明')
    expect(html).toContain('>Attention Track agent memory research.</span>')
    expect(html).not.toContain('># Attention Track agent memory research.</span>')
    expect(html).toContain('<h1>Attention</h1>')
    expect(html).toContain('Track agent memory research.')
    expect(html).toContain('data-testid="browse-artifact"')
    expect(html).toContain('data-testid="open-artifact"')
    expect(html.match(/data-testid="artifact-card"/g)).toHaveLength(1)
    expect(html).not.toContain('data-testid="artifact-skill-badge"')
    expect(html).not.toContain('data-testid="manage-artifact-skill"')
  })

  it('marks a Skill Artifact and links it to the dedicated Skills management view', () => {
    const snapshot: ArtifactSnapshot = {
      repositoryPath: '/app-data/artifacts',
      artifacts: [{
        directoryName: 'review-skill',
        directoryPath: '/app-data/artifacts/review-skill',
        attention: '# Attention\n\nMaintain review guidance.',
        modifiedAt: '2026-07-30T09:00:00.000Z',
        skill: {
          skillPath: '/app-data/artifacts/review-skill',
          documentPath: '/app-data/artifacts/review-skill/SKILL.md',
          name: 'review',
          description: 'Review changes before delivery.',
          status: 'ready'
        }
      }],
      invalidDirectories: []
    }
    const html = renderPage({ snapshot, onManageSkill: vi.fn() })

    expect(html).toContain('data-testid="artifact-skill-badge"')
    expect(html).toContain('data-testid="artifact-skill-summary"')
    expect(html).toContain('review')
    expect(html).toContain('可绑定')
    expect(html).toContain('/app-data/artifacts/review-skill')
    expect(html).toContain('data-testid="manage-artifact-skill"')
    expect(html).toContain('在 Skills 中管理')
    expect(html).not.toContain('data-testid="bind-managed-skill"')
  })

  it('shows an invalid root Skill declaration as a diagnosable Artifact without binding controls', () => {
    const snapshot: ArtifactSnapshot = {
      repositoryPath: '/app-data/artifacts',
      artifacts: [{
        directoryName: 'broken-skill',
        directoryPath: '/app-data/artifacts/broken-skill',
        attention: '# Attention\n\nRepair this output.',
        modifiedAt: '2026-07-30T09:00:00.000Z',
        skill: {
          skillPath: '/app-data/artifacts/broken-skill',
          documentPath: '/app-data/artifacts/broken-skill/SKILL.md',
          status: 'invalid',
          issue: 'SKILL.md 缺少有效 name'
        }
      }],
      invalidDirectories: []
    }
    const html = renderPage({ snapshot })

    expect(html).toContain('Skill')
    expect(html).toContain('声明无效')
    expect(html).toContain('SKILL.md 缺少有效 name')
    expect(html).toContain('在 Skills 中管理')
    expect(html).not.toContain('data-testid="bind-managed-skill"')
  })
})

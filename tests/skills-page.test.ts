import { renderToString } from 'solid-js/web'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DiscoveredSkill,
  ManagedSkillDocument,
  ManagedSkillSummary,
  SkillBindingTargetState,
  SkillBindingTargetSummary,
  SkillDiscoveryStateView,
  SkillDocument,
  SkillScope
} from '../src/shared/skills'

const externalController = vi.hoisted(() => ({
  snapshot: vi.fn(),
  selectedId: vi.fn(),
  selectedSkill: vi.fn(),
  document: vi.fn(),
  busy: vi.fn(),
  error: vi.fn(),
  discover: vi.fn(),
  select: vi.fn(),
  openFolder: vi.fn()
}))

const managedController = vi.hoisted(() => ({
  snapshot: vi.fn(),
  selectedDirectoryName: vi.fn(),
  selectedSkill: vi.fn(),
  document: vi.fn(),
  error: vi.fn(),
  isBusy: vi.fn(),
  actionError: vi.fn(),
  refresh: vi.fn(),
  select: vi.fn(),
  openFolder: vi.fn(),
  bind: vi.fn(),
  unbind: vi.fn()
}))

vi.mock('../src/renderer/src/skill-discovery-controller', () => ({
  createSkillDiscoveryController: () => externalController
}))

vi.mock('../src/renderer/src/managed-skills-controller', () => ({
  createManagedSkillsController: () => managedController,
  managedSkillOperationKey: (
    action: string,
    input: { artifactDirectoryName: string; targetId: string }
  ) => `${action}:${input.artifactDirectoryName}:${input.targetId}`
}))

import {
  SkillsPage,
  groupSkillsByAgent,
  skillBindingStateLabel,
  skillScopeLabel
} from '../src/renderer/src/components/SkillsPage'

function skill(overrides: Partial<DiscoveredSkill> = {}): DiscoveredSkill {
  return {
    id: 'claude:project:review',
    agentType: 'claude',
    agentDisplayName: 'Claude Code',
    name: 'review',
    description: 'Review a change before delivery.',
    scope: 'project',
    projectPath: '/work/oyster',
    directoryPath: '/work/oyster/.claude/skills/review',
    documentPath: '/work/oyster/.claude/skills/review/SKILL.md',
    documentFileName: 'SKILL.md',
    format: 'agent_skill',
    sizeBytes: 256,
    modifiedAt: '2026-08-01T08:00:00.000Z',
    ...overrides
  }
}

function documentFor(value: DiscoveredSkill): SkillDocument {
  return {
    skillId: value.id,
    documentPath: value.documentPath,
    fileName: value.documentFileName,
    content: '# Review\n\nKeep the change focused.\n\n![private diagram](file:///tmp/private.png)',
    sizeBytes: value.sizeBytes,
    modifiedAt: value.modifiedAt
  }
}

function target(overrides: Partial<SkillBindingTargetSummary> = {}): SkillBindingTargetSummary {
  return {
    id: 'claude:user',
    agentType: 'claude',
    agentDisplayName: 'Claude Code',
    scope: 'user',
    registrationRoot: '/home/demo/.claude/skills',
    state: 'unbound',
    shared: false,
    ...overrides
  }
}

function managedSkill(overrides: Partial<ManagedSkillSummary> = {}): ManagedSkillSummary {
  return {
    artifactDirectoryName: 'review-skill',
    artifactPath: '/app-data/artifacts/review-skill',
    outputPath: '/app-data/artifacts/review-skill/output',
    documentPath: '/app-data/artifacts/review-skill/output/SKILL.md',
    name: 'review',
    description: 'Review changes before delivery.',
    status: 'ready',
    targets: [
      target(),
      target({
        id: 'pi:user',
        agentType: 'pi',
        agentDisplayName: 'Pi',
        registrationRoot: '/home/demo/.agents/skills',
        bindingPath: '/home/demo/.agents/skills/review',
        state: 'bound',
        shared: true
      }),
      target({
        id: 'codex:user',
        agentType: 'codex',
        agentDisplayName: 'Codex',
        registrationRoot: '/home/demo/.agents/skills',
        bindingPath: '/home/demo/.agents/skills/review',
        state: 'conflict',
        shared: true,
        message: '目标已经存在其他文件'
      })
    ],
    ...overrides
  }
}

function managedDocument(value: ManagedSkillSummary): ManagedSkillDocument {
  return {
    artifactDirectoryName: value.artifactDirectoryName,
    documentPath: value.documentPath!,
    fileName: 'SKILL.md',
    content: '# Managed Review\n\nUse the Oyster Artifact.\n\n![private](file:///tmp/private.png)',
    sizeBytes: 180,
    modifiedAt: '2026-08-01T08:00:00.000Z'
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  externalController.snapshot.mockReturnValue(undefined)
  externalController.selectedId.mockReturnValue(undefined)
  externalController.selectedSkill.mockReturnValue(undefined)
  externalController.document.mockReturnValue(undefined)
  externalController.busy.mockReturnValue(undefined)
  externalController.error.mockReturnValue(undefined)
  managedController.snapshot.mockReturnValue(undefined)
  managedController.selectedDirectoryName.mockReturnValue(undefined)
  managedController.selectedSkill.mockReturnValue(undefined)
  managedController.document.mockReturnValue(undefined)
  managedController.error.mockReturnValue(undefined)
  managedController.isBusy.mockReturnValue(false)
  managedController.actionError.mockReturnValue(undefined)
})

describe('SkillsPage', () => {
  it('uses separate Oyster-managed and external-discovery views', () => {
    managedController.snapshot.mockReturnValue({ skills: [], errors: [] })

    const html = renderToString(() => SkillsPage())

    expect(html).toContain('data-testid="skills-view-managed"')
    expect(html).toContain('data-testid="skills-view-external"')
    expect(html).toContain('Oyster 管理')
    expect(html).toContain('外部发现')
    expect(html).toContain('data-testid="managed-skills-view"')
    expect(html).not.toContain('data-testid="external-skills-view"')
  })

  it('shows a managed Skill preview and explicit user-level target states and actions', () => {
    const selected = managedSkill()
    managedController.snapshot.mockReturnValue({ skills: [selected], errors: [] })
    managedController.selectedDirectoryName.mockReturnValue(selected.artifactDirectoryName)
    managedController.selectedSkill.mockReturnValue(selected)
    managedController.document.mockReturnValue(managedDocument(selected))

    const html = renderToString(() => SkillsPage())

    expect(html).toContain('review-skill')
    expect(html).toContain('/app-data/artifacts/review-skill/output')
    expect(html).toContain('Claude Code')
    expect(html).toContain('Pi')
    expect(html).toContain('Codex')
    expect(html).toContain('未绑定')
    expect(html).toContain('已绑定')
    expect(html).toContain('冲突')
    expect(html).toContain('共享注册目录')
    expect(html).toContain('data-testid="bind-managed-skill"')
    expect(html).toContain('data-testid="unbind-managed-skill"')
    expect(html).toContain('<h1>Managed Review</h1>')
    expect(html).toContain('[图片：private]')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('file:///tmp/private.png')
    expect(html).toContain('data-testid="open-managed-skill-folder"')
    expect(html).toContain('打开输出目录')
  })

  it('previews an invalid Skill document and allows only an existing binding to be removed', () => {
    const selected = managedSkill({
      name: undefined,
      status: 'invalid',
      issue: 'SKILL.md 缺少有效 name',
      targets: [
        target({
          state: 'bound',
          bindingPath: '/home/demo/.claude/skills/old-review'
        }),
        target({
          id: 'pi:user',
          agentType: 'pi',
          agentDisplayName: 'Pi',
          registrationRoot: '/home/demo/.pi/agent/skills',
          state: 'unbound'
        })
      ]
    })
    managedController.snapshot.mockReturnValue({ skills: [selected], errors: [] })
    managedController.selectedDirectoryName.mockReturnValue(selected.artifactDirectoryName)
    managedController.selectedSkill.mockReturnValue(selected)
    managedController.document.mockReturnValue(managedDocument(selected))

    const html = renderToString(() => SkillsPage())

    expect(html).toContain('输出无效')
    expect(html).toContain('SKILL.md 缺少有效 name')
    expect(html).toContain('当前输出不能创建新绑定')
    expect(html).toContain('<h1>Managed Review</h1>')
    expect(html).not.toContain('data-testid="bind-managed-skill"')
    expect(html).toContain('data-testid="unbind-managed-skill"')
  })

  it('shows project scope, original locations and a safe external Markdown preview', () => {
    const selected = skill()
    const snapshot: SkillDiscoveryStateView = { skills: [selected], errors: [] }
    externalController.snapshot.mockReturnValue(snapshot)
    externalController.selectedId.mockReturnValue(selected.id)
    externalController.selectedSkill.mockReturnValue(selected)
    externalController.document.mockReturnValue(documentFor(selected))

    const html = renderToString(() => SkillsPage({ initialView: 'external' }))

    expect(html).toContain('Claude Code')
    expect(html).toContain('项目')
    expect(html).toContain('/work/oyster')
    expect(html).toContain('/work/oyster/.claude/skills/review')
    expect(html).toContain('/work/oyster/.claude/skills/review/SKILL.md')
    expect(html).toContain('<h1>Review</h1>')
    expect(html).toContain('Keep the change focused.')
    expect(html).toContain('[图片：private diagram]')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('file:///tmp/private.png')
    expect(html).toContain('data-testid="open-skill-folder"')
    expect(html).not.toContain('data-testid="bind-managed-skill"')
  })

  it('keeps every supported discovery scope and binding state distinct', () => {
    const labels = (['user', 'project', 'admin', 'system', 'other'] as SkillScope[])
      .map(skillScopeLabel)

    expect(labels).toEqual(['全局', '项目', '管理', '系统', '其他'])
    expect((['unbound', 'bound', 'conflict', 'error'] as SkillBindingTargetState[])
      .map(skillBindingStateLabel)).toEqual([
      '未绑定', '已绑定', '冲突', '错误'
    ])
  })

  it('groups the external list by Agent while preserving Skill order within each group', () => {
    const skills = [
      skill({ id: 'claude:first', name: 'first' }),
      skill({ id: 'pi:only', agentType: 'pi', agentDisplayName: 'Pi', name: 'pi-only' }),
      skill({ id: 'claude:second', name: 'second' })
    ]

    const groups = groupSkillsByAgent(skills)
    expect(groups.map((group) => ({
      agentType: group.agentType,
      names: group.skills.map((entry) => entry.name)
    }))).toEqual([
      { agentType: 'claude', names: ['first', 'second'] },
      { agentType: 'pi', names: ['pi-only'] }
    ])

    externalController.snapshot.mockReturnValue({ skills, errors: [] })
    const html = renderToString(() => SkillsPage({ initialView: 'external' }))
    expect(html.match(/data-testid="skill-agent-group"/g)).toHaveLength(2)
    expect(html).toContain('data-agent-type="claude"')
    expect(html).toContain('data-agent-type="pi"')
    expect(html.indexOf('Claude Code')).toBeLessThan(html.indexOf('Pi'))
  })

  it('shows partial discovery errors without hiding discovered Skills', () => {
    const selected = skill({ scope: 'user', projectPath: undefined })
    externalController.snapshot.mockReturnValue({
      skills: [selected],
      errors: [{
        agentType: 'codex',
        path: '/etc/codex/skills',
        message: '没有读取权限'
      }]
    })
    externalController.selectedId.mockReturnValue(selected.id)
    externalController.selectedSkill.mockReturnValue(selected)
    externalController.document.mockReturnValue(documentFor(selected))

    const html = renderToString(() => SkillsPage({ initialView: 'external' }))

    expect(html).toContain('部分 Skill 位置无法读取')
    expect(html).toContain('/etc/codex/skills')
    expect(html).toContain('没有读取权限')
    expect(html).toContain('review')
    expect(html).toContain('全局')
  })

  it('distinguishes loading from completed empty lists in both views', () => {
    const managedLoading = renderToString(() => SkillsPage())
    expect(managedLoading).toContain('正在读取 Skill Artifact…')

    managedController.snapshot.mockReturnValue({ skills: [], errors: [] })
    const managedEmpty = renderToString(() => SkillsPage())
    expect(managedEmpty).toContain('还没有 Skill Artifact')

    const externalLoading = renderToString(() => SkillsPage({ initialView: 'external' }))
    expect(externalLoading).toContain('正在读取 Skill…')

    externalController.snapshot.mockReturnValue({ skills: [], errors: [] })
    const externalEmpty = renderToString(() => SkillsPage({ initialView: 'external' }))
    expect(externalEmpty).toContain('没有发现 Skill')
  })
})

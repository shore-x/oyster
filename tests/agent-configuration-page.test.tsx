import { renderToString } from 'solid-js/web'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CHAT_AGENT_ID } from '../src/shared/chat'
import type { AgentConfigurationRoleView } from '../src/renderer/src/agent-configuration-controller'

const controller = vi.hoisted(() => ({
  roles: vi.fn(),
  configurationErrors: vi.fn(),
  loading: vi.fn(),
  error: vi.fn(),
  isSaving: vi.fn(),
  wasSaved: vi.fn(),
  saveDefaultInstructions: vi.fn()
}))

vi.mock('../src/renderer/src/agent-configuration-controller', () => ({
  createAgentConfigurationController: () => controller
}))

import { AgentConfigurationPage } from '../src/renderer/src/components/AgentConfigurationPage'
import { PiAgentSettingsPanel } from '../src/renderer/src/components/PiAgentSettingsPanel'

function role(
  id: AgentConfigurationRoleView['id'],
  displayName: string
): AgentConfigurationRoleView {
  return {
    id,
    displayName,
    description: `${displayName} description`,
    runtime: 'pi_coding_agent',
    tools: [],
    builtInInstructions: 'Built in prompt',
    defaultInstructions: 'Default prompt',
    isDefaultCustomized: false,
    promptUsageDescription: 'Prompt usage',
    promptUsageStatus: 'Default'
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  controller.configurationErrors.mockReturnValue([])
  controller.loading.mockReturnValue(false)
  controller.error.mockReturnValue(undefined)
  controller.isSaving.mockReturnValue(false)
  controller.wasSaved.mockReturnValue(false)
  controller.saveDefaultInstructions.mockResolvedValue(true)
})

describe('AgentConfigurationPage', () => {
  it('offers effective Pi Runtime settings for the general Agent', () => {
    controller.roles.mockReturnValue([role(CHAT_AGENT_ID, '通用 Agent')])

    const html = renderToString(() => AgentConfigurationPage({ embedded: true }))

    expect(html).toContain('data-testid="agent-config-tab-runtime"')
    expect(html).toContain('Pi Runtime')
  })

  it('does not imply shared file-backed settings apply to isolated Knowledge Agents', () => {
    controller.roles.mockReturnValue([
      role('knowledge_maintainer', 'Knowledge Maintenance Agent')
    ])

    const html = renderToString(() => AgentConfigurationPage({ embedded: true }))

    expect(html).not.toContain('data-testid="agent-config-tab-runtime"')
  })

  it('renders the common effective Pi settings without exposing the fixed retry budget', () => {
    const html = renderToString(() => PiAgentSettingsPanel())

    expect(html).toContain('data-testid="pi-agent-auto-compaction"')
    expect(html).toContain('data-testid="pi-agent-transport"')
    expect(html).toContain('data-testid="pi-agent-http-idle-timeout"')
    expect(html).toContain('自动上下文压缩')
    expect(html).toContain('HTTP 空闲超时')
    expect(html).toContain('瞬时错误重试由 Oyster 固定为最多 3 次')
  })
})

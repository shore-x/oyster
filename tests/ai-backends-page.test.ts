import { describe, expect, it } from 'vitest'
import { renderToString } from 'solid-js/web'
import type { AiConnection } from '../src/shared/ai-backends'
import { CodingPlanAuthenticationState } from '../src/renderer/src/components/AiBackendsPage'

function authenticatingConnection(
  authentication: AiConnection['authentication']
): AiConnection {
  return {
    id: 'runtime:codex',
    adapterId: 'codex',
    backendKind: 'coding_plan',
    providerId: 'openai_codex',
    displayName: 'OpenAI Codex Coding Plan',
    credentialMode: 'oyster_keychain',
    status: 'authenticating',
    models: [],
    authentication
  }
}

describe('CodingPlanAuthenticationState', () => {
  it('renders the device challenge and keeps cancellation available', () => {
    const html = renderToString(() => CodingPlanAuthenticationState({
      connection: authenticatingConnection({
        loginMethod: 'device_code',
        verificationUri: 'https://auth.openai.com/codex/device',
        userCode: 'ABCD-1234',
        expiresAt: '2026-07-27T10:00:00.000Z'
      }),
      onCancel: () => undefined
    }))

    expect(html).toContain('coding-plan-authentication-state')
    expect(html).toContain('coding-plan-device-code')
    expect(html).toContain('ABCD-1234')
    expect(html).toContain('https://auth.openai.com/codex/device')
    expect(html).toContain('coding-plan-cancel-login-button')
  })

  it('renders browser waiting guidance without exposing a browser authorization URL', () => {
    const html = renderToString(() => CodingPlanAuthenticationState({
      connection: authenticatingConnection({ loginMethod: 'browser' }),
      onCancel: () => undefined
    }))

    expect(html).toContain('等待浏览器登录')
    expect(html).toContain('coding-plan-cancel-login-button')
    expect(html).not.toContain('oauth/authorize')
    expect(html).not.toContain('coding-plan-device-code')
  })
})

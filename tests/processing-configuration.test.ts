import { describe, expect, it } from 'vitest'
import type { AiConnectionView } from '../src/shared/knowledge-processing'
import {
  backendLabel,
  connectionCanInvokeAgent,
  providerLabel,
  reasoningLabel,
  runtimeLabel,
  selectedLlmModel
} from '../src/renderer/src/processing-configuration'

function connection(status: AiConnectionView['status']): AiConnectionView {
  return {
    id: 'coding-plan:openai-codex',
    displayName: 'OpenAI Codex',
    backendKind: 'coding_plan',
    providerId: 'openai_codex',
    destination: 'OpenAI Codex Coding Plan',
    status,
    models: [{ id: 'small', displayName: 'Small', reasoningEfforts: ['low'] }],
    defaultModelId: 'small'
  }
}

describe('processing configuration presentation', () => {
  it('resolves the exact model selected by the default LLM binding', () => {
    const connection: AiConnectionView = {
      id: 'coding-plan:openai-codex',
      displayName: 'OpenAI Codex',
      backendKind: 'coding_plan',
      providerId: 'openai_codex',
      destination: 'OpenAI Codex Coding Plan',
      status: 'ready',
      models: [
        { id: 'small', displayName: 'Small', reasoningEfforts: ['low'] },
        { id: 'large', displayName: 'Large', reasoningEfforts: ['high'] }
      ],
      defaultModelId: 'large'
    }
    const binding = {
      connectionId: connection.id,
      modelId: 'small'
    }

    expect(selectedLlmModel(binding, connection)?.id).toBe('small')
    expect(backendLabel(connection.backendKind)).toBe('Coding Plan')
    expect(providerLabel(connection.providerId)).toBe('OpenAI Codex')
    expect(runtimeLabel('pi_coding_agent')).toBe('Pi Coding Agent SDK')
    expect(reasoningLabel()).toBe('模型默认')
  })

  it.each([
    ['unverified', true],
    ['ready', true],
    ['unavailable', true],
    ['not_found', false],
    ['needs_auth', false],
    ['authenticating', false],
    ['unsupported', false]
  ] satisfies Array<[AiConnectionView['status'], boolean]>) (
    'reports whether a %s connection can invoke an Agent',
    (status, expected) => {
      expect(connectionCanInvokeAgent(connection(status))).toBe(expected)
    }
  )

  it('does not allow an Agent Invocation without a connection', () => {
    expect(connectionCanInvokeAgent(undefined)).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import type { ProcessingConnectionView, ProcessingStageView } from '../src/shared/knowledge-processing'
import {
  backendLabel,
  connectionCanAttemptRun,
  providerLabel,
  reasoningLabel,
  runtimeLabel,
  selectedStageModel
} from '../src/renderer/src/processing-configuration'

function connection(status: ProcessingConnectionView['status']): ProcessingConnectionView {
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
  it('resolves the exact model selected for a stage', () => {
    const connection: ProcessingConnectionView = {
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
    const stage = {
      id: 'knowledge_maintenance_agent',
      modelId: 'small'
    } as ProcessingStageView

    expect(selectedStageModel(stage, connection)?.id).toBe('small')
    expect(backendLabel(connection.backendKind)).toBe('Coding Plan')
    expect(providerLabel(connection.providerId)).toBe('OpenAI Codex')
    expect(runtimeLabel('pi_agent_core')).toBe('Pi Agent Core')
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
  ] satisfies Array<[ProcessingConnectionView['status'], boolean]>) (
    'reports whether a %s connection can attempt a real run',
    (status, expected) => {
      expect(connectionCanAttemptRun(connection(status))).toBe(expected)
    }
  )

  it('does not allow a run without a connection', () => {
    expect(connectionCanAttemptRun(undefined)).toBe(false)
  })
})

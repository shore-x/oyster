import type { AgentInvocationDebugRecord } from '../src/shared/agent-runtime'

export function completedAgentInvocation(
  id: string,
  toolNames: readonly string[] = [],
  modelCallCount = 1,
  agentId = 'test_agent'
): AgentInvocationDebugRecord {
  const timestamp = '2026-07-20T10:00:00.000Z'
  return {
    formatVersion: 4,
    debugFormatVersion: 1,
    invocationId: id,
    agentId,
    status: 'completed',
    startedAt: timestamp,
    completedAt: timestamp,
    durationMs: 0,
    debugRecordId: id,
    modelCallCount,
    toolCallCount: toolNames.length,
    turns: [],
    messages: [],
    modelCalls: Array.from({ length: modelCallCount }, (_, index) => ({
      id: `${id}:model:${index + 1}`,
      sequence: index + 1,
      purpose: 'agent',
      status: 'completed',
      startedAt: timestamp,
      completedAt: timestamp,
      durationMs: 0,
      model: {
        id: 'test-model',
        name: 'Test Model',
        provider: 'test',
        api: 'test',
        reasoning: false,
        contextWindow: 128_000,
        maxTokens: 4_096
      },
      context: { messages: [] },
      output: null
    })),
    toolCalls: toolNames.map((name, index) => ({
      id: `${id}:tool:${index + 1}`,
      sequence: modelCallCount + index + 1,
      name,
      status: 'completed',
      startedAt: timestamp,
      completedAt: timestamp,
      durationMs: 0,
      input: {},
      result: null,
      isError: false
    }))
  }
}

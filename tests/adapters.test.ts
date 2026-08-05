import { describe, expect, it } from 'vitest'
import {
  ClaudeHistoryAdapter,
  CodexHistoryAdapter,
  PiHistoryAdapter
} from '../src/main/discovery/adapters'

function jsonl(...records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n')
}

describe('Agent Raw Evidence adapters', () => {
  it('preserves every Claude line and detects native, file-read, and injected Skill activations', () => {
    const content = jsonl(
      { type: 'user', message: { role: 'user', content: 'Please investigate.' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'deep-research' } }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/skills/imagegen/SKILL.md' } }] } },
      { type: 'user', message: { role: 'user', content: '<skill name="reviewer">instructions</skill>' } }
    )

    const evidence = new ClaudeHistoryAdapter().createRawEvidence(content)

    expect(evidence.lines).toEqual(content.split('\n'))
    expect(evidence.formatVersion).toBe('claude-jsonl-raw-v1')
    expect(evidence.skillHints).toEqual([
      expect.objectContaining({ name: 'deep-research', tool: 'Skill', source: 'tool_call', location: expect.objectContaining({ line: 2 }) }),
      expect.objectContaining({ name: 'imagegen', tool: 'Read', source: 'tool_call', location: expect.objectContaining({ line: 3 }) }),
      expect.objectContaining({ name: 'reviewer', source: 'runtime_injection', location: expect.objectContaining({ line: 4 }) })
    ])
  })

  it('preserves Pi history and detects Skill calls without treating ordinary tools as Skills', () => {
    const content = jsonl(
      { type: 'message', role: 'assistant', content: [{ type: 'toolCall', name: 'Skill', arguments: { name: 'skill-creator' } }] },
      { type: 'message', role: 'assistant', content: [{ type: 'toolCall', name: 'search', arguments: { query: 'SKILL.md' } }] },
      { type: 'message', role: 'user', content: [{ type: 'text', text: '<skill><name>local-review</name></skill>' }] }
    )

    const evidence = new PiHistoryAdapter().createRawEvidence(content)

    expect(evidence.lines).toEqual(content.split('\n'))
    expect(evidence.formatVersion).toBe('pi-jsonl-raw-v1')
    expect(evidence.skillHints).toEqual([
      expect.objectContaining({ name: 'skill-creator', tool: 'Skill', source: 'tool_call', location: expect.objectContaining({ line: 1 }) }),
      expect.objectContaining({ name: 'local-review', source: 'runtime_injection', location: expect.objectContaining({ line: 3 }) })
    ])
  })

  it('preserves Codex history and detects function calls and SKILL.md reads', () => {
    const content = jsonl(
      { type: 'response_item', payload: { type: 'function_call', name: 'Skill', arguments: { skill: 'openai-docs' } } },
      { type: 'response_item', payload: { type: 'function_call', name: 'read_file', arguments: { path: '/opt/skills/deep-research/SKILL.md' } } },
      { type: 'response_item', payload: { type: 'agent_message', content: [{ type: 'output_text', text: 'done' }] } }
    )

    const evidence = new CodexHistoryAdapter().createRawEvidence(content)

    expect(evidence.lines).toEqual(content.split('\n'))
    expect(evidence.formatVersion).toBe('codex-jsonl-raw-v1')
    expect(evidence.skillHints).toEqual([
      expect.objectContaining({ name: 'openai-docs', tool: 'Skill', source: 'tool_call', location: expect.objectContaining({ line: 1 }) }),
      expect.objectContaining({ name: 'deep-research', tool: 'read_file', source: 'tool_call', location: expect.objectContaining({ line: 2 }) })
    ])
  })
})

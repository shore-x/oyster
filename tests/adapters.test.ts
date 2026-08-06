import { describe, expect, it } from 'vitest'
import {
  ClaudeHistoryAdapter,
  CodexHistoryAdapter,
  PiHistoryAdapter
} from '../src/main/discovery/adapters'

function jsonl(...records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n')
}

describe('Agent observation adapters', () => {
  it('preserves every Claude line and detects native, file-read, and injected Skill activations', () => {
    const content = jsonl(
      { type: 'user', message: { role: 'user', content: 'Please investigate.' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'deep-research' } }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/skills/imagegen/SKILL.md' } }] } },
      { type: 'user', message: { role: 'user', content: '<skill name="reviewer">instructions</skill>' } }
    )

    const observation = new ClaudeHistoryAdapter().createObservation(content)
    const evidence = observation.rawEvidence

    expect(evidence.lines).toEqual(content.split('\n'))
    expect(evidence.formatVersion).toBe('claude-jsonl-raw-v1')
    expect(evidence.skillHints).toEqual([
      expect.objectContaining({ name: 'deep-research', tool: 'Skill', source: 'tool_call', location: expect.objectContaining({ line: 2 }) }),
      expect.objectContaining({ name: 'imagegen', tool: 'Read', source: 'tool_call', location: expect.objectContaining({ line: 3 }) }),
      expect.objectContaining({ name: 'reviewer', source: 'runtime_injection', location: expect.objectContaining({ line: 4 }) })
    ])
    expect(observation.canonicalActivity.items.map((item) => item.kind)).toEqual([
      'user_message', 'tool_call', 'tool_call', 'user_message'
    ])
  })

  it('preserves Pi history and detects Skill calls without treating ordinary tools as Skills', () => {
    const content = jsonl(
      { type: 'message', role: 'assistant', content: [{ type: 'toolCall', name: 'Skill', arguments: { name: 'skill-creator' } }] },
      { type: 'message', role: 'assistant', content: [{ type: 'toolCall', name: 'search', arguments: { query: 'SKILL.md' } }] },
      { type: 'message', role: 'user', content: [{ type: 'text', text: '<skill><name>local-review</name></skill>' }] }
    )

    const observation = new PiHistoryAdapter().createObservation(content)
    const evidence = observation.rawEvidence

    expect(evidence.lines).toEqual(content.split('\n'))
    expect(evidence.formatVersion).toBe('pi-jsonl-raw-v1')
    expect(evidence.skillHints).toEqual([
      expect.objectContaining({ name: 'skill-creator', tool: 'Skill', source: 'tool_call', location: expect.objectContaining({ line: 1 }) }),
      expect.objectContaining({ name: 'local-review', source: 'runtime_injection', location: expect.objectContaining({ line: 3 }) })
    ])
    expect(observation.canonicalActivity.items.map((item) => item.kind)).toEqual([
      'tool_call', 'tool_call', 'user_message'
    ])
  })

  it('preserves Codex history and detects function calls and SKILL.md reads', () => {
    const content = jsonl(
      { type: 'response_item', payload: { type: 'function_call', name: 'Skill', arguments: { skill: 'openai-docs' } } },
      { type: 'response_item', payload: { type: 'function_call', name: 'read_file', arguments: { path: '/opt/skills/deep-research/SKILL.md' } } },
      { type: 'response_item', payload: { type: 'agent_message', content: [{ type: 'output_text', text: 'done' }] } }
    )

    const observation = new CodexHistoryAdapter().createObservation(content)
    const evidence = observation.rawEvidence

    expect(evidence.lines).toEqual(content.split('\n'))
    expect(evidence.formatVersion).toBe('codex-jsonl-raw-v1')
    expect(evidence.skillHints).toEqual([
      expect.objectContaining({ name: 'openai-docs', tool: 'Skill', source: 'tool_call', location: expect.objectContaining({ line: 1 }) }),
      expect.objectContaining({ name: 'deep-research', tool: 'read_file', source: 'tool_call', location: expect.objectContaining({ line: 2 }) })
    ])
    expect(observation.canonicalActivity.items.map((item) => item.kind)).toEqual([
      'tool_call', 'tool_call', 'assistant_message'
    ])
  })

  it('deduplicates Codex mirror events and exposes Base64 images as typed attachments', () => {
    const data = Buffer.from('image bytes').toString('base64')
    const content = jsonl(
      { type: 'event_msg', payload: { type: 'agent_reasoning', text: 'Inspect layout.' } },
      { type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Inspect layout.' }], encrypted_content: 'opaque' } },
      { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call-1', output: [{ type: 'input_image', image_url: `data:image/png;base64,${data}` }] } },
      { type: 'event_msg', payload: { type: 'token_count', info: { total_tokens: 10 } } }
    )

    const observation = new CodexHistoryAdapter().createObservation(content)

    expect(observation.rawEvidence.lines).toEqual(content.split('\n'))
    expect(observation.canonicalActivity.items.filter((item) => item.kind === 'reasoning')).toHaveLength(1)
    expect(observation.canonicalActivity.items.map((item) => item.content).join('\n')).not.toContain(data)
    expect(observation.canonicalActivity.attachments).toEqual([
      expect.objectContaining({ id: 'ATT000001', mimeType: 'image/png', byteLength: 11 })
    ])
    expect(observation.canonicalActivity.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'attachment', attachmentId: 'ATT000001' })
    ]))
  })

  it.each([
    ['Claude', new ClaudeHistoryAdapter()],
    ['Pi', new PiHistoryAdapter()],
    ['Codex', new CodexHistoryAdapter()]
  ])('keeps an unparseable %s source line as an opaque activity', (_name, adapter) => {
    const content = '{not valid json with potentially noisy payload}'
    const observation = adapter.createObservation(content)
    const [item] = observation.canonicalActivity.items

    expect(observation.rawEvidence.lines).toEqual([content])
    expect(item).toMatchObject({
      kind: 'unknown',
      rawRanges: [{
        start: { line: 1, offset: 0 },
        end: { line: 1, offset: content.length }
      }]
    })
    expect(item.content).toContain('JSONL record (opaque)')
    expect(item.content).toContain('read_evidence')
    expect(item.content).not.toContain(content)
  })
})

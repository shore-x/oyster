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
    expect(observation.canonicalActivity.formatVersion).toBe('claude-canonical-activity-v2')
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
    expect(observation.canonicalActivity.formatVersion).toBe('pi-canonical-activity-v2')
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

  it('omits model reasoning traces and exposes Base64 images as typed attachments', () => {
    const data = Buffer.from('image bytes').toString('base64')
    const content = jsonl(
      { type: 'event_msg', payload: { type: 'agent_reasoning', text: 'Inspect layout.' } },
      { type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Inspect layout.' }], encrypted_content: 'opaque' } },
      { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call-1', output: [{ type: 'input_image', image_url: `data:image/png;base64,${data}` }] } },
      { type: 'event_msg', payload: { type: 'token_count', info: { total_tokens: 10 } } }
    )

    const observation = new CodexHistoryAdapter().createObservation(content)

    expect(observation.rawEvidence.lines).toEqual(content.split('\n'))
    expect(observation.canonicalActivity.items.filter((item) => item.kind === 'reasoning')).toHaveLength(0)
    expect(observation.rawEvidence.lines.join('\n')).toContain('Inspect layout.')
    expect(observation.canonicalActivity.items.map((item) => item.content).join('\n')).not.toContain(data)
    expect(observation.canonicalActivity.attachments).toEqual([
      expect.objectContaining({ id: 'ATT000001', mimeType: 'image/png', byteLength: 11 })
    ])
    expect(observation.canonicalActivity.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'attachment', attachmentId: 'ATT000001' })
    ]))
  })

  it('keeps Codex dialogue readable while reducing protocol snapshots and wrapped tool payloads', () => {
    const runtimeInstructions = `runtime-only:${'i'.repeat(8_000)}`
    const compactedSummary = `model-summary:${'s'.repeat(8_000)}`
    const toolOutput = `useful beginning\n${'x'.repeat(8_000)}\nuseful ending`
    const userMessage = `User request remains complete. ${'u'.repeat(3_000)}`
    const content = jsonl(
      {
        type: 'session_meta',
        payload: { cwd: '/work/project', base_instructions: runtimeInstructions }
      },
      {
        type: 'compacted',
        payload: {
          message: compactedSummary,
          replacement_history: [
            { type: 'message', role: 'developer', content: runtimeInstructions },
            { type: 'message', role: 'user', content: 'Earlier user message.' }
          ],
          window_number: 2
        }
      },
      { type: 'event_msg', payload: { type: 'context_compacted' } },
      {
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'call-1',
          output: JSON.stringify({
            content: [{ type: 'text', text: toolOutput }],
            details: { internal_chat_message_metadata_passthrough: 'transport-only' }
          })
        }
      },
      {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: userMessage }] }
      },
      {
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Readable answer.' }] }
      }
    )

    const observation = new CodexHistoryAdapter().createObservation(content)
    const activityText = observation.canonicalActivity.items.map((item) => item.content).join('\n')
    const userActivity = observation.canonicalActivity.items.find((item) => item.kind === 'user_message')

    expect(observation.canonicalActivity.formatVersion).toBe('codex-canonical-activity-v3')
    expect(observation.rawEvidence.lines.join('\n')).toContain(runtimeInstructions)
    expect(userActivity?.content).toBe(userMessage)
    expect(activityText).toContain('Codex context compaction summary:')
    expect(activityText).not.toContain('useful beginning')
    expect(activityText).not.toContain('useful ending')
    expect(activityText).toContain('Tool result recorded without a matching visible call')
    expect(activityText).toContain('Readable answer.')
    expect(activityText).not.toContain(runtimeInstructions)
    expect(activityText).toContain(compactedSummary)
    expect(activityText).not.toContain('internal_chat_message_metadata_passthrough')
    expect(observation.canonicalActivity.items.some((item) => item.kind === 'unknown')).toBe(false)
  })

  it('keeps Codex runtime envelopes and detailed tool protocol out of the dialogue projection', () => {
    const hugeArguments = { command: `rg ${'internal-format '.repeat(2_000)}` }
    const content = jsonl(
      { type: 'session_meta', payload: { cwd: '/work/oyster', dynamic_tools: [{ name: 'exec' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /work/oyster\n\n<INSTRUCTIONS>runtime only</INSTRUCTIONS>' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>runtime only</environment_context>' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Investigate the real user problem.' }] } },
      { type: 'response_item', payload: { type: 'function_call', name: 'exec', call_id: 'call-1', arguments: JSON.stringify(hugeArguments) } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: JSON.stringify({ content: [{ type: 'text', text: 'protocol output '.repeat(2_000) }] }) } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Readable final answer.' }] } },
      { type: 'turn_context', payload: { cwd: '/work/oyster', approval_policy: 'never', sandbox_policy: { type: 'unrestricted' } } }
    )

    const observation = new CodexHistoryAdapter().createObservation(content)
    const activityText = observation.canonicalActivity.items.map((item) => item.content).join('\n')

    expect(observation.canonicalActivity.formatVersion).toBe('codex-canonical-activity-v3')
    expect(observation.canonicalActivity.items.map((item) => item.kind)).toEqual([
      'conversation_context', 'user_message', 'tool_call', 'assistant_message'
    ])
    expect(activityText).toContain('Investigate the real user problem.')
    expect(activityText).toContain('Readable final answer.')
    expect(activityText).toContain('Tool used: exec.')
    expect(activityText).not.toContain('AGENTS.md instructions')
    expect(activityText).not.toContain('environment_context')
    expect(activityText).not.toContain('internal-format')
    expect(activityText).not.toContain('protocol output')
    expect(activityText).not.toContain('approval_policy')
  })

  it('unwraps successful Codex subagent payloads and omits internal communication failures', () => {
    const content = jsonl(
      { type: 'inter_agent_communication_metadata', payload: { trigger_turn: false } },
      {
        type: 'response_item',
        payload: {
          type: 'agent_message',
          author: '/root/research',
          recipient: '/root',
          content: [{ type: 'input_text', text: 'Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/research\nPayload:\nReusable research result.' }]
        }
      },
      { type: 'inter_agent_communication_metadata', payload: { trigger_turn: false } },
      {
        type: 'response_item',
        payload: {
          type: 'agent_message',
          author: '/root/failed',
          recipient: '/root',
          content: [{ type: 'input_text', text: 'Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/failed\nPayload:\nAgent errored: transport failure.\n\nThis agent\'s turn failed.' }]
        }
      }
    )

    const observation = new CodexHistoryAdapter().createObservation(content)

    expect(observation.canonicalActivity.items).toEqual([
      expect.objectContaining({ kind: 'assistant_message', content: 'Reusable research result.' })
    ])
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
    expect(item.content).toContain('Raw source locator in the Task input')
    expect(item.content).not.toContain('read_evidence')
    expect(item.content).not.toContain(content)
  })
})

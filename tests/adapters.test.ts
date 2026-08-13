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
    expect(observation.canonicalActivity.formatVersion).toBe('claude-canonical-activity-v3')
    expect(evidence.skillHints).toEqual([
      expect.objectContaining({ name: 'deep-research', tool: 'Skill', source: 'tool_call', location: expect.objectContaining({ line: 2 }) }),
      expect.objectContaining({ name: 'imagegen', tool: 'Read', source: 'tool_call', location: expect.objectContaining({ line: 3 }) }),
      expect.objectContaining({ name: 'reviewer', source: 'runtime_injection', location: expect.objectContaining({ line: 4 }) })
    ])
    expect(observation.canonicalActivity.items.map((item) => item.kind)).toEqual([
      'user_message', 'tool_call', 'tool_call'
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
    expect(observation.canonicalActivity.formatVersion).toBe('pi-canonical-activity-v3')
    expect(evidence.skillHints).toEqual([
      expect.objectContaining({ name: 'skill-creator', tool: 'Skill', source: 'tool_call', location: expect.objectContaining({ line: 1 }) }),
      expect.objectContaining({ name: 'local-review', source: 'runtime_injection', location: expect.objectContaining({ line: 3 }) })
    ])
    expect(observation.canonicalActivity.items.map((item) => item.kind)).toEqual([
      'tool_call', 'tool_call'
    ])
  })

  it('projects the latest Claude active path before alternate source branches', () => {
    const content = jsonl(
      { type: 'user', uuid: 'root', parentUuid: null, message: { role: 'user', content: 'Root request.' } },
      { type: 'assistant', uuid: 'abandoned', parentUuid: 'root', message: { role: 'assistant', content: 'Abandoned answer.' } },
      { type: 'user', uuid: 'active-user', parentUuid: 'root', message: { role: 'user', content: 'Active correction.' } },
      { type: 'assistant', uuid: 'active-leaf', parentUuid: 'active-user', message: { role: 'assistant', content: 'Active answer.' } },
      { type: 'last-prompt', leafUuid: 'abandoned' },
      { type: 'last-prompt', leafUuid: 'active-leaf' },
      { type: 'assistant', uuid: 'sidechain', parentUuid: 'abandoned', isSidechain: true, message: { role: 'assistant', content: 'Embedded sidechain.' } }
    )

    const observation = new ClaudeHistoryAdapter().createObservation(content)
    const items = observation.canonicalActivity.items
    const alternateMarker = items.findIndex((item) => item.content.startsWith('Claude alternate'))

    expect(observation.rawEvidence.lines).toEqual(content.split('\n'))
    expect(alternateMarker).toBeGreaterThan(0)
    expect(items.slice(0, alternateMarker).map((item) => item.content).join('\n')).toContain('Active answer.')
    expect(items.slice(0, alternateMarker).map((item) => item.content).join('\n')).not.toContain('Abandoned answer.')
    expect(items.slice(alternateMarker).map((item) => item.content).join('\n')).toContain('Abandoned answer.')
    expect(items.slice(alternateMarker).map((item) => item.content).join('\n')).toContain('Embedded sidechain.')
  })

  it('uses the last non-sidechain Claude tree record when no leaf prompt exists', () => {
    const content = jsonl(
      { type: 'user', uuid: 'root', parentUuid: null, message: { role: 'user', content: 'Root.' } },
      { type: 'assistant', uuid: 'active', parentUuid: 'root', message: { role: 'assistant', content: 'Main leaf.' } },
      { type: 'assistant', uuid: 'sidechain', parentUuid: 'root', isSidechain: true, message: { role: 'assistant', content: 'Sidechain leaf.' } }
    )

    const items = new ClaudeHistoryAdapter().createObservation(content).canonicalActivity.items
    const alternateMarker = items.findIndex((item) => item.content.startsWith('Claude alternate'))

    expect(items.slice(0, alternateMarker).map((item) => item.content)).toContain('Main leaf.')
    expect(items.slice(0, alternateMarker).map((item) => item.content)).not.toContain('Sidechain leaf.')
    expect(items.slice(alternateMarker).map((item) => item.content)).toContain('Sidechain leaf.')
  })

  it('projects the Pi leaf path and retains tool results and abandoned branches', () => {
    const content = jsonl(
      { type: 'session', version: 3, id: 'session-id', cwd: '/work/project' },
      { type: 'message', id: 'root', parentId: null, message: { role: 'user', content: 'Root request.' } },
      { type: 'message', id: 'abandoned', parentId: 'root', message: { role: 'assistant', content: [{ type: 'text', text: 'Abandoned answer.' }] } },
      { type: 'message', id: 'active', parentId: 'root', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'pwd' } }] } },
      { type: 'message', id: 'leaf', parentId: 'active', message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', content: [{ type: 'text', text: '/work/project' }], isError: false } }
    )

    const observation = new PiHistoryAdapter().createObservation(content)
    const items = observation.canonicalActivity.items
    const alternateMarker = items.findIndex((item) => item.content.startsWith('Pi alternate'))
    const toolResult = items.find((item) => item.kind === 'tool_result')

    expect(observation.rawEvidence.lines).toEqual(content.split('\n'))
    expect(items[0]).toMatchObject({ kind: 'conversation_context' })
    expect(alternateMarker).toBeGreaterThan(0)
    expect(items.slice(0, alternateMarker).map((item) => item.content).join('\n')).not.toContain('Abandoned answer.')
    expect(items.slice(alternateMarker).map((item) => item.content).join('\n')).toContain('Abandoned answer.')
    expect(toolResult?.content).toContain('Tool: bash')
    expect(toolResult?.content).toContain('Call ID: call-1')
    expect(toolResult?.content).toContain('Status: success')
    expect(toolResult?.content).toContain('/work/project')
    expect(toolResult?.rawRanges).toEqual([{
      start: { line: 5, offset: 0 },
      end: { line: 5, offset: content.split('\n')[4].length }
    }])
  })

  it('does not misclassify Pi extended roles as user messages', () => {
    const content = jsonl(
      { type: 'session', version: 3, id: 'session-id', cwd: '/work/project' },
      { type: 'message', id: 'root', parentId: null, message: { role: 'user', content: 'Run the check.' } },
      { type: 'message', id: 'bash', parentId: 'root', message: { role: 'bashExecution', command: 'npm test', output: 'failed', exitCode: 1, cancelled: false, truncated: false } },
      { type: 'message', id: 'summary', parentId: 'bash', message: { role: 'compactionSummary', summary: 'The check failed.', tokensBefore: 20 } },
      { type: 'message', id: 'extension', parentId: 'summary', message: { role: 'custom-extension', content: 'Extension payload.' } },
      { type: 'message', id: 'failure', parentId: 'extension', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'Provider rejected request.' } }
    )

    const observation = new PiHistoryAdapter().createObservation(content)
    const items = observation.canonicalActivity.items

    expect(items.map((item) => item.kind)).toEqual([
      'conversation_context', 'user_message', 'tool_result', 'state', 'unknown', 'state'
    ])
    expect(items[2].content).toContain('Tool: bash')
    expect(items[2].content).toContain('Status: error')
    expect(items[3].content).toContain('compactionSummary')
    expect(items[4].content).toContain('custom-extension')
    expect(items[5].content).toContain('Provider rejected request.')
  })

  it('marks an invalid session tree before falling back to physical source order', () => {
    const content = jsonl(
      { type: 'session', version: 3, id: 'session-id', cwd: '/work/project' },
      { type: 'message', id: 'duplicate', parentId: null, message: { role: 'user', content: 'First physical record.' } },
      { type: 'message', id: 'duplicate', parentId: null, message: { role: 'assistant', content: 'Second physical record.' } }
    )

    const items = new PiHistoryAdapter().createObservation(content).canonicalActivity.items

    expect(items[0]).toMatchObject({
      kind: 'state',
      content: expect.stringContaining('could not be reconstructed')
    })
    expect(items.map((item) => item.content).join('\n')).toMatch(/First physical record\.[\s\S]*Second physical record\./)
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

  it('keeps Codex Skill runtime injection out of authored dialogue', () => {
    const content = jsonl(
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<skill><name>deep-research</name><instructions>runtime only</instructions></skill>' }] } },
      { type: 'event_msg', payload: { type: 'user_message', message: '<skill name="reviewer">runtime only</skill>' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Authored request.' }] } }
    )

    const observation = new CodexHistoryAdapter().createObservation(content)

    expect(observation.rawEvidence.skillHints).toEqual([
      expect.objectContaining({ name: 'deep-research', source: 'runtime_injection', location: expect.objectContaining({ line: 1 }) }),
      expect.objectContaining({ name: 'reviewer', source: 'runtime_injection', location: expect.objectContaining({ line: 2 }) })
    ])
    expect(observation.canonicalActivity.items).toEqual([
      expect.objectContaining({ kind: 'user_message', content: 'Authored request.' })
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

    expect(observation.canonicalActivity.formatVersion).toBe('codex-canonical-activity-v4')
    expect(observation.rawEvidence.lines.join('\n')).toContain(runtimeInstructions)
    expect(userActivity?.content).toBe(userMessage)
    expect(activityText).toContain('Codex context compaction summary:')
    expect(activityText).toContain('useful beginning')
    expect(activityText).toContain('useful ending')
    expect(activityText).toContain('Call ID: call-1')
    expect(activityText).toContain('Canonical Activity omitted')
    expect(activityText).toContain('Readable answer.')
    expect(activityText).not.toContain(runtimeInstructions)
    expect(activityText).toContain(compactedSummary)
    expect(activityText).not.toContain('internal_chat_message_metadata_passthrough')
    expect(observation.canonicalActivity.items.some((item) => item.kind === 'unknown')).toBe(false)
  })

  it('keeps Codex runtime envelopes out of dialogue while retaining compact tool evidence', () => {
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

    expect(observation.canonicalActivity.formatVersion).toBe('codex-canonical-activity-v4')
    expect(observation.canonicalActivity.items.map((item) => item.kind)).toEqual([
      'conversation_context', 'user_message', 'tool_call', 'tool_result', 'assistant_message'
    ])
    expect(activityText).toContain('Investigate the real user problem.')
    expect(activityText).toContain('Readable final answer.')
    expect(activityText).toContain('Tool: exec')
    expect(activityText).toContain('Call ID: call-1')
    expect(activityText).toContain('internal-format')
    expect(activityText).toContain('protocol output')
    expect(activityText).toContain('Canonical Activity omitted')
    expect(activityText).not.toContain('AGENTS.md instructions')
    expect(activityText).not.toContain('environment_context')
    expect(activityText).not.toContain('approval_policy')
  })

  it('unwraps Codex subagent payloads and retains failed subagent evidence', () => {
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
      expect.objectContaining({ kind: 'assistant_message', content: 'Reusable research result.' }),
      expect.objectContaining({ kind: 'assistant_message', content: expect.stringContaining('Agent errored: transport failure.') })
    ])
  })

  it('retains Codex tool failures, important end events, and unknown records with exact ranges', () => {
    const imageData = Buffer.from('generated image').toString('base64')
    const records = [
      { type: 'response_item', payload: { type: 'custom_tool_call', namespace: 'functions', name: 'exec', call_id: 'call-1', input: '{"command":"false"}', status: 'completed' } },
      { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call-1', output: { message: 'command failed' }, is_error: true } },
      { type: 'event_msg', payload: { type: 'patch_apply_end', call_id: 'patch-1', success: false, status: 'failed', stdout: '', stderr: 'patch rejected', changes: {} } },
      { type: 'event_msg', payload: { type: 'mcp_tool_call_end', call_id: 'mcp-1', duration: 12, invocation: { server: 'demo', tool: 'read' }, result: { Err: { message: 'permission denied' } } } },
      { type: 'event_msg', payload: { type: 'image_generation_end', call_id: 'image-1', status: 'completed', saved_path: '/tmp/generated.png', result: imageData } },
      { type: 'event_msg', payload: { type: 'task_complete', error: 'model failed' } },
      { type: 'event_msg', payload: { type: 'turn_aborted', reason: 'interrupted' } },
      { type: 'event_msg', payload: { type: 'thread_rolled_back', num_turns: 1 } },
      { type: 'response_item', payload: { type: 'future_response', detail: 'retain response' } },
      { type: 'event_msg', payload: { type: 'future_event', detail: 'retain event' } },
      { type: 'event_msg', payload: { type: 'sub_agent_activity', kind: 'started', agent_id: 'agent-1' } },
      { type: 'event_msg', payload: { type: 'sub_agent_activity', kind: 'interacted', agent_id: 'agent-1' } },
      { type: 'event_msg', payload: { type: 'sub_agent_activity', kind: 'interrupted', agent_id: 'agent-1', reason: 'parent stopped' } },
      { type: 'event_msg', payload: { type: 'sub_agent_activity', kind: 'future_kind', agent_id: 'agent-2' } },
      { type: 'event_msg', payload: { type: 'thread_settings_applied', detail: 'runtime noise' } }
    ]
    const content = jsonl(...records)
    const sourceLines = content.split('\n')

    const observation = new CodexHistoryAdapter().createObservation(content)
    const items = observation.canonicalActivity.items
    const activityText = items.map((item) => item.content).join('\n')
    const toolCall = items.find((item) => item.kind === 'tool_call')!
    const callResult = items.find((item) => item.kind === 'tool_result' && item.content.includes('command failed'))!
    const taskFailure = items.find((item) => item.content.startsWith('Codex task failed:'))!
    const unknownResponse = items.find((item) => item.content.includes('future_response'))!
    const unknownEvent = items.find((item) => item.content.includes('future_event'))!
    const interruptedSubagent = items.find((item) => item.content.startsWith('Codex subagent activity was interrupted:'))!
    const unknownSubagent = items.find((item) => item.content.includes('future_kind'))!

    expect(observation.rawEvidence.lines).toEqual(sourceLines)
    expect(toolCall.content).toContain('Tool: functions.exec')
    expect(toolCall.content).toContain('Arguments:\n{\n  "command": "false"\n}')
    expect(callResult.content).toContain('Tool: functions.exec')
    expect(callResult.content).toContain('Status: error')
    expect(activityText).toContain('patch rejected')
    expect(activityText).toContain('permission denied')
    expect(activityText).toContain('Codex event (turn_aborted)')
    expect(activityText).toContain('Codex event (thread_rolled_back)')
    expect(activityText).toContain('Unrecognized Codex response item (future_response)')
    expect(activityText).toContain('Unrecognized Codex event (future_event)')
    expect(activityText).toContain('Codex subagent activity was interrupted:')
    expect(activityText).toContain('Unrecognized Codex subagent activity (future_kind)')
    expect(activityText).not.toContain('"kind": "started"')
    expect(activityText).not.toContain('"kind": "interacted"')
    expect(activityText).not.toContain('runtime noise')
    expect(activityText).not.toContain(imageData)
    expect(observation.canonicalActivity.attachments).toEqual([
      expect.objectContaining({ mimeType: 'image/png', byteLength: 15 })
    ])
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'tool_result', content: expect.stringContaining('Codex tool event: patch_apply_end') }),
      expect.objectContaining({ kind: 'tool_result', content: expect.stringContaining('Codex tool event: mcp_tool_call_end') }),
      expect.objectContaining({ kind: 'tool_result', content: expect.stringContaining('Codex tool event: image_generation_end') }),
      expect.objectContaining({ kind: 'attachment', attachmentId: 'ATT000001' })
    ]))
    expect(toolCall.rawRanges).toEqual([{
      start: { line: 1, offset: 0 },
      end: { line: 1, offset: sourceLines[0].length }
    }])
    expect(callResult.rawRanges).toEqual([{
      start: { line: 2, offset: 0 },
      end: { line: 2, offset: sourceLines[1].length }
    }])
    expect(taskFailure.rawRanges[0]).toEqual({
      start: { line: 6, offset: 0 },
      end: { line: 6, offset: sourceLines[5].length }
    })
    expect(unknownResponse.rawRanges[0]).toEqual({
      start: { line: 9, offset: 0 },
      end: { line: 9, offset: sourceLines[8].length }
    })
    expect(unknownEvent.rawRanges[0]).toEqual({
      start: { line: 10, offset: 0 },
      end: { line: 10, offset: sourceLines[9].length }
    })
    expect(interruptedSubagent.rawRanges[0]).toEqual({
      start: { line: 13, offset: 0 },
      end: { line: 13, offset: sourceLines[12].length }
    })
    expect(unknownSubagent.rawRanges[0]).toEqual({
      start: { line: 14, offset: 0 },
      end: { line: 14, offset: sourceLines[13].length }
    })
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

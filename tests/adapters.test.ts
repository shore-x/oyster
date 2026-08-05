import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ClaudeHistoryAdapter,
  CodexHistoryAdapter,
  PiHistoryAdapter
} from '../src/main/discovery/adapters'
import type { AgentHistoryAdapter, DetectionContext, ScanEntry } from '../src/main/discovery/model'
import type { SourceRecord } from '../src/shared/discovery'

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures')

async function scan(
  adapter: AgentHistoryAdapter,
  rootPath: string,
  context?: DetectionContext
): Promise<ScanEntry[]> {
  const entries: ScanEntry[] = []
  for await (const entry of adapter.scan(rootPath, new AbortController().signal, context)) entries.push(entry)
  return entries
}

describe('agent history adapters', () => {
  it.each([
    {
      adapter: new ClaudeHistoryAdapter(),
      formatVersion: 'claude-jsonl-v3',
      context: 'Claude · record=assistant · role=assistant · blocks=text',
      record: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `Claude ${'😀'.repeat(6_000)}` }] } }
    },
    {
      adapter: new PiHistoryAdapter(),
      formatVersion: 'pi-jsonl-v3',
      context: 'Pi · record=message · role=assistant',
      record: { type: 'message', message: { role: 'assistant', content: `Pi ${'😀'.repeat(6_000)}` } }
    }
  ])('lets the $formatVersion adapter deterministically frame a long JSONL record', ({
    adapter,
    formatVersion,
    context,
    record
  }) => {
    const rawLine = JSON.stringify(record)
    const view = adapter.createObservationView(rawLine)

    expect(view.formatVersion).toBe(formatVersion)
    expect(view.rawLines).toEqual([rawLine])
    expect(view.units.length).toBeGreaterThan(1)
    expect(view.units.map((unit) => unit.content).join('')).toBe(rawLine)
    expect(view.units.every((unit) => (
      unit.lineNumber === 1 && Buffer.byteLength(unit.content, 'utf8') <= 3 * 1_024
    ))).toBe(true)
    expect(view.units.every((unit) => unit.recordContext === context)).toBe(true)
    expect(view.units.every((unit) => Buffer.byteLength(unit.recordContext ?? '', 'utf8') <= 512)).toBe(true)
    expect(view.units[0].startCharacter).toBe(0)
    expect(view.units.at(-1)?.endCharacter).toBe(rawLine.length)
    expect(view.units.every((unit, index) => (
      index === 0 || unit.startCharacter === view.units[index - 1].endCharacter
    ))).toBe(true)
    for (const unit of view.units) {
      const first = unit.content.charCodeAt(0)
      const last = unit.content.charCodeAt(unit.content.length - 1)
      expect(first < 0xdc00 || first > 0xdfff).toBe(true)
      expect(last < 0xd800 || last > 0xdbff).toBe(true)
    }
  })

  it('marks Claude Skill tools and SKILL.md reads without marking routine reads', () => {
    const records = [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'deep-research' } }]
        }
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/opt/skills/code-review/SKILL.md' } }]
        }
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/work/README.md' } }]
        }
      }
    ]
    const view = new ClaudeHistoryAdapter().createObservationView(
      records.map((record) => JSON.stringify(record)).join('\n')
    )

    expect(view.units.find((unit) => unit.lineNumber === 1)?.recordContext)
      .toContain('skill_hint=deep-research')
    expect(view.units.find((unit) => unit.lineNumber === 2)?.recordContext)
      .toContain('skill_hint=code-review')
    expect(view.units.find((unit) => unit.lineNumber === 3)?.recordContext)
      .not.toContain('skill_hint=')
  })

  it('marks Pi Skill expansion and SKILL.md reads without marking routine reads', () => {
    const records = [
      {
        type: 'message',
        message: {
          role: 'user',
          content: '<skill name="release-review">instructions</skill>'
        }
      },
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{
            type: 'toolCall',
            name: 'read',
            arguments: { path: '/opt/skills/pi-helper/SKILL.md' }
          }]
        }
      },
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', name: 'read', arguments: { path: '/work/README.md' } }]
        }
      }
    ]
    const view = new PiHistoryAdapter().createObservationView(
      records.map((record) => JSON.stringify(record)).join('\n')
    )

    expect(view.units.find((unit) => unit.lineNumber === 1)?.recordContext)
      .toContain('skill_hint=release-review')
    expect(view.units.find((unit) => unit.lineNumber === 2)?.recordContext)
      .toContain('skill_hint=pi-helper')
    expect(view.units.find((unit) => unit.lineNumber === 3)?.recordContext)
      .not.toContain('skill_hint=')
  })

  it('keeps JSON escape sequences intact at adapter-owned long-record boundaries', () => {
    const rawLine = JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `${'a'.repeat(3_050)}\\n${'b'.repeat(4_000)}` }]
      }
    })
    const view = new CodexHistoryAdapter().createObservationView(rawLine)

    expect(view.units.map((unit) => unit.content).join('')).toBe(rawLine)
    for (const unit of view.units.slice(0, -1)) {
      let trailingBackslashes = 0
      for (let index = unit.content.length - 1; index >= 0 && unit.content[index] === '\\'; index--) {
        trailingBackslashes++
      }
      expect(trailingBackslashes % 2).toBe(0)
      expect(unit.content).not.toMatch(/\\u[0-9a-f]{0,3}$/i)
    }
    expect(view.units.every((unit) => (
      unit.recordContext === 'Codex · record=response_item · payload=message · role=user · blocks=input_text'
    ))).toBe(true)
  })

  it('creates a selective Codex preprocessing view while retaining complete raw evidence', () => {
    const records = [
      { type: 'session_meta', payload: { cwd: '/work/oyster', base_instructions: `runtime ${'x'.repeat(8_000)}` } },
      { type: 'turn_context', payload: { cwd: '/work/oyster', collaboration_mode: 'default' } },
      { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'runtime instructions' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /work/oyster\n\n<INSTRUCTIONS>\nRuntime rules\n</INSTRUCTIONS>' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/work/oyster</cwd>\n</environment_context>' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Keep the rejection and its reason.' }] } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'duplicate user representation' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I will preserve it.' }] } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'duplicate assistant representation' } },
      { type: 'response_item', payload: { type: 'reasoning', summary: ['private reasoning'] } },
      { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'call-1', input: JSON.stringify({ cmd: `rg ${'q'.repeat(4_000)}` }) } },
      { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call-1', output: [{ type: 'input_text', text: 'exit_code=0' }, { type: 'input_text', text: `begin ${'z'.repeat(12_000)} end` }] } },
      { type: 'response_item', payload: { type: 'agent_message', author: '/root/researcher', recipient: '/root', content: [{ type: 'input_text', text: 'The delegated research found the relevant decision.' }, { type: 'encrypted_content', data: 'not-for-preprocessing' }] } },
      { type: 'response_item', payload: { type: 'web_search_call', query: 'routine lookup' } },
      { type: 'event_msg', payload: { type: 'sub_agent_activity', kind: 'interacted', agent_path: '/root/researcher' } },
      { type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'turn-1', reason: 'interrupted by the user' } },
      { type: 'future_record', payload: { type: 'new_event', opaque: `detail ${'y'.repeat(5_000)}` } },
      { type: 'turn_context', payload: { cwd: '/work/oyster/service', approval_policy: 'never', summary: `runtime ${'s'.repeat(8_000)}` } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'The service directory changes the meaning of Ledger.' }] } },
      { type: 'compacted', payload: { message: 'duplicate compacted history' } },
      { type: 'world_state', payload: { full: true, state: 'runtime state' } }
    ]
    const rawLines = records.map((record) => JSON.stringify(record))
    const view = new CodexHistoryAdapter().createObservationView(rawLines.join('\n'))

    expect(view.formatVersion).toBe('codex-jsonl-v5')
    expect(view.rawLines).toEqual(rawLines)
    expect([...new Set(view.units.map((unit) => unit.lineNumber))]).toEqual([1, 6, 8, 18, 19])

    const initialContext = view.units.find((unit) => unit.lineNumber === 1)!
    expect(JSON.parse(initialContext.modelContent!)).toEqual({
      kind: 'session_context',
      workingDirectory: '/work/oyster'
    })
    expect(initialContext.modelContent).not.toContain('base_instructions')

    const user = view.units.find((unit) => unit.lineNumber === 6)!
    expect(user.modelContent).toBeUndefined()
    expect(user.content).toBe(rawLines[5])
    expect(user.recordContext).toBe('Codex · record=response_item · payload=message · role=user · blocks=input_text')

    const changedContext = view.units.find((unit) => unit.lineNumber === 18)!
    expect(JSON.parse(changedContext.modelContent!)).toEqual({
      kind: 'session_context',
      workingDirectory: '/work/oyster/service'
    })
    expect(changedContext.modelContent).not.toContain('approval_policy')
    expect(changedContext.modelContent).not.toContain('summary')

    expect(view.units.find((unit) => unit.lineNumber === 19)?.content).toBe(rawLines[18])
    expect(view.units.some((unit) => unit.content.includes('Runtime rules'))).toBe(false)
    expect(view.units.some((unit) => unit.content.includes('<environment_context>'))).toBe(false)
    expect(view.units.some((unit) => unit.content.includes('tool_call'))).toBe(false)
    expect(view.units.some((unit) => unit.content.includes('subagent_message'))).toBe(false)
    expect(view.units.some((unit) => unit.content.includes('web_search_call'))).toBe(false)
    expect(view.units.some((unit) => unit.content.includes('turn_aborted'))).toBe(false)
  })

  it('keeps only Skill-related Codex runtime injections and tool calls as compact hints', () => {
    const records = [
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: '<skill><name>openai-docs</name><instructions>runtime detail</instructions></skill>'
          }]
        }
      },
      {
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call-skill',
          input: JSON.stringify({ cmd: 'sed -n 1,200p /opt/skills/deep-research/SKILL.md' })
        }
      },
      {
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call-routine',
          input: JSON.stringify({ cmd: 'rg TODO src' })
        }
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: 'Review the inline <skill><name>example</name></skill> representation.'
          }]
        }
      }
    ]
    const rawLines = records.map((record) => JSON.stringify(record))
    const view = new CodexHistoryAdapter().createObservationView(rawLines.join('\n'))

    expect(view.rawLines).toEqual(rawLines)
    expect([...new Set(view.units.map((unit) => unit.lineNumber))]).toEqual([1, 2, 4])
    expect(JSON.parse(view.units.find((unit) => unit.lineNumber === 1)?.modelContent ?? '')).toEqual({
      kind: 'skill_activation_hint',
      source: 'runtime_injection',
      name: 'openai-docs'
    })
    expect(JSON.parse(view.units.find((unit) => unit.lineNumber === 2)?.modelContent ?? '')).toEqual({
      kind: 'skill_activation_hint',
      source: 'tool_call',
      name: 'deep-research',
      tool: 'exec'
    })
    expect(view.units.find((unit) => unit.lineNumber === 1)?.modelContent)
      .not.toContain('runtime detail')
    expect(view.units.some((unit) => unit.lineNumber === 3)).toBe(false)
    expect(view.units.find((unit) => unit.lineNumber === 4)?.content).toBe(rawLines[3])
    expect(view.units.find((unit) => unit.lineNumber === 4)?.modelContent).toBeUndefined()
  })

  it('keeps long canonical Codex messages lossless and byte-bounded', () => {
    const rawLine = JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `${'a'.repeat(3_050)}\\n${'😀'.repeat(4_000)}` }]
      }
    })
    const view = new CodexHistoryAdapter().createObservationView(rawLine)

    expect(view.formatVersion).toBe('codex-jsonl-v5')
    expect(view.units.length).toBeGreaterThan(1)
    expect(view.units.map((unit) => unit.content).join('')).toBe(rawLine)
    expect(view.units.every((unit) => Buffer.byteLength(unit.content, 'utf8') <= 3 * 1_024)).toBe(true)
    expect(view.units.every((unit) => unit.modelContent === undefined)).toBe(true)
    expect(view.units.every((unit) => (
      unit.recordContext === 'Codex · record=response_item · payload=message · role=user · blocks=input_text'
    ))).toBe(true)
  })

  it('uses Codex event messages only when a canonical message channel is unavailable for that role', () => {
    const records = [
      { type: 'event_msg', payload: { type: 'user_message', message: 'duplicate user event' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'event-only assistant reply', phase: 'final_answer' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'canonical user message' }] } }
    ]
    const rawLines = records.map((record) => JSON.stringify(record))
    const view = new CodexHistoryAdapter().createObservationView(rawLines.join('\n'))

    expect([...new Set(view.units.map((unit) => unit.lineNumber))]).toEqual([2, 3])
    expect(view.units.filter((unit) => unit.lineNumber === 2).map((unit) => unit.content).join(''))
      .toBe(rawLines[1])
    expect(view.units.filter((unit) => unit.lineNumber === 3).map((unit) => unit.content).join(''))
      .toBe(rawLines[2])
  })

  it('extracts Claude sessions and counts unrecognized JSONL files', async () => {
    const entries = await scan(new ClaudeHistoryAdapter(), resolve(fixtureRoot, 'claude/projects'))
    const session = entries.find(
      (entry) => entry.kind === 'record' && entry.candidate.kind === 'conversation'
    )
    expect(session?.kind === 'record' && session.candidate.externalId).toBe('claude-session-a')
    expect(session?.kind === 'record' && session.candidate.projectPath).toBe('/work/demo')
    expect(entries.filter((entry) => entry.kind === 'invalid')).toHaveLength(1)
  })

  it('keeps Claude global instructions with the selected profile', async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), 'oyster-claude-profile-'))
    try {
      const defaultRoot = join(homeDirectory, '.claude')
      const selectedRoot = join(homeDirectory, '.claude-work')
      const historyRoot = join(selectedRoot, 'projects', 'demo')
      await mkdir(defaultRoot, { recursive: true })
      await mkdir(historyRoot, { recursive: true })
      await writeFile(join(defaultRoot, 'CLAUDE.md'), '# Default profile\n')
      await writeFile(join(selectedRoot, 'CLAUDE.md'), '# Selected profile\n')
      await writeFile(join(historyRoot, 'one.jsonl'), '{"sessionId":"claude-one"}\n')

      const entries = await scan(new ClaudeHistoryAdapter(), join(selectedRoot, 'projects'), {
        homeDirectory,
        environment: {},
        pathEntries: []
      })
      const instructionPaths = entries
        .filter((entry) => entry.kind === 'record' && entry.candidate.kind === 'human_instruction')
        .map((entry) => entry.kind === 'record' && entry.candidate.sourcePath)
      expect(instructionPaths).toContain(join(selectedRoot, 'CLAUDE.md'))
      expect(instructionPaths).not.toContain(join(defaultRoot, 'CLAUDE.md'))
    } finally {
      await rm(homeDirectory, { recursive: true, force: true })
    }
  })

  it('reads the Pi session header', async () => {
    const entries = await scan(new PiHistoryAdapter(), resolve(fixtureRoot, 'pi/sessions'))
    const session = entries.find(
      (entry) => entry.kind === 'record' && entry.candidate.kind === 'conversation'
    )
    expect(session?.kind === 'record' && session.candidate.externalId).toBe('pi-session-a')
  })

  it('honors the Pi sessionDir setting without treating the whole settings file as history', async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), 'oyster-pi-settings-'))
    try {
      const agentRoot = join(homeDirectory, '.pi', 'agent')
      const customRoot = join(homeDirectory, 'pi-history')
      await mkdir(customRoot, { recursive: true })
      await mkdir(agentRoot, { recursive: true })
      await writeFile(join(agentRoot, 'settings.json'), JSON.stringify({ sessionDir: customRoot, apiKey: 'ignored' }))
      const detection = await new PiHistoryAdapter().detect({ homeDirectory, environment: {}, pathEntries: [] })
      expect(detection).toMatchObject({ rootPath: customRoot, found: true })
    } finally {
      await rm(homeDirectory, { recursive: true, force: true })
    }
  })

  it('discovers Pi human instructions and excludes unrelated generated memory', async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), 'oyster-pi-instructions-'))
    try {
      const agentRoot = join(homeDirectory, '.pi', 'agent')
      const sessionRoot = join(agentRoot, 'sessions')
      const projectRoot = join(homeDirectory, 'project')
      await mkdir(sessionRoot, { recursive: true })
      await mkdir(join(agentRoot, 'memory'), { recursive: true })
      await mkdir(join(projectRoot, '.pi'), { recursive: true })
      await writeFile(
        join(sessionRoot, 'one.jsonl'),
        `${JSON.stringify({ type: 'session', id: 'pi-one', cwd: projectRoot })}\n`
      )
      await writeFile(join(agentRoot, 'AGENTS.md'), '# Global instructions\n')
      await writeFile(join(agentRoot, 'SYSTEM.md'), '# Global system prompt\n')
      await writeFile(join(agentRoot, 'memory', 'MEMORY.md'), '# Generated memory\n')
      await writeFile(join(projectRoot, 'AGENTS.md'), '# Project instructions\n')
      await writeFile(join(projectRoot, '.pi', 'APPEND_SYSTEM.md'), '# Project system suffix\n')

      const entries = await scan(new PiHistoryAdapter(), sessionRoot, {
        homeDirectory,
        environment: {},
        pathEntries: []
      })
      const instructionPaths = entries
        .filter((entry) => entry.kind === 'record' && entry.candidate.kind === 'human_instruction')
        .map((entry) => entry.kind === 'record' && entry.candidate.sourcePath)
      expect(instructionPaths).toEqual(
        expect.arrayContaining([
          join(agentRoot, 'AGENTS.md'),
          join(agentRoot, 'SYSTEM.md'),
          join(projectRoot, 'AGENTS.md'),
          join(projectRoot, '.pi', 'APPEND_SYSTEM.md')
        ])
      )
      expect(instructionPaths).not.toContain(join(agentRoot, 'memory', 'MEMORY.md'))
    } finally {
      await rm(homeDirectory, { recursive: true, force: true })
    }
  })

  it('prefers active Codex sessions over archived duplicates', async () => {
    const entries = await scan(new CodexHistoryAdapter(), resolve(fixtureRoot, 'codex'))
    const sessions = entries.filter(
      (entry) => entry.kind === 'record' && entry.candidate.kind === 'conversation'
    )
    expect(sessions).toHaveLength(2)
    expect(sessions.map((entry) => entry.kind === 'record' && entry.candidate.externalId)).toEqual([
      'codex-session-a',
      'codex-session-b'
    ])
    expect(sessions[0].kind === 'record' && sessions[0].candidate.relativePath).toContain('sessions/')
  })

  it('applies Codex instruction precedence without importing local memories', async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), 'oyster-codex-instructions-'))
    try {
      const codexRoot = join(homeDirectory, '.codex')
      const sessionRoot = join(codexRoot, 'sessions', '2026', '07', '22')
      const projectRoot = join(homeDirectory, 'project')
      const workingDirectory = join(projectRoot, 'service')
      await mkdir(sessionRoot, { recursive: true })
      await mkdir(join(codexRoot, 'memories'), { recursive: true })
      await mkdir(join(projectRoot, '.git'), { recursive: true })
      await mkdir(workingDirectory, { recursive: true })
      await writeFile(
        join(sessionRoot, 'rollout.jsonl'),
        `${JSON.stringify({ type: 'session_meta', payload: { id: 'codex-one', cwd: workingDirectory } })}\n`
      )
      await writeFile(join(codexRoot, 'AGENTS.md'), '# Ignored global instructions\n')
      await writeFile(join(codexRoot, 'AGENTS.override.md'), '# Global override\n')
      await writeFile(join(codexRoot, 'memories', 'MEMORY.md'), '# Generated memory\n')
      await writeFile(join(projectRoot, 'AGENTS.md'), '# Project instructions\n')
      await writeFile(join(workingDirectory, 'AGENTS.md'), '# Ignored nested instructions\n')
      await writeFile(join(workingDirectory, 'AGENTS.override.md'), '# Nested override\n')

      const entries = await scan(new CodexHistoryAdapter(), codexRoot)
      const instructionPaths = entries
        .filter((entry) => entry.kind === 'record' && entry.candidate.kind === 'human_instruction')
        .map((entry) => entry.kind === 'record' && entry.candidate.sourcePath)
      expect(instructionPaths).toEqual([
        join(codexRoot, 'AGENTS.override.md'),
        join(projectRoot, 'AGENTS.md'),
        join(workingDirectory, 'AGENTS.override.md')
      ])
      expect(instructionPaths).not.toContain(join(codexRoot, 'memories', 'MEMORY.md'))
    } finally {
      await rm(homeDirectory, { recursive: true, force: true })
    }
  })

  it('rejects paths outside the configured history root', () => {
    const adapter = new CodexHistoryAdapter()
    const record = { kind: 'conversation', relativePath: '../../etc/passwd' } as SourceRecord
    expect(() => adapter.resolveRecordPath('/safe/root', record)).toThrow(/escapes/)
  })
})

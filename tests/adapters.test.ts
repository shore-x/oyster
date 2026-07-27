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
import type { HistoryArtifact } from '../src/shared/discovery'

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
      formatVersion: 'claude-jsonl-v2',
      context: 'Claude · record=assistant · role=assistant · blocks=text',
      record: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `Claude ${'😀'.repeat(6_000)}` }] } }
    },
    {
      adapter: new PiHistoryAdapter(),
      formatVersion: 'pi-jsonl-v2',
      context: 'Pi · record=message · role=assistant',
      record: { type: 'message', message: { role: 'assistant', content: `Pi ${'😀'.repeat(6_000)}` } }
    },
    {
      adapter: new CodexHistoryAdapter(),
      formatVersion: 'codex-jsonl-v2',
      context: 'Codex · record=response_item · payload=function_call_output',
      record: { type: 'response_item', payload: { type: 'function_call_output', output: `Codex ${'😀'.repeat(6_000)}` } }
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

  it('extracts Claude sessions and counts unrecognized JSONL files', async () => {
    const entries = await scan(new ClaudeHistoryAdapter(), resolve(fixtureRoot, 'claude/projects'))
    const session = entries.find(
      (entry) => entry.kind === 'artifact' && entry.candidate.kind === 'conversation'
    )
    expect(session?.kind === 'artifact' && session.candidate.externalId).toBe('claude-session-a')
    expect(session?.kind === 'artifact' && session.candidate.projectPath).toBe('/work/demo')
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
        .filter((entry) => entry.kind === 'artifact' && entry.candidate.kind === 'human_instruction')
        .map((entry) => entry.kind === 'artifact' && entry.candidate.sourcePath)
      expect(instructionPaths).toContain(join(selectedRoot, 'CLAUDE.md'))
      expect(instructionPaths).not.toContain(join(defaultRoot, 'CLAUDE.md'))
    } finally {
      await rm(homeDirectory, { recursive: true, force: true })
    }
  })

  it('reads the Pi session header', async () => {
    const entries = await scan(new PiHistoryAdapter(), resolve(fixtureRoot, 'pi/sessions'))
    const session = entries.find(
      (entry) => entry.kind === 'artifact' && entry.candidate.kind === 'conversation'
    )
    expect(session?.kind === 'artifact' && session.candidate.externalId).toBe('pi-session-a')
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
        .filter((entry) => entry.kind === 'artifact' && entry.candidate.kind === 'human_instruction')
        .map((entry) => entry.kind === 'artifact' && entry.candidate.sourcePath)
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
      (entry) => entry.kind === 'artifact' && entry.candidate.kind === 'conversation'
    )
    expect(sessions).toHaveLength(2)
    expect(sessions.map((entry) => entry.kind === 'artifact' && entry.candidate.externalId)).toEqual([
      'codex-session-a',
      'codex-session-b'
    ])
    expect(sessions[0].kind === 'artifact' && sessions[0].candidate.relativePath).toContain('sessions/')
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
        .filter((entry) => entry.kind === 'artifact' && entry.candidate.kind === 'human_instruction')
        .map((entry) => entry.kind === 'artifact' && entry.candidate.sourcePath)
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
    const artifact = { kind: 'conversation', relativePath: '../../etc/passwd' } as HistoryArtifact
    expect(() => adapter.resolveArtifactPath('/safe/root', artifact)).toThrow(/escapes/)
  })
})

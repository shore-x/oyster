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
import type { AgentHistoryAdapter, ScanEntry } from '../src/main/discovery/model'

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures')

async function scan(adapter: AgentHistoryAdapter, rootPath: string): Promise<ScanEntry[]> {
  const entries: ScanEntry[] = []
  for await (const entry of adapter.scan(rootPath, new AbortController().signal)) entries.push(entry)
  return entries
}

describe('agent history adapters', () => {
  it('extracts Claude sessions and counts unrecognized JSONL files', async () => {
    const entries = await scan(new ClaudeHistoryAdapter(), resolve(fixtureRoot, 'claude/projects'))
    const session = entries.find((entry) => entry.kind === 'session')
    expect(entries).toHaveLength(2)
    expect(session?.kind === 'session' && session.candidate.externalId).toBe('claude-session-a')
    expect(session?.kind === 'session' && session.candidate.projectPath).toBe('/work/demo')
    expect(entries.filter((entry) => entry.kind === 'invalid')).toHaveLength(1)
  })

  it('reads the Pi session header', async () => {
    const entries = await scan(new PiHistoryAdapter(), resolve(fixtureRoot, 'pi/sessions'))
    expect(entries).toHaveLength(1)
    expect(entries[0].kind === 'session' && entries[0].candidate.externalId).toBe('pi-session-a')
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

  it('prefers active Codex sessions over archived duplicates', async () => {
    const entries = await scan(new CodexHistoryAdapter(), resolve(fixtureRoot, 'codex'))
    const sessions = entries.filter((entry) => entry.kind === 'session')
    expect(sessions).toHaveLength(2)
    expect(sessions.map((entry) => entry.kind === 'session' && entry.candidate.externalId)).toEqual([
      'codex-session-a',
      'codex-session-b'
    ])
    expect(sessions[0].kind === 'session' && sessions[0].candidate.relativePath).toContain('sessions/')
  })

  it('rejects paths outside the configured history root', () => {
    const adapter = new CodexHistoryAdapter()
    expect(() => adapter.resolveSessionPath('/safe/root', '../../etc/passwd')).toThrow(/escapes/)
  })
})

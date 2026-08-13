import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ClaudeHistoryAdapter, CodexHistoryAdapter } from '../src/main/discovery/adapters'
import { DiscoveryService } from '../src/main/discovery/discovery-service'
import { InMemoryDiscoveryRepository } from '../src/main/discovery/repository'
import {
  FileSourceEvidenceReader,
  SourceConversationChangedError
} from '../src/main/discovery/source-evidence-reader'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('DiscoveryService', () => {
  it('lists scanned Source Conversations and reads only the selected source file without an import step', async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), 'oyster-service-'))
    temporaryDirectories.push(homeDirectory)
    const historyRoot = join(homeDirectory, '.claude', 'projects', 'demo')
    const projectRoot = join(homeDirectory, 'work', 'demo')
    await mkdir(historyRoot, { recursive: true })
    await mkdir(join(historyRoot, 'memory'), { recursive: true })
    await mkdir(projectRoot, { recursive: true })
    await writeFile(join(homeDirectory, '.claude', 'CLAUDE.md'), '# User instructions\n')
    await writeFile(join(projectRoot, 'CLAUDE.md'), '# Project instructions\n')
    await writeFile(join(historyRoot, 'memory', 'MEMORY.md'), '# Agent generated memory\n')
    await writeFile(
      join(historyRoot, 'one.jsonl'),
      `${JSON.stringify({ sessionId: 'one', cwd: projectRoot, timestamp: '2026-07-01T00:00:00.000Z' })}\n`
    )
    await writeFile(
      join(historyRoot, 'two.jsonl'),
      `${JSON.stringify({ sessionId: 'two', cwd: projectRoot, timestamp: '2026-07-02T00:00:00.000Z' })}\n`
    )
    await mkdir(join(historyRoot, 'subagents'), { recursive: true })
    await writeFile(
      join(historyRoot, 'subagents', 'child.jsonl'),
      `${JSON.stringify({ sessionId: 'one', cwd: projectRoot, timestamp: '2026-07-01T00:01:00.000Z' })}\n`
    )
    await writeFile(join(historyRoot, 'unknown.jsonl'), '{"type":"other"}\n')

    const evidenceReader = new FileSourceEvidenceReader()
    const readEvidence = vi.spyOn(evidenceReader, 'read')
    const service = new DiscoveryService(
      new InMemoryDiscoveryRepository(),
      evidenceReader,
      [new ClaudeHistoryAdapter()],
      { homeDirectory, environment: {}, pathEntries: [] }
    )
    await service.initialize()
    let snapshot = await service.detectAgents()
    expect(snapshot.sources[0].discoveryState).toBe('found')
    expect(snapshot.sources[0].scanState).toBe('scanning')
    await service.waitForIdle('source:claude')
    snapshot = service.stateView()
    expect(snapshot.sources[0]).toMatchObject({
      scanState: 'ready',
      fileCount: 5,
      conversationCount: 2,
      instructionFileCount: 2,
      invalidFileCount: 1
    })

    const sourceConversations = service.listSourceConversations()
    expect(readEvidence).not.toHaveBeenCalled()
    expect(sourceConversations).toHaveLength(2)
    expect(sourceConversations[0]).toMatchObject({
      sourceId: 'source:claude',
      agentType: 'claude',
      sourceDisplayName: 'Claude Code',
      providerConversationId: 'two'
    })
    expect(sourceConversations[0]).not.toHaveProperty('sourceRevision')
    expect(sourceConversations[0]).not.toHaveProperty('relativePath')
    expect(sourceConversations[0]).not.toHaveProperty('sourcePath')
    expect(sourceConversations[0]).not.toHaveProperty('contentHash')

    const selected = sourceConversations.find((conversation) => conversation.providerConversationId === 'one')!
    const sourceContent = await readFile(join(historyRoot, 'one.jsonl'))
    const evidence = await service.readSourceSnapshot({
      sourceConversationId: selected.sourceConversationId
    })
    expect(readEvidence).toHaveBeenCalledOnce()
    expect(readEvidence).toHaveBeenCalledWith(expect.not.objectContaining({ maxBytes: expect.anything() }))
    expect(evidence).toMatchObject({
      sourceConversationId: selected.sourceConversationId,
      contentHash: createHash('sha256').update(sourceContent).digest('hex'),
      sizeBytes: selected.sizeBytes
    })
    expect(evidence.rawEvidence.lines).toContainEqual(expect.stringContaining('"sessionId":"one"'))
    expect(evidence.rawEvidence).toMatchObject({
      formatVersion: 'claude-jsonl-raw-v1',
      lines: expect.any(Array),
      skillHints: expect.any(Array)
    })
    await expect(service.readSourceSnapshot({
      sourceConversationId: selected.sourceConversationId
    }, selected.sizeBytes - 1)).rejects.toThrow('read limit')
    expect(service.stateView().scans[0]).not.toHaveProperty('kind')
  })

  it('refreshes a grown Source Conversation and removes a deleted Source Conversation without a full source rescan', async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), 'oyster-session-access-'))
    temporaryDirectories.push(homeDirectory)
    const historyRoot = join(homeDirectory, '.claude', 'projects', 'demo')
    const conversationPath = join(historyRoot, 'one.jsonl')
    await mkdir(historyRoot, { recursive: true })
    await writeFile(conversationPath, '{"sessionId":"one","timestamp":"2026-07-01T00:00:00.000Z"}\n')

    const service = new DiscoveryService(
      new InMemoryDiscoveryRepository(),
      new FileSourceEvidenceReader(),
      [new ClaudeHistoryAdapter()],
      { homeDirectory, environment: {}, pathEntries: [] }
    )
    await service.initialize()
    await service.detectAgents()
    await service.waitForIdle()

    const selected = service.listSourceConversations()[0]
    expect(selected).toBeDefined()
    await writeFile(conversationPath, '{"sessionId":"one","timestamp":"2026-07-01T00:00:00.000Z","changed":true}\n')
    await expect(service.readSourceSnapshot({
      sourceConversationId: selected.sourceConversationId
    }, 1_024)).resolves.toMatchObject({
      sourceConversationId: selected.sourceConversationId,
      sizeBytes: expect.any(Number)
    })

    const changed = service.listSourceConversations()[0]
    expect(changed.sourceConversationId).toBe(selected.sourceConversationId)
    expect(changed.sizeBytes).toBeGreaterThan(selected.sizeBytes)
    await expect(service.readSourceSnapshot({
      sourceConversationId: changed.sourceConversationId
    }, 1_024)).resolves.toMatchObject({ sourceConversationId: changed.sourceConversationId })

    await rm(conversationPath)
    await expect(service.readSourceSnapshot({
      sourceConversationId: changed.sourceConversationId
    }, 1_024)).rejects.toThrow('no longer available')
    expect(service.listSourceConversations()).toEqual([])
  })

  it('reports changed only when a Source Conversation keeps changing across the refresh retry', async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), 'oyster-session-changing-'))
    temporaryDirectories.push(homeDirectory)
    const historyRoot = join(homeDirectory, '.claude', 'projects', 'demo')
    const conversationPath = join(historyRoot, 'one.jsonl')
    await mkdir(historyRoot, { recursive: true })
    await writeFile(conversationPath, '{"sessionId":"one","timestamp":"2026-07-01T00:00:00.000Z"}\n')

    const evidenceReader = new FileSourceEvidenceReader()
    const readEvidence = vi.spyOn(evidenceReader, 'read').mockRejectedValue(
      new SourceConversationChangedError()
    )
    const service = new DiscoveryService(
      new InMemoryDiscoveryRepository(),
      evidenceReader,
      [new ClaudeHistoryAdapter()],
      { homeDirectory, environment: {}, pathEntries: [] }
    )
    await service.initialize()
    await service.detectAgents()
    await service.waitForIdle()
    const selected = service.listSourceConversations()[0]

    await expect(service.readSourceSnapshot({
      sourceConversationId: selected.sourceConversationId
    })).rejects.toThrow('kept changing')
    expect(readEvidence).toHaveBeenCalledTimes(2)
  })

  it('transparently follows a Codex Source Conversation moved into archived_sessions', async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), 'oyster-codex-move-'))
    temporaryDirectories.push(homeDirectory)
    const codexRoot = join(homeDirectory, '.codex')
    const sessionsRoot = join(codexRoot, 'sessions', '2026', '07', '29')
    const archivedRoot = join(codexRoot, 'archived_sessions')
    const filename = 'rollout-2026-07-29T00-00-00-session-one.jsonl'
    const originalPath = join(sessionsRoot, filename)
    const archivedPath = join(archivedRoot, filename)
    await mkdir(sessionsRoot, { recursive: true })
    await mkdir(archivedRoot, { recursive: true })
    await writeFile(originalPath, `${JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-07-29T00:00:00.000Z',
      payload: { id: 'session-one', cwd: '/work/oyster' }
    })}\n`)

    const service = new DiscoveryService(
      new InMemoryDiscoveryRepository(),
      new FileSourceEvidenceReader(),
      [new CodexHistoryAdapter()],
      { homeDirectory, environment: {}, pathEntries: [] }
    )
    await service.initialize()
    await service.detectAgents()
    await service.waitForIdle()
    const selected = service.listSourceConversations()[0]
    const catalogSnapshots: string[][] = []
    const unsubscribe = service.subscribeSourceConversationCatalog((catalog) => {
      catalogSnapshots.push(catalog.conversations.map((conversation) => conversation.sourceConversationId))
    })

    await rename(originalPath, archivedPath)
    const evidence = await service.readSourceSnapshot({
      sourceConversationId: selected.sourceConversationId
    })

    expect(evidence.sourceConversationId).toBe(selected.sourceConversationId)
    expect(service.listSourceConversations()).toEqual([selected])
    expect(catalogSnapshots).toContainEqual([selected.sourceConversationId])
    unsubscribe()
  })

  it('uses the first authored Codex request instead of runtime envelopes as the Source Conversation title', async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), 'oyster-codex-title-'))
    temporaryDirectories.push(homeDirectory)
    const sessionsRoot = join(homeDirectory, '.codex', 'sessions', '2026', '08', '10')
    await mkdir(sessionsRoot, { recursive: true })
    await writeFile(join(sessionsRoot, 'rollout-title.jsonl'), [
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-08-10T00:00:00.000Z',
        payload: { id: 'session-title', cwd: '/work/oyster' }
      }),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /work/oyster\n\n<INSTRUCTIONS>runtime</INSTRUCTIONS>' }] }
      }),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Investigate readable evidence.' }] }
      })
    ].join('\n'))

    const service = new DiscoveryService(
      new InMemoryDiscoveryRepository(),
      new FileSourceEvidenceReader(),
      [new CodexHistoryAdapter()],
      { homeDirectory, environment: {}, pathEntries: [] }
    )
    await service.initialize()
    await service.detectAgents()
    await service.waitForIdle()

    expect(service.listSourceConversations()[0]?.title).toBe('Investigate readable evidence.')
  })

  it('refreshes the complete Source Conversation catalog and publishes only the committed source scan', async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), 'oyster-catalog-refresh-'))
    temporaryDirectories.push(homeDirectory)
    const historyRoot = join(homeDirectory, '.claude', 'projects', 'demo')
    const firstPath = join(historyRoot, 'one.jsonl')
    const secondPath = join(historyRoot, 'two.jsonl')
    await mkdir(historyRoot, { recursive: true })
    await writeFile(firstPath, '{"sessionId":"one","timestamp":"2026-07-01T00:00:00.000Z"}\n')

    const service = new DiscoveryService(
      new InMemoryDiscoveryRepository(),
      new FileSourceEvidenceReader(),
      [new ClaudeHistoryAdapter()],
      { homeDirectory, environment: {}, pathEntries: [] }
    )
    await service.initialize()
    await service.detectAgents()
    await service.waitForIdle()
    expect(service.sourceConversationCatalogView().conversations.map(
      (conversation) => conversation.providerConversationId
    )).toEqual(['one'])

    await rm(firstPath)
    await writeFile(secondPath, '{"sessionId":"two","timestamp":"2026-07-02T00:00:00.000Z"}\n')
    const snapshots: Array<{ state: string; conversations: string[] }> = []
    const unsubscribe = service.subscribeSourceConversationCatalog((catalog) => {
      snapshots.push({
        state: catalog.status,
        conversations: catalog.conversations.map((conversation) => conversation.providerConversationId)
      })
    })

    const refreshed = await service.refreshSourceConversationCatalog()

    expect(refreshed.status).toBe('idle')
    expect(refreshed.conversations.map((conversation) => conversation.providerConversationId)).toEqual(['two'])
    expect(snapshots).toContainEqual({ state: 'refreshing', conversations: ['one'] })
    expect(snapshots.at(-1)).toEqual({ state: 'idle', conversations: ['two'] })
    unsubscribe()
  })

  it('resets indexed Source Conversations when the user selects a different root', async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), 'oyster-root-'))
    temporaryDirectories.push(homeDirectory)
    const firstRoot = join(homeDirectory, '.claude', 'projects')
    const secondRoot = join(homeDirectory, 'other-history')
    await mkdir(firstRoot, { recursive: true })
    await mkdir(secondRoot, { recursive: true })
    await writeFile(firstRoot + '/one.jsonl', '{"sessionId":"one"}\n')

    const service = new DiscoveryService(
      new InMemoryDiscoveryRepository(),
      new FileSourceEvidenceReader(),
      [new ClaudeHistoryAdapter()],
      { homeDirectory, environment: {}, pathEntries: [] }
    )
    await service.initialize()
    await service.detectAgents()
    await service.waitForIdle()
    expect(service.stateView().sources[0].conversationCount).toBe(1)

    const snapshot = await service.chooseSourceRoot('source:claude', secondRoot)
    expect(snapshot.sources[0]).toMatchObject({
      rootPath: secondRoot,
      conversationCount: 0,
      instructionFileCount: 0,
      scanState: 'idle'
    })
  })
})

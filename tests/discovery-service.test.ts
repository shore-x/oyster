import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ClaudeHistoryAdapter } from '../src/main/discovery/adapters'
import { DiscoveryService } from '../src/main/discovery/discovery-service'
import { InMemoryDiscoveryRepository } from '../src/main/discovery/repository'
import { FileSourceEvidenceReader } from '../src/main/discovery/source-evidence-reader'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('DiscoveryService', () => {
  it('inspects only the selected Session and caches its message metadata by revision', async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), 'oyster-session-inspection-'))
    temporaryDirectories.push(homeDirectory)
    const historyRoot = join(homeDirectory, '.claude', 'projects', 'demo')
    await mkdir(historyRoot, { recursive: true })
    await writeFile(join(historyRoot, 'one.jsonl'), [
      JSON.stringify({
        sessionId: 'one',
        timestamp: '2026-07-01T00:00:00.000Z'
      }),
      JSON.stringify({
        sessionId: 'one',
        type: 'user',
        timestamp: '2026-07-01T00:01:00.000Z',
        message: { role: 'user', content: 'Question' }
      }),
      JSON.stringify({
        sessionId: 'one',
        type: 'assistant',
        timestamp: '2026-07-01T00:02:00.000Z',
        message: { role: 'assistant', content: 'Answer' }
      })
    ].join('\n') + '\n')

    const repository = new InMemoryDiscoveryRepository()
    const evidenceReader = new FileSourceEvidenceReader()
    const scanLines = vi.spyOn(evidenceReader, 'scanLines')
    const readEvidence = vi.spyOn(evidenceReader, 'read')
    const context = { homeDirectory, environment: {}, pathEntries: [] }
    const service = new DiscoveryService(
      repository,
      evidenceReader,
      [new ClaudeHistoryAdapter()],
      context
    )
    await service.initialize()
    await service.detectAgents()
    await service.waitForIdle()

    const selected = service.listAvailableSessions()[0]
    expect(selected).toMatchObject({
      externalId: 'one',
      startedAt: '2026-07-01T00:00:00.000Z'
    })
    expect(selected.messageCount).toBeUndefined()
    expect(selected.endedAt).toBeUndefined()

    const inspected = await service.inspectAvailableSession({
      artifactId: selected.artifactId,
      expectedRevision: selected.revision
    })
    expect(inspected).toMatchObject({
      artifactId: selected.artifactId,
      revision: selected.revision,
      startedAt: '2026-07-01T00:00:00.000Z',
      endedAt: '2026-07-01T00:02:00.000Z',
      messageCount: 2
    })
    expect(scanLines).toHaveBeenCalledOnce()
    expect(readEvidence).not.toHaveBeenCalled()
    expect(service.listAvailableSessions()[0]).toMatchObject({
      endedAt: '2026-07-01T00:02:00.000Z',
      messageCount: 2
    })

    await expect(service.inspectAvailableSession({
      artifactId: selected.artifactId,
      expectedRevision: selected.revision
    })).resolves.toMatchObject({ messageCount: 2 })

    const restored = new DiscoveryService(
      repository,
      evidenceReader,
      [new ClaudeHistoryAdapter()],
      context
    )
    await restored.initialize()
    await expect(restored.inspectAvailableSession({
      artifactId: selected.artifactId,
      expectedRevision: selected.revision
    })).resolves.toMatchObject({
      endedAt: '2026-07-01T00:02:00.000Z',
      messageCount: 2
    })
    expect(scanLines).toHaveBeenCalledOnce()
  })

  it('lists scanned Sessions and reads only the selected source file without an import step', async () => {
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
    snapshot = service.snapshot()
    expect(snapshot.sources[0]).toMatchObject({
      scanState: 'ready',
      fileCount: 5,
      sessionCount: 2,
      instructionFileCount: 2,
      invalidFileCount: 1
    })

    const availableSessions = service.listAvailableSessions()
    expect(readEvidence).not.toHaveBeenCalled()
    expect(availableSessions).toHaveLength(2)
    expect(availableSessions[0]).toMatchObject({
      sourceId: 'source:claude',
      agentType: 'claude',
      sourceDisplayName: 'Claude Code',
      externalId: 'two'
    })
    expect(availableSessions[0].revision).toMatch(/^[a-f0-9]{64}$/)
    expect(availableSessions[0]).not.toHaveProperty('relativePath')
    expect(availableSessions[0]).not.toHaveProperty('sourcePath')
    expect(availableSessions[0]).not.toHaveProperty('contentHash')

    const selected = availableSessions.find((session) => session.externalId === 'one')!
    const sourceContent = await readFile(join(historyRoot, 'one.jsonl'))
    const evidence = await service.readAvailableSession({
      artifactId: selected.artifactId,
      expectedRevision: selected.revision
    })
    expect(readEvidence).toHaveBeenCalledOnce()
    expect(readEvidence).toHaveBeenCalledWith(expect.not.objectContaining({ maxBytes: expect.anything() }))
    expect(evidence).toMatchObject({
      artifactId: selected.artifactId,
      revision: selected.revision,
      contentHash: createHash('sha256').update(sourceContent).digest('hex'),
      sizeBytes: selected.sizeBytes
    })
    expect(evidence.content).toContain('"sessionId":"one"')
    expect(evidence.observationView).toMatchObject({
      formatVersion: 'claude-jsonl-v2',
      rawLines: expect.any(Array),
      units: expect.any(Array)
    })
    await expect(service.readAvailableSession({
      artifactId: selected.artifactId,
      expectedRevision: '0'.repeat(64)
    }, selected.sizeBytes)).rejects.toThrow('revision has changed')
    expect(readEvidence).toHaveBeenCalledOnce()
    await expect(service.readAvailableSession({
      artifactId: selected.artifactId,
      expectedRevision: selected.revision
    }, selected.sizeBytes - 1)).rejects.toThrow('read limit')
    expect(service.snapshot().runs[0]).not.toHaveProperty('kind')
  })

  it('rejects a changed or deleted source revision and removes it after a rescan', async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), 'oyster-session-access-'))
    temporaryDirectories.push(homeDirectory)
    const historyRoot = join(homeDirectory, '.claude', 'projects', 'demo')
    const sessionPath = join(historyRoot, 'one.jsonl')
    await mkdir(historyRoot, { recursive: true })
    await writeFile(sessionPath, '{"sessionId":"one","timestamp":"2026-07-01T00:00:00.000Z"}\n')

    const service = new DiscoveryService(
      new InMemoryDiscoveryRepository(),
      new FileSourceEvidenceReader(),
      [new ClaudeHistoryAdapter()],
      { homeDirectory, environment: {}, pathEntries: [] }
    )
    await service.initialize()
    await service.detectAgents()
    await service.waitForIdle()

    const selected = service.listAvailableSessions()[0]
    expect(selected).toBeDefined()
    await writeFile(sessionPath, '{"sessionId":"one","timestamp":"2026-07-01T00:00:00.000Z","changed":true}\n')
    await expect(service.readAvailableSession({
      artifactId: selected.artifactId,
      expectedRevision: selected.revision
    }, 1_024)).rejects.toThrow('revision has changed')

    await service.scanSource('source:claude')
    await service.waitForIdle()
    const changed = service.listAvailableSessions()[0]
    expect(changed.artifactId).toBe(selected.artifactId)
    expect(changed.revision).not.toBe(selected.revision)
    await expect(service.readAvailableSession({
      artifactId: selected.artifactId,
      expectedRevision: selected.revision
    }, 1_024)).rejects.toThrow('revision has changed')

    await rm(sessionPath)
    await expect(service.readAvailableSession({
      artifactId: changed.artifactId,
      expectedRevision: changed.revision
    }, 1_024)).rejects.toThrow('no longer available')
    await service.scanSource('source:claude')
    await service.waitForIdle()
    expect(service.listAvailableSessions()).toEqual([])
  })

  it('resets indexed sessions when the user selects a different root', async () => {
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
    expect(service.snapshot().sources[0].sessionCount).toBe(1)

    const snapshot = await service.setSourceRoot('source:claude', secondRoot)
    expect(snapshot.sources[0]).toMatchObject({
      rootPath: secondRoot,
      sessionCount: 0,
      instructionFileCount: 0,
      scanState: 'idle'
    })
  })
})

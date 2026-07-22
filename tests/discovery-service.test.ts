import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ClaudeHistoryAdapter } from '../src/main/discovery/adapters'
import { DiscoveryService } from '../src/main/discovery/discovery-service'
import { MemoryRawEvidenceStore } from '../src/main/discovery/raw-evidence-store'
import { InMemoryDiscoveryRepository } from '../src/main/discovery/repository'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('DiscoveryService', () => {
  it('detects, scans, and imports history without duplicating unchanged evidence', async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), 'oyster-service-'))
    temporaryDirectories.push(homeDirectory)
    const historyRoot = join(homeDirectory, '.claude', 'projects', 'demo')
    await mkdir(historyRoot, { recursive: true })
    await writeFile(
      join(historyRoot, 'one.jsonl'),
      '{"sessionId":"one","cwd":"/demo","timestamp":"2026-07-01T00:00:00.000Z"}\n'
    )
    await writeFile(
      join(historyRoot, 'two.jsonl'),
      '{"sessionId":"two","cwd":"/demo","timestamp":"2026-07-02T00:00:00.000Z"}\n'
    )
    await writeFile(join(historyRoot, 'unknown.jsonl'), '{"type":"other"}\n')

    const evidenceStore = new MemoryRawEvidenceStore()
    const service = new DiscoveryService(
      new InMemoryDiscoveryRepository(),
      evidenceStore,
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
      fileCount: 3,
      sessionCount: 2,
      invalidFileCount: 1,
      syncedSessionCount: 0
    })

    await service.importSource('source:claude')
    await service.waitForIdle('source:claude')
    snapshot = service.snapshot()
    expect(snapshot.sources[0].syncedSessionCount).toBe(2)
    expect(snapshot.sources[0].syncedBytes).toBe(snapshot.sources[0].totalBytes)
    expect(evidenceStore.records.size).toBe(2)

    await service.importSource('source:claude')
    await service.waitForIdle('source:claude')
    expect(evidenceStore.records.size).toBe(2)
    expect(service.snapshot().runs[0]).toMatchObject({ kind: 'import', totalFiles: 0, state: 'completed' })
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
      new MemoryRawEvidenceStore(),
      [new ClaudeHistoryAdapter()],
      { homeDirectory, environment: {}, pathEntries: [] }
    )
    await service.initialize()
    await service.detectAgents()
    await service.waitForIdle()
    expect(service.snapshot().sources[0].sessionCount).toBe(1)

    const snapshot = await service.setSourceRoot('source:claude', secondRoot)
    expect(snapshot.sources[0]).toMatchObject({ rootPath: secondRoot, sessionCount: 0, scanState: 'idle' })
  })
})

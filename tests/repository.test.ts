import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonDiscoveryRepository } from '../src/main/discovery/repository'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('JsonDiscoveryRepository', () => {
  it('migrates legacy import state to the source-reference catalog', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'oyster-repository-'))
    temporaryDirectories.push(temporaryDirectory)
    const statePath = join(temporaryDirectory, 'discovery-state.json')
    await writeFile(
      statePath,
      JSON.stringify({
        sources: [{
          id: 'source:claude',
          agentType: 'claude',
          displayName: 'Claude Code',
          rootPath: '/history',
          discoveryState: 'found',
          scanState: 'ready',
          fileCount: 1,
          conversationCount: 1,
          instructionFileCount: 0,
          totalBytes: 10,
          invalidFileCount: 0,
          syncedBytes: 10,
          syncedSessionCount: 1,
          syncedInstructionFileCount: 0,
          lastSyncedAt: '2026-07-22T00:00:00.000Z'
        }],
        sessions: [
          {
            id: 'legacy-session',
            sourceId: 'source:claude',
            externalId: 'upstream-session',
            relativePath: 'project/session.jsonl',
            sizeBytes: 10,
            modifiedAt: '2026-07-22T00:00:00.000Z',
            fingerprint: 'legacy-fingerprint',
            syncState: 'synced',
            rawEvidenceId: 'source:claude/artifact/evidence',
            rawContentHash: 'a'.repeat(64),
            syncedFingerprint: 'legacy-fingerprint',
            errorMessage: 'legacy import error'
          }
        ],
        runs: [
          {
            id: 'legacy-import',
            sourceId: 'source:claude',
            kind: 'import',
            state: 'completed',
            totalFiles: 1,
            processedFiles: 1,
            totalBytes: 10,
            processedBytes: 10,
            invalidFiles: 0
          },
          {
            id: 'legacy-scan',
            sourceId: 'source:claude',
            kind: 'scan',
            state: 'completed',
            totalFiles: 1,
            processedFiles: 1,
            totalBytes: 10,
            processedBytes: 10,
            invalidFiles: 0
          }
        ]
      })
    )

    const state = await new JsonDiscoveryRepository(statePath).load()
    expect(state.sources[0]).not.toHaveProperty('syncedBytes')
    expect(state.sources[0]).not.toHaveProperty('syncedSessionCount')
    expect(state.sources[0]).not.toHaveProperty('syncedInstructionFileCount')
    expect(state.sources[0]).not.toHaveProperty('lastSyncedAt')
    expect(state.records).toEqual([
      {
        id: 'legacy-session',
        sourceId: 'source:claude',
        kind: 'conversation',
        externalId: 'upstream-session',
        relativePath: 'project/session.jsonl',
        sizeBytes: 10,
        modifiedAt: '2026-07-22T00:00:00.000Z'
      }
    ])
    expect(state.scans).toEqual([expect.objectContaining({
      scanId: 'legacy-scan',
      status: 'completed'
    })])
    expect(state.scans[0]).not.toHaveProperty('kind')
  })

  it('loads the previous artifacts catalog as source records', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'oyster-repository-artifacts-'))
    temporaryDirectories.push(temporaryDirectory)
    const statePath = join(temporaryDirectory, 'discovery-state.json')
    await writeFile(
      statePath,
      JSON.stringify({
        artifacts: [{
          id: 'prior-record',
          sourceId: 'source:codex',
          kind: 'conversation',
          externalId: 'upstream-record',
          relativePath: 'sessions/record.jsonl',
          sizeBytes: 20,
          modifiedAt: '2026-07-26T00:00:00.000Z',
          fingerprint: 'b'.repeat(64)
        }]
      })
    )

    const state = await new JsonDiscoveryRepository(statePath).load()
    expect(state.records).toEqual([
      expect.objectContaining({ id: 'prior-record', kind: 'conversation' })
    ])
  })

  it('persists only the current scan catalog shape', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'oyster-repository-save-'))
    temporaryDirectories.push(temporaryDirectory)
    const statePath = join(temporaryDirectory, 'discovery-state.json')
    const repository = new JsonDiscoveryRepository(statePath)

    await repository.save({
      sources: [],
      records: [{
        id: 'session-one',
        sourceId: 'source:codex',
        kind: 'conversation',
        externalId: 'upstream-one',
        relativePath: 'sessions/one.jsonl',
        sizeBytes: 20,
        modifiedAt: '2026-07-26T00:00:00.000Z'
      }],
      scans: [{
        scanId: 'scan-one',
        sourceId: 'source:codex',
        status: 'completed',
        totalFiles: 1,
        processedFiles: 1,
        totalBytes: 20,
        processedBytes: 20,
        invalidFiles: 0
      }]
    })

    const stored = await readFile(statePath, 'utf8')
    expect(stored).toContain('"records"')
    expect(stored).not.toMatch(/"artifacts"|"sessions"/)
    expect(stored).not.toMatch(/rawEvidence|rawContentHash|syncState|syncedFingerprint|fingerprint|"kind": "import"/)
  })
})

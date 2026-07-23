import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonDiscoveryRepository } from '../src/main/discovery/repository'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('JsonDiscoveryRepository', () => {
  it('migrates the previous sessions collection to conversation artifacts', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'oyster-repository-'))
    temporaryDirectories.push(temporaryDirectory)
    const statePath = join(temporaryDirectory, 'discovery-state.json')
    await writeFile(
      statePath,
      JSON.stringify({
        sources: [],
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
            rawEvidenceId: 'source:claude/artifact/evidence'
          }
        ],
        runs: []
      })
    )

    const state = await new JsonDiscoveryRepository(statePath).load()
    expect(state.artifacts).toEqual([
      expect.objectContaining({
        id: 'legacy-session',
        kind: 'conversation',
        externalId: 'upstream-session',
        rawEvidenceId: 'claude/artifact/evidence'
      })
    ])
  })
})

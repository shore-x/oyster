import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileAgentDebugStore } from '../src/main/agent-runtime/agent-debug-store'
import { parseAgentInvocationRecord } from '../src/main/agent-runtime/agent-invocation-record'
import { completedAgentInvocation } from './agent-invocation-fixture'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => (
    rm(path, { recursive: true, force: true })
  )))
})

describe('FileAgentDebugStore', () => {
  it('stores one complete local debug record while keeping the Invocation envelope small', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oyster-agent-debug-'))
    temporaryPaths.push(root)
    const store = new FileAgentDebugStore(root)
    const debug = completedAgentInvocation('invocation:debug', ['read'], 2)
    store.save(debug)

    expect(store.read(debug.invocationId)).toEqual(debug)
    expect(await readdir(root)).toHaveLength(1)
    expect(parseAgentInvocationRecord(debug)).toEqual({
      formatVersion: 4,
      invocationId: debug.invocationId,
      agentId: debug.agentId,
      status: 'completed',
      startedAt: debug.startedAt,
      completedAt: debug.completedAt,
      durationMs: 0,
      debugRecordId: debug.invocationId,
      modelCallCount: 2,
      toolCallCount: 1
    })
  })

  it('reads and rewrites the version 3 id field as invocationId', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oyster-agent-debug-legacy-'))
    temporaryPaths.push(root)
    const current = completedAgentInvocation('invocation:legacy')
    const legacy = {
      ...current,
      formatVersion: 3,
      id: current.invocationId,
      invocationId: undefined
    }
    const file = join(root, 'invocation%3Alegacy.json')
    await writeFile(file, `${JSON.stringify(legacy)}\n`, 'utf8')

    const store = new FileAgentDebugStore(root)
    expect(store.read(current.invocationId)).toEqual(current)
    const migrated = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    expect(migrated).toMatchObject({ formatVersion: 4, invocationId: current.invocationId })
    expect(migrated).not.toHaveProperty('id')
  })

  it('removes only records not referenced by durable Chat Invocations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oyster-agent-debug-retention-'))
    temporaryPaths.push(root)
    const store = new FileAgentDebugStore(root)
    const retained = completedAgentInvocation('invocation:chat')
    const disposable = completedAgentInvocation('invocation:task')
    store.save(retained)
    store.save(disposable)
    await writeFile(join(root, '%ZZ.json'), '{}\n', 'utf8')

    expect(store.deleteUnreferenced(new Set([retained.invocationId]))).toBe(1)
    expect(store.read(retained.invocationId)).toEqual(retained)
    expect(store.read(disposable.invocationId)).toBeUndefined()
    await expect(readFile(join(root, '%ZZ.json'), 'utf8')).resolves.toBe('{}\n')
  })
})

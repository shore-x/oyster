import { mkdtemp, readdir, rm } from 'node:fs/promises'
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

    expect(store.read(debug.id)).toEqual(debug)
    expect(await readdir(root)).toHaveLength(1)
    expect(parseAgentInvocationRecord(debug)).toEqual({
      formatVersion: 3,
      id: debug.id,
      agentId: debug.agentId,
      status: 'completed',
      startedAt: debug.startedAt,
      completedAt: debug.completedAt,
      durationMs: 0,
      debugRecordId: debug.id,
      modelCallCount: 2,
      toolCallCount: 1
    })
  })
})

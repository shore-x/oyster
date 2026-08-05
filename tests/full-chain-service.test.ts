import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AiBackendSnapshot, AiConnection } from '../src/shared/ai-backends'
import type { AvailableSessionSummary } from '../src/shared/discovery'
import type { ModelGenerationRequest, ModelRuntime } from '../src/main/ai-backends/model'
import type { DiscoveryService } from '../src/main/discovery/discovery-service'
import {
  KnowledgeFullChainService,
  type KnowledgeFullChainBindings
} from '../src/main/knowledge-processing/full-chain-service'
import type { KnowledgeFullChainRunHistory } from '../src/main/knowledge-processing/full-chain-run-repository'
import { KnowledgeProcessingService } from '../src/main/knowledge-processing/knowledge-processing-service'
import type {
  AiBackendPort,
  KnowledgeAgentRunInput,
  KnowledgeAgentRuntime,
  KnowledgeReader
} from '../src/main/knowledge-processing/model'
import { InMemoryKnowledgeProcessingRepository } from '../src/main/knowledge-processing/repository'
import { SqliteKnowledgeStoreManager } from '../src/main/knowledge-store/knowledge-store-manager'
import type { KnowledgeFullChainRunRecord } from '../src/shared/knowledge-processing'

const temporaryDirectories: string[] = []
const disposals: Array<() => void> = []

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function connection(): AiConnection {
  return {
    id: 'model:maintainer',
    adapterId: 'openai-compatible',
    backendKind: 'api',
    providerId: 'openai_compatible',
    displayName: 'Maintainer Model',
    credentialMode: 'oyster_keychain',
    status: 'ready',
    models: [{ id: 'maintainer', displayName: 'Maintainer', reasoningEfforts: [] }],
    defaultModelId: 'maintainer',
    modelConfig: {
      providerId: 'openai_compatible',
      protocol: 'openai_responses',
      baseUrl: 'https://example.test/v1',
      model: 'maintainer',
      hasApiKey: true,
      reasoningEfforts: []
    }
  }
}

class FakeBackend implements AiBackendPort {
  snapshot(): AiBackendSnapshot {
    return {
      options: [],
      connections: [connection()],
      defaultLlm: { connectionId: 'model:maintainer', modelId: 'maintainer' }
    }
  }

  subscribe(): () => void {
    return () => undefined
  }

  async generateWithModel(
    _connectionId: string,
    _modelId: string,
    _request: ModelGenerationRequest
  ): Promise<{ text: string }> {
    throw new Error('not used')
  }

  async withModelRuntime<T>(
    _connectionId: string,
    _modelId: string,
    operation: (runtime: ModelRuntime) => Promise<T>
  ): Promise<T> {
    return operation({
      model: { id: 'maintainer', contextWindow: 128_000 } as ModelRuntime['model'],
      streamFn: (() => { throw new Error('not used') }) as ModelRuntime['streamFn']
    })
  }
}

function fakeDiscovery() {
  const content = [
    '{"role":"user","content":"Keep summaries concise."}',
    '{"type":"function_call","name":"Skill","arguments":{"skill":"deep-research"}}'
  ].join('\n')
  const revision = sha256(`revision\0${content}`)
  const session: AvailableSessionSummary = {
    sourceRecordId: 'source-record-session-1',
    sourceId: 'source:codex',
    agentType: 'codex',
    sourceDisplayName: 'OpenAI Codex',
    externalId: 'session-1',
    title: 'Knowledge test session',
    sizeBytes: Buffer.byteLength(content),
    revision
  }
  const service = {
    listAvailableSessions: () => [structuredClone(session)],
    readAvailableSession: async (input: { sourceRecordId: string; expectedRevision: string }) => {
      if (input.sourceRecordId !== session.sourceRecordId || input.expectedRevision !== revision) {
        throw new Error('The Session revision has changed')
      }
      return {
        sourceRecordId: session.sourceRecordId,
        revision,
        contentHash: sha256(content),
        sizeBytes: Buffer.byteLength(content),
        rawEvidence: {
          formatVersion: 'codex-jsonl-raw-v1',
          lines: content.split('\n'),
          skillHints: [{
            name: 'deep-research',
            tool: 'Skill',
            source: 'tool_call' as const,
            location: { line: 2, offset: 0 }
          }]
        }
      }
    }
  } as unknown as DiscoveryService
  return { service, session }
}

afterEach(async () => {
  for (const dispose of disposals.splice(0)) dispose()
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => rm(directory, { recursive: true, force: true })
  ))
})

describe('KnowledgeFullChainService', () => {
  it('runs one evidence-driven Maintainer in a Sandbox and stores a V3 snapshot', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oyster-full-chain-'))
    temporaryDirectories.push(directory)
    const stores = await SqliteKnowledgeStoreManager.open(join(directory, 'knowledge'))
    disposals.push(() => stores.close())
    const processing = new KnowledgeProcessingService(
      new InMemoryKnowledgeProcessingRepository({
        stages: [{ stageId: 'knowledge_maintenance_agent' }]
      }),
      new FakeBackend(),
      { run: async () => { throw new Error('full chain must use the Sandbox-bound Agent') } }
    )
    await processing.initialize()
    disposals.push(() => processing.dispose())
    const discovery = fakeDiscovery()
    const agentInputs: KnowledgeAgentRunInput[] = []
    const historyRecords: KnowledgeFullChainRunRecord[] = []
    const history: KnowledgeFullChainRunHistory = {
      save: (record) => historyRecords.push(structuredClone(record)),
      list: () => [],
      read: (runId) => historyRecords.find((record) => record.runId === runId)
    }
    const factory = (_reader: KnowledgeReader): KnowledgeAgentRuntime => ({
      run: async (input) => {
        agentInputs.push(input)
        return {
          contribution: {
            runRef: input.contributionRunRef,
            statements: [{ title: 'Summary preference', content: 'The user prefers concise summaries.' }]
          },
          todos: (input.initialTodos ?? []).map((content, index) => ({
            id: `T${String(index + 1).padStart(6, '0')}`,
            content,
            status: 'completed'
          })),
          modelCallCount: 1,
          toolCalls: ['read_evidence', 'complete_todos']
        }
      }
    })
    const service = new KnowledgeFullChainService(discovery.service, processing, stores, factory, history)
    const bindings: KnowledgeFullChainBindings = {
      maintainer: processing.runBinding('knowledge_maintenance_agent')
    }

    const result = await service.run({
      sourceRecordId: discovery.session.sourceRecordId,
      expectedRevision: discovery.session.revision,
      attention: 'Preserve preferences.'
    }, bindings)

    expect(agentInputs).toHaveLength(1)
    expect(agentInputs[0].initialTodos?.[0]).toContain('Inspect Raw Evidence segment 1 of 1')
    expect(agentInputs[0].initialTodos?.[0]).toContain('possible Skill activation “deep-research”')
    expect(result.maintenance.evidenceSegmentCount).toBe(1)
    expect(result.knowledge.statements).toEqual([{ title: 'Summary preference', content: 'The user prefers concise summaries.' }])
    expect(stores.production.listStatements()).toEqual([])
    expect(historyRecords).toHaveLength(1)
    expect(historyRecords[0]).toMatchObject({
      formatVersion: 3,
      configuration: { maintainer: { modelId: 'maintainer' } }
    })
  })

  it('rejects a stale Session selection before creating a Sandbox', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oyster-full-chain-'))
    temporaryDirectories.push(directory)
    const stores = await SqliteKnowledgeStoreManager.open(join(directory, 'knowledge'))
    disposals.push(() => stores.close())
    const processing = new KnowledgeProcessingService(
      new InMemoryKnowledgeProcessingRepository(),
      new FakeBackend(),
      { run: async () => { throw new Error('not used') } }
    )
    await processing.initialize()
    disposals.push(() => processing.dispose())
    const discovery = fakeDiscovery()
    const service = new KnowledgeFullChainService(discovery.service, processing, stores, () => ({
      run: async () => { throw new Error('not used') }
    }))

    await expect(service.run({
      sourceRecordId: discovery.session.sourceRecordId,
      expectedRevision: '0'.repeat(64)
    }, {
      maintainer: {
        connectionId: 'model:maintainer',
        modelId: 'maintainer',
        instructions: 'Maintain knowledge.'
      }
    })).rejects.toThrow('Session 已失效')
    expect(await stores.listSandboxes()).toEqual([])
  })
})

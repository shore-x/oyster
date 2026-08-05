import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonAiBackendRepository } from '../src/main/ai-backends/repository'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('JsonAiBackendRepository', () => {
  it('persists only non-secret model connection metadata', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oyster-ai-repository-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'ai-connections.json')
    const repository = new JsonAiBackendRepository(path)

    await repository.save({
      connections: [{
        id: 'model:one',
        adapterId: 'openai-compatible',
        providerId: 'openai_compatible',
        protocol: 'openai_chat_completions',
        baseUrl: 'http://localhost:11434/v1',
        model: 'local-model',
        credentialRef: 'model:one'
      }],
      defaultLlm: {
        connectionId: 'model:one',
        modelId: 'local-model',
        reasoningEffort: 'low'
      }
    })

    const raw = await readFile(path, 'utf8')
    expect(raw).toContain('credentialRef')
    expect(raw).not.toContain('apiKey')
    expect(await repository.load()).toEqual({
      connections: [expect.objectContaining({ id: 'model:one', model: 'local-model' })],
      defaultLlm: {
        connectionId: 'model:one',
        modelId: 'local-model',
        reasoningEffort: 'low'
      }
    })
  })

  it('starts with an empty state when the file does not exist', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oyster-ai-repository-empty-'))
    temporaryDirectories.push(directory)
    await expect(new JsonAiBackendRepository(join(directory, 'missing.json')).load())
      .resolves.toEqual({ connections: [] })
  })

  it('rejects malformed entries instead of silently dropping and overwriting them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oyster-ai-repository-invalid-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'ai-connections.json')
    await writeFile(path, JSON.stringify({
      connections: [{ id: 'future-entry', adapterId: 'unknown-adapter' }]
    }), 'utf8')

    await expect(new JsonAiBackendRepository(path).load()).rejects.toThrow('第 1 条记录无效')
    expect(await readFile(path, 'utf8')).toContain('future-entry')
  })

  it('rejects a malformed default LLM binding', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oyster-ai-repository-invalid-default-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'ai-connections.json')
    await writeFile(path, JSON.stringify({
      connections: [],
      defaultLlm: { connectionId: 'runtime:codex', modelId: '' }
    }), 'utf8')

    await expect(new JsonAiBackendRepository(path).load()).rejects.toThrow('默认 LLM 配置无效')
  })
})

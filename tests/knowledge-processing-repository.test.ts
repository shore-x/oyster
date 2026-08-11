import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonKnowledgeProcessingConfigurationRepository } from '../src/main/knowledge-processing/repository'

const temporaryDirectories: string[] = []

async function temporaryRepository() {
  const directory = await mkdtemp(join(tmpdir(), 'oyster-knowledge-processing-'))
  temporaryDirectories.push(directory)
  const filePath = join(directory, 'knowledge-processing.json')
  return { filePath, repository: new JsonKnowledgeProcessingConfigurationRepository(filePath) }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => rm(directory, { recursive: true, force: true })
  ))
})

describe('JsonKnowledgeProcessingConfigurationRepository', () => {
  it('returns an empty state when the configuration does not exist', async () => {
    const { repository } = await temporaryRepository()
    await expect(repository.load()).resolves.toEqual({ agents: [] })
  })

  it('persists the Maintainer definition without retaining caller-owned references', async () => {
    const { filePath, repository } = await temporaryRepository()
    const state = {
      agents: [{
        agentId: 'knowledge_maintainer' as const,
        defaultInstructionsOverride: 'configured default prompt',
        instructionsOverride: 'custom prompt'
      }]
    }

    await repository.save(state)
    state.agents[0].instructionsOverride = 'mutated-after-save'
    expect((await repository.load()).agents[0].instructionsOverride).toBe('custom prompt')
    const loaded = await repository.load()
    loaded.agents[0].instructionsOverride = 'mutated-after-load'
    expect((await repository.load()).agents[0].instructionsOverride).toBe('custom prompt')
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      formatVersion: 3,
      agents: [expect.objectContaining({
        agentId: 'knowledge_maintainer',
        defaultInstructionsOverride: 'configured default prompt',
        instructionsOverride: 'custom prompt'
      })]
    })
  })

  it('rebuilds older configurations instead of retaining removed Agent bindings', async () => {
    const { filePath, repository } = await temporaryRepository()
    await writeFile(filePath, JSON.stringify({
      stages: [
        { stageId: 'observation_preprocessor', connectionId: 'model:old', modelId: 'old-preprocessor' },
        { stageId: 'knowledge_maintainer', connectionId: 'model:old', modelId: 'old-maintainer' }
      ]
    }), 'utf8')

    await expect(repository.load()).resolves.toEqual({ agents: [] })
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      formatVersion: 3,
      agents: []
    })

    await writeFile(filePath, JSON.stringify({
      formatVersion: 1,
      stages: [{
        stageId: 'knowledge_maintainer',
        connectionId: 'model:old',
        modelId: 'old-maintainer'
      }]
    }), 'utf8')
    await expect(repository.load()).resolves.toEqual({ agents: [] })
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      formatVersion: 3,
      agents: []
    })
  })

  it('rejects malformed, unknown, duplicate, or future-version current records', async () => {
    const { filePath, repository } = await temporaryRepository()
    await writeFile(filePath, '{not json', 'utf8')
    await expect(repository.load()).rejects.toThrow()

    await writeFile(filePath, JSON.stringify({
      formatVersion: 3,
      agents: [{ agentId: 'unknown_agent' }]
    }), 'utf8')
    await expect(repository.load()).rejects.toThrow('第 1 条 Agent 记录无效')

    await writeFile(filePath, JSON.stringify({
      formatVersion: 3,
      agents: [{ agentId: 'knowledge_maintainer', connectionId: 'model:legacy' }]
    }), 'utf8')
    await expect(repository.load()).rejects.toThrow('第 1 条 Agent 记录无效')

    await writeFile(filePath, JSON.stringify({
      formatVersion: 3,
      agents: [
        { agentId: 'knowledge_maintainer', instructionsOverride: 'a' },
        { agentId: 'knowledge_maintainer', instructionsOverride: 'b' }
      ]
    }), 'utf8')
    await expect(repository.load()).rejects.toThrow('重复 Agent')

    await writeFile(filePath, JSON.stringify({ formatVersion: 4, agents: [] }), 'utf8')
    await expect(repository.load()).rejects.toThrow('高于当前支持版本')
  })
})

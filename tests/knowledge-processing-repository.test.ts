import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonKnowledgeProcessingRepository } from '../src/main/knowledge-processing/repository'

const temporaryDirectories: string[] = []

async function temporaryRepository() {
  const directory = await mkdtemp(join(tmpdir(), 'oyster-knowledge-processing-'))
  temporaryDirectories.push(directory)
  const filePath = join(directory, 'knowledge-processing.json')
  return { filePath, repository: new JsonKnowledgeProcessingRepository(filePath) }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => rm(directory, { recursive: true, force: true })
  ))
})

describe('JsonKnowledgeProcessingRepository', () => {
  it('returns an empty state when the configuration does not exist', async () => {
    const { repository } = await temporaryRepository()
    await expect(repository.load()).resolves.toEqual({ stages: [] })
  })

  it('persists the single Maintainer stage without retaining caller-owned references', async () => {
    const { filePath, repository } = await temporaryRepository()
    const state = {
      stages: [{
        stageId: 'knowledge_maintenance_agent' as const,
        connectionId: 'model:a',
        modelId: 'maintainer',
        reasoningEffort: 'low' as const,
        defaultInstructionsOverride: 'configured default prompt',
        instructionsOverride: 'custom prompt'
      }]
    }

    await repository.save(state)
    state.stages[0].connectionId = 'mutated-after-save'
    expect((await repository.load()).stages[0].connectionId).toBe('model:a')
    const loaded = await repository.load()
    loaded.stages[0].connectionId = 'mutated-after-load'
    expect((await repository.load()).stages[0].connectionId).toBe('model:a')
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      stages: [expect.objectContaining({
        stageId: 'knowledge_maintenance_agent',
        connectionId: 'model:a',
        modelId: 'maintainer'
      })]
    })
  })

  it('rejects malformed, unknown, or duplicate stage records', async () => {
    const { filePath, repository } = await temporaryRepository()
    await writeFile(filePath, '{not json', 'utf8')
    await expect(repository.load()).rejects.toThrow()

    await writeFile(filePath, JSON.stringify({ stages: [{ stageId: 'unknown_stage' }] }), 'utf8')
    await expect(repository.load()).rejects.toThrow('第 1 条记录无效')

    await writeFile(filePath, JSON.stringify({
      stages: [
        { stageId: 'knowledge_maintenance_agent', connectionId: 'model:a' },
        { stageId: 'knowledge_maintenance_agent', connectionId: 'model:b' }
      ]
    }), 'utf8')
    await expect(repository.load()).rejects.toThrow('重复阶段')
  })
})

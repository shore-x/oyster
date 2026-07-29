import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonKnowledgeProcessingRepository } from '../src/main/knowledge-processing/repository'

const temporaryDirectories: string[] = []

async function temporaryRepository(): Promise<{
  directory: string
  filePath: string
  repository: JsonKnowledgeProcessingRepository
}> {
  const directory = await mkdtemp(join(tmpdir(), 'oyster-knowledge-processing-'))
  temporaryDirectories.push(directory)
  const filePath = join(directory, 'knowledge-processing.json')
  return { directory, filePath, repository: new JsonKnowledgeProcessingRepository(filePath) }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('JsonKnowledgeProcessingRepository', () => {
  it('returns an empty state when the configuration does not exist', async () => {
    const { repository } = await temporaryRepository()
    await expect(repository.load()).resolves.toEqual({ stages: [] })
  })

  it('persists stage selections and overrides without retaining caller-owned references', async () => {
    const { filePath, repository } = await temporaryRepository()
    const state = {
      stages: [
        {
          stageId: 'observation_preprocessor' as const,
          connectionId: 'model:a',
          reasoningEffort: 'low' as const,
          defaultInstructionsOverride: 'configured default prompt',
          instructionsOverride: 'custom prompt'
        },
        {
          stageId: 'knowledge_maintenance_agent' as const,
          connectionId: 'model:b'
        }
      ]
    }

    await repository.save(state)
    state.stages[0].connectionId = 'mutated-after-save'
    expect(await repository.load()).toEqual({
      stages: [
        {
          stageId: 'observation_preprocessor',
          connectionId: 'model:a',
          reasoningEffort: 'low',
          defaultInstructionsOverride: 'configured default prompt',
          instructionsOverride: 'custom prompt'
        },
        {
          stageId: 'knowledge_maintenance_agent',
          connectionId: 'model:b'
        }
      ]
    })

    const loaded = await repository.load()
    loaded.stages[0].connectionId = 'mutated-after-load'
    expect((await repository.load()).stages[0].connectionId).toBe('model:a')
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      stages: [
        {
          stageId: 'observation_preprocessor',
          connectionId: 'model:a',
          reasoningEffort: 'low',
          defaultInstructionsOverride: 'configured default prompt',
          instructionsOverride: 'custom prompt'
        },
        {
          stageId: 'knowledge_maintenance_agent',
          connectionId: 'model:b'
        }
      ]
    })
  })

  it('serializes concurrent saves in invocation order', async () => {
    const { repository } = await temporaryRepository()
    await Promise.all([
      repository.save({
        stages: [{ stageId: 'observation_preprocessor', connectionId: 'model:first' }]
      }),
      repository.save({
        stages: [{ stageId: 'knowledge_maintenance_agent', connectionId: 'model:second' }]
      })
    ])

    await expect(repository.load()).resolves.toEqual({
      stages: [{ stageId: 'knowledge_maintenance_agent', connectionId: 'model:second' }]
    })
  })

  it('loads a non-empty prompt override without an arbitrary character ceiling', async () => {
    const { filePath, repository } = await temporaryRepository()
    const instructionsOverride = 'prompt '.repeat(4_000)
    await writeFile(filePath, JSON.stringify({
      stages: [{ stageId: 'knowledge_maintenance_agent', instructionsOverride }]
    }), 'utf8')

    expect(instructionsOverride.length).toBeGreaterThan(20_000)
    await expect(repository.load()).resolves.toEqual({
      stages: [{ stageId: 'knowledge_maintenance_agent', instructionsOverride }]
    })
  })

  it('rejects malformed JSON and invalid or duplicate stage records instead of filtering them', async () => {
    const { filePath, repository } = await temporaryRepository()

    await writeFile(filePath, '{not json', 'utf8')
    await expect(repository.load()).rejects.toThrow()

    await writeFile(filePath, JSON.stringify({
      stages: [{ stageId: 'unknown_stage', connectionId: 'model:a' }]
    }), 'utf8')
    await expect(repository.load()).rejects.toThrow('第 1 条记录无效')

    await writeFile(filePath, JSON.stringify({
      stages: [{ stageId: 'observation_preprocessor', instructionsOverride: '   ' }]
    }), 'utf8')
    await expect(repository.load()).rejects.toThrow('第 1 条记录无效')

    await writeFile(filePath, JSON.stringify({
      stages: [{ stageId: 'observation_preprocessor', defaultInstructionsOverride: '   ' }]
    }), 'utf8')
    await expect(repository.load()).rejects.toThrow('第 1 条记录无效')

    await writeFile(filePath, JSON.stringify({
      stages: [{ stageId: 'observation_preprocessor', reasoningEffort: 'ultra' }]
    }), 'utf8')
    await expect(repository.load()).rejects.toThrow('第 1 条记录无效')

    await writeFile(filePath, JSON.stringify({
      stages: [
        { stageId: 'observation_preprocessor', connectionId: 'model:a' },
        { stageId: 'observation_preprocessor', connectionId: 'model:b' }
      ]
    }), 'utf8')
    await expect(repository.load()).rejects.toThrow('重复阶段')
  })
})

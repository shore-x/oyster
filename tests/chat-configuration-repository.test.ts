import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  InMemoryChatConfigurationRepository,
  JsonChatConfigurationRepository
} from '../src/main/chat/chat-configuration-repository'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('chat configuration repositories', () => {
  it('round-trips the configured default prompt atomically', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'oyster-chat-config-'))
    temporaryPaths.push(rootPath)
    const repository = new JsonChatConfigurationRepository(join(rootPath, 'chat.json'))
    await expect(repository.load()).resolves.toEqual({})
    await repository.save({ defaultInstructionsOverride: 'Configured chat prompt.' })
    await expect(repository.load()).resolves.toEqual({
      defaultInstructionsOverride: 'Configured chat prompt.'
    })
  })

  it('rejects blank configured prompts', async () => {
    expect(() => new InMemoryChatConfigurationRepository({
      defaultInstructionsOverride: '   '
    })).toThrow('无效')
  })
})

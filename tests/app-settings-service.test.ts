import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppSettingsService } from '../src/main/app-settings/app-settings-service'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => (
    rm(path, { recursive: true, force: true })
  )))
})

async function settingsService(): Promise<{ rootPath: string, settingsPath: string, service: AppSettingsService }> {
  const rootPath = await mkdtemp(join(tmpdir(), 'oyster-app-settings-'))
  temporaryPaths.push(rootPath)
  const settingsPath = join(rootPath, 'app-settings.json')
  const service = new AppSettingsService(settingsPath)
  await service.initialize()
  return { rootPath, settingsPath, service }
}

describe('AppSettingsService', () => {
  it('uses Simplified Chinese when no settings file exists', async () => {
    const { settingsPath, service } = await settingsService()

    expect(service.getSettings()).toEqual({
      language: 'zh-CN',
      settingsPath
    })
  })

  it('persists English for the next application launch', async () => {
    const { settingsPath, service } = await settingsService()

    await service.saveSettings({ language: 'en-US' })
    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual({ language: 'en-US' })

    const restarted = new AppSettingsService(settingsPath)
    await restarted.initialize()
    expect(restarted.languageSetting).toBe('en-US')
  })

  it('rejects unsupported languages before writing', async () => {
    const { settingsPath, service } = await settingsService()

    expect(() => service.saveSettings({ language: 'fr-FR' as 'zh-CN' }))
      .toThrow('应用语言无效')
    await expect(readFile(settingsPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports a damaged file, falls back to Chinese, and repairs it on save', async () => {
    const { settingsPath, service } = await settingsService()
    await service.saveSettings({ language: 'en-US' })
    await writeFile(settingsPath, '{ damaged', 'utf8')
    await service.initialize()

    expect(service.getSettings()).toMatchObject({
      language: 'zh-CN',
      settingsPath,
      error: expect.any(String)
    })

    expect(await service.saveSettings({ language: 'en-US' })).toEqual({
      language: 'en-US',
      settingsPath
    })
    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual({ language: 'en-US' })
  })
})

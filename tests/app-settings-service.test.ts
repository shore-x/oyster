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
      uiLanguage: 'zh-CN',
      agentLanguage: 'zh-CN',
      settingsPath
    })
  })

  it('persists independent languages for the next application launch', async () => {
    const { settingsPath, service } = await settingsService()

    await service.saveSettings({ uiLanguage: 'en-US', agentLanguage: 'zh-CN' })
    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual({
      uiLanguage: 'en-US',
      agentLanguage: 'zh-CN'
    })

    const restarted = new AppSettingsService(settingsPath)
    await restarted.initialize()
    expect(restarted.uiLanguageSetting).toBe('en-US')
    expect(restarted.agentLanguageSetting).toBe('zh-CN')
  })

  it('migrates the legacy application language to both independent settings', async () => {
    const { settingsPath } = await settingsService()
    await writeFile(settingsPath, JSON.stringify({ language: 'en-US' }), 'utf8')

    const restarted = new AppSettingsService(settingsPath)
    await restarted.initialize()

    expect(restarted.getSettings()).toEqual({
      uiLanguage: 'en-US',
      agentLanguage: 'en-US',
      settingsPath
    })
  })

  it('rejects unsupported languages before writing', async () => {
    const { settingsPath, service } = await settingsService()

    expect(() => service.saveSettings({
      uiLanguage: 'fr-FR' as 'zh-CN',
      agentLanguage: 'zh-CN'
    })).toThrow('语言设置无效')
    await expect(readFile(settingsPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports a damaged file, falls back to Chinese, and repairs it on save', async () => {
    const { settingsPath, service } = await settingsService()
    await service.saveSettings({ uiLanguage: 'en-US', agentLanguage: 'zh-CN' })
    await writeFile(settingsPath, '{ damaged', 'utf8')
    await service.initialize()

    expect(service.getSettings()).toMatchObject({
      uiLanguage: 'zh-CN',
      agentLanguage: 'zh-CN',
      settingsPath,
      error: expect.any(String)
    })

    expect(await service.saveSettings({ uiLanguage: 'en-US', agentLanguage: 'zh-CN' })).toEqual({
      uiLanguage: 'en-US',
      agentLanguage: 'zh-CN',
      settingsPath
    })
    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual({
      uiLanguage: 'en-US',
      agentLanguage: 'zh-CN'
    })
  })
})

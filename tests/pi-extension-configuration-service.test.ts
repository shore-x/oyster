import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PiExtensionConfigurationService } from '../src/main/agent-runtime/pi-extension-configuration-service'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => (
    rm(path, { recursive: true, force: true })
  )))
})

describe('PiExtensionConfigurationService', () => {
  it('writes headless-only Package and local Extension settings through Pi SettingsManager', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'oyster-pi-settings-'))
    temporaryPaths.push(agentDir)
    const service = new PiExtensionConfigurationService(agentDir)

    await service.addSource({ kind: 'package', source: 'npm:@example/headless' })
    await service.addSource({ kind: 'local', source: '/tmp/example-extension.ts' })
    const disabled = await service.setSourceEnabled({
      kind: 'package',
      source: 'npm:@example/headless',
      enabled: false
    })

    expect(disabled.sources).toEqual([
      { kind: 'package', source: 'npm:@example/headless', enabled: false },
      { kind: 'local', source: '/tmp/example-extension.ts', enabled: true }
    ])
    const settings = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'))
    expect(settings.packages).toEqual([{
      source: 'npm:@example/headless',
      skills: [],
      prompts: [],
      themes: [],
      extensions: []
    }])
    expect(settings.extensions).toEqual(['/tmp/example-extension.ts'])
  })

  it('keeps disabled sources editable without a parallel Oyster database', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'oyster-pi-settings-'))
    temporaryPaths.push(agentDir)
    const service = new PiExtensionConfigurationService(agentDir)
    await service.addSource({ kind: 'local', source: '/tmp/local-extension.ts' })
    await service.setSourceEnabled({
      kind: 'local',
      source: '/tmp/local-extension.ts',
      enabled: false
    })
    expect(service.getConfiguration().sources).toEqual([{
      kind: 'local',
      source: '/tmp/local-extension.ts',
      enabled: false
    }])
    expect((await service.removeSource({
      kind: 'local',
      source: '/tmp/local-extension.ts'
    })).sources).toEqual([])
  })
})

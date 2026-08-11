import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PiAgentSettingsService } from '../src/main/agent-runtime/pi-agent-settings-service'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => (
    rm(path, { recursive: true, force: true })
  )))
})

describe('PiAgentSettingsService', () => {
  it('reads and saves common Pi settings without replacing advanced or Extension settings', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'oyster-pi-agent-settings-'))
    temporaryPaths.push(agentDir)
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
      compaction: {
        enabled: false,
        reserveTokens: 8_192,
        keepRecentTokens: 12_000
      },
      retry: {
        enabled: false,
        maxRetries: 9
      },
      packages: ['npm:@example/headless']
    }))
    const service = new PiAgentSettingsService(agentDir)

    expect(service.getSettings()).toMatchObject({
      settingsPath: join(agentDir, 'settings.json'),
      autoCompactionEnabled: false,
      compactionReserveTokens: 8_192,
      compactionKeepRecentTokens: 12_000,
      transport: 'auto',
      httpIdleTimeoutMs: 300_000
    })

    const saved = await service.saveSettings({
      autoCompactionEnabled: true,
      transport: 'websocket',
      httpIdleTimeoutMs: 45_000
    })
    expect(saved).toMatchObject({
      autoCompactionEnabled: true,
      transport: 'websocket',
      httpIdleTimeoutMs: 45_000
    })

    const document = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'))
    expect(document.compaction).toEqual({
      enabled: true,
      reserveTokens: 8_192,
      keepRecentTokens: 12_000
    })
    expect(document.transport).toBe('websocket')
    expect(document.httpIdleTimeoutMs).toBe(45_000)
    expect(document.retry).toEqual({ enabled: false, maxRetries: 9 })
    expect(document.packages).toEqual(['npm:@example/headless'])
  })

  it('rejects invalid transport and timeout values before writing', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'oyster-pi-agent-settings-'))
    temporaryPaths.push(agentDir)
    const service = new PiAgentSettingsService(agentDir)

    expect(() => service.saveSettings({
      autoCompactionEnabled: true,
      transport: 'invalid' as 'auto',
      httpIdleTimeoutMs: 300_000
    })).toThrow('Pi Agent 传输方式无效')
    expect(() => service.saveSettings({
      autoCompactionEnabled: true,
      transport: 'auto',
      httpIdleTimeoutMs: -1
    })).toThrow('HTTP 空闲超时必须是非负整数毫秒数')
  })
})

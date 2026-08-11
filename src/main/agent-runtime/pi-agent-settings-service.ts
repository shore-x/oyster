import { join, resolve } from 'node:path'
import { SettingsManager } from '@earendil-works/pi-coding-agent'
import {
  PI_AGENT_TRANSPORTS,
  type PiAgentSettingsView,
  type PiAgentTransport,
  type SavePiAgentSettingsInput
} from '../../shared/pi-agent-settings'

function normalizedTransport(value: unknown): PiAgentTransport {
  if (!PI_AGENT_TRANSPORTS.includes(value as PiAgentTransport)) {
    throw new Error('Pi Agent 传输方式无效')
  }
  return value as PiAgentTransport
}

function normalizedTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('HTTP 空闲超时必须是非负整数毫秒数')
  }
  return value
}

/** Manages the effective file-backed Pi settings used by the general Chat Agent. */
export class PiAgentSettingsService {
  readonly agentDir: string
  readonly settingsPath: string
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(agentDir: string) {
    this.agentDir = resolve(agentDir)
    this.settingsPath = join(this.agentDir, 'settings.json')
  }

  private manager(): SettingsManager {
    return SettingsManager.create(this.agentDir, this.agentDir, { projectTrusted: false })
  }

  private view(manager: SettingsManager): PiAgentSettingsView {
    const compaction = manager.getCompactionSettings()
    const errors = manager.drainErrors()
    return {
      settingsPath: this.settingsPath,
      autoCompactionEnabled: compaction.enabled,
      compactionReserveTokens: compaction.reserveTokens,
      compactionKeepRecentTokens: compaction.keepRecentTokens,
      transport: manager.getTransport(),
      httpIdleTimeoutMs: manager.getHttpIdleTimeoutMs(),
      ...(errors.length ? {
        error: errors.map((item) => `${item.scope}: ${item.error.message}`).join('\n')
      } : {})
    }
  }

  getSettings(): PiAgentSettingsView {
    return this.view(this.manager())
  }

  saveSettings(input: SavePiAgentSettingsInput): Promise<PiAgentSettingsView> {
    if (typeof input?.autoCompactionEnabled !== 'boolean') {
      throw new Error('自动上下文压缩设置无效')
    }
    const transport = normalizedTransport(input.transport)
    const httpIdleTimeoutMs = normalizedTimeout(input.httpIdleTimeoutMs)
    let result!: PiAgentSettingsView
    const active = this.mutationQueue.then(async () => {
      const manager = this.manager()
      manager.setCompactionEnabled(input.autoCompactionEnabled)
      manager.setTransport(transport)
      manager.setHttpIdleTimeoutMs(httpIdleTimeoutMs)
      await manager.flush()
      result = this.view(manager)
    })
    this.mutationQueue = active.then(() => undefined, () => undefined)
    return active.then(() => result)
  }
}

import { join, resolve } from 'node:path'
import {
  SettingsManager,
  type PackageSource
} from '@earendil-works/pi-coding-agent'
import type {
  AddPiExtensionSourceInput,
  PiExtensionConfigurationView,
  PiExtensionSourceKind,
  PiExtensionSourceMutationInput,
  PiExtensionSourceView,
  SetPiExtensionSourceEnabledInput
} from '../../shared/pi-extensions'

const MAX_SOURCE_LENGTH = 8_192

function normalizedKind(value: unknown): PiExtensionSourceKind {
  if (value !== 'package' && value !== 'local') throw new Error('Extension 来源类型无效')
  return value
}

function normalizedSource(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Extension 来源必须是字符串')
  const source = value.trim()
  if (!source || source.length > MAX_SOURCE_LENGTH || /[\0\r\n]/.test(source)) {
    throw new Error('Extension 来源格式无效')
  }
  return source
}

function packageSource(value: PackageSource): string {
  return typeof value === 'string' ? value : value.source
}

function packageEnabled(value: PackageSource): boolean {
  return typeof value === 'string' || value.extensions === undefined || value.extensions.length > 0
}

function headlessPackage(source: string, enabled: boolean): PackageSource {
  return {
    source,
    // Only executable Headless Extensions enter the desktop Agent runtime.
    skills: [],
    prompts: [],
    themes: [],
    ...(enabled ? {} : { extensions: [] })
  }
}

function localSource(value: string): PiExtensionSourceView {
  const disabled = value.startsWith('-')
  return {
    kind: 'local',
    source: disabled ? value.slice(1) : value.startsWith('+') ? value.slice(1) : value,
    enabled: !disabled
  }
}

/** Thin file-backed management surface over Pi's own agentDir/settings.json. */
export class PiExtensionConfigurationService {
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

  private view(manager: SettingsManager): PiExtensionConfigurationView {
    const sources: PiExtensionSourceView[] = [
      ...manager.getPackages().map((item) => ({
        kind: 'package' as const,
        source: packageSource(item),
        enabled: packageEnabled(item)
      })),
      ...manager.getExtensionPaths().map(localSource)
    ]
    const errors = manager.drainErrors()
    return {
      agentDir: this.agentDir,
      settingsPath: this.settingsPath,
      sources,
      ...(errors.length ? {
        error: errors.map((item) => `${item.scope}: ${item.error.message}`).join('\n')
      } : {})
    }
  }

  getConfiguration(): PiExtensionConfigurationView {
    return this.view(this.manager())
  }

  private enqueue(
    operation: (manager: SettingsManager) => void
  ): Promise<PiExtensionConfigurationView> {
    let result!: PiExtensionConfigurationView
    const active = this.mutationQueue.then(async () => {
      const manager = this.manager()
      operation(manager)
      await manager.flush()
      result = this.view(manager)
    })
    this.mutationQueue = active.then(() => undefined, () => undefined)
    return active.then(() => result)
  }

  addSource(input: AddPiExtensionSourceInput): Promise<PiExtensionConfigurationView> {
    const kind = normalizedKind(input?.kind)
    const source = normalizedSource(input?.source)
    return this.enqueue((manager) => {
      if (kind === 'package') {
        if (manager.getPackages().some((item) => packageSource(item) === source)) {
          throw new Error('这个 Pi Package 已经存在')
        }
        manager.setPackages([...manager.getPackages(), headlessPackage(source, true)])
        return
      }
      if (manager.getExtensionPaths().map(localSource).some((item) => item.source === source)) {
        throw new Error('这个本地 Extension 已经存在')
      }
      manager.setExtensionPaths([...manager.getExtensionPaths(), source])
    })
  }

  setSourceEnabled(
    input: SetPiExtensionSourceEnabledInput
  ): Promise<PiExtensionConfigurationView> {
    const kind = normalizedKind(input?.kind)
    const source = normalizedSource(input?.source)
    if (typeof input?.enabled !== 'boolean') throw new Error('Extension 启用状态无效')
    return this.enqueue((manager) => {
      if (kind === 'package') {
        let found = false
        manager.setPackages(manager.getPackages().map((item) => {
          if (packageSource(item) !== source) return item
          found = true
          return headlessPackage(source, input.enabled)
        }))
        if (!found) throw new Error('Pi Package 不存在')
        return
      }
      let found = false
      manager.setExtensionPaths(manager.getExtensionPaths().map((item) => {
        const view = localSource(item)
        if (view.source !== source) return item
        found = true
        return input.enabled ? source : `-${source}`
      }))
      if (!found) throw new Error('本地 Extension 不存在')
    })
  }

  removeSource(input: PiExtensionSourceMutationInput): Promise<PiExtensionConfigurationView> {
    const kind = normalizedKind(input?.kind)
    const source = normalizedSource(input?.source)
    return this.enqueue((manager) => {
      if (kind === 'package') {
        const next = manager.getPackages().filter((item) => packageSource(item) !== source)
        if (next.length === manager.getPackages().length) throw new Error('Pi Package 不存在')
        manager.setPackages(next)
        return
      }
      const next = manager.getExtensionPaths().filter((item) => localSource(item).source !== source)
      if (next.length === manager.getExtensionPaths().length) throw new Error('本地 Extension 不存在')
      manager.setExtensionPaths(next)
    })
  }
}

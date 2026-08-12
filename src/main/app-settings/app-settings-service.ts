import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  APP_LANGUAGES,
  DEFAULT_APP_SETTINGS,
  type AppLanguage,
  type AppSettingsView,
  type SaveAppSettingsInput
} from '../../shared/app-settings'

function normalizedLanguage(value: unknown): AppLanguage {
  if (!APP_LANGUAGES.includes(value as AppLanguage)) throw new Error('语言设置无效')
  return value as AppLanguage
}

interface StoredAppSettings {
  uiLanguage: AppLanguage
  agentLanguage: AppLanguage
}

function parseSettings(value: unknown): StoredAppSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('应用设置必须是对象')
  }
  const settings = value as Record<string, unknown>
  // The original setting controlled both surfaces. Preserve that behavior when migrating it.
  if (settings.uiLanguage === undefined && settings.agentLanguage === undefined) {
    const legacyLanguage = normalizedLanguage(settings.language)
    return { uiLanguage: legacyLanguage, agentLanguage: legacyLanguage }
  }
  return {
    uiLanguage: normalizedLanguage(settings.uiLanguage),
    agentLanguage: normalizedLanguage(settings.agentLanguage)
  }
}

/** Owns independent UI locale and Agent output-language preferences. */
export class AppSettingsService {
  private uiLanguage: AppLanguage = DEFAULT_APP_SETTINGS.uiLanguage
  private agentLanguage: AppLanguage = DEFAULT_APP_SETTINGS.agentLanguage
  private configurationError?: string
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(readonly settingsPath: string) {}

  async initialize(): Promise<void> {
    this.uiLanguage = DEFAULT_APP_SETTINGS.uiLanguage
    this.agentLanguage = DEFAULT_APP_SETTINGS.agentLanguage
    this.configurationError = undefined
    try {
      const settings = parseSettings(JSON.parse(await readFile(this.settingsPath, 'utf8')))
      this.uiLanguage = settings.uiLanguage
      this.agentLanguage = settings.agentLanguage
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      this.configurationError = error instanceof Error ? error.message : String(error)
    }
  }

  get uiLanguageSetting(): AppLanguage {
    return this.uiLanguage
  }

  get agentLanguageSetting(): AppLanguage {
    return this.agentLanguage
  }

  getSettings(): AppSettingsView {
    return {
      uiLanguage: this.uiLanguage,
      agentLanguage: this.agentLanguage,
      settingsPath: this.settingsPath,
      ...(this.configurationError ? { error: this.configurationError } : {})
    }
  }

  saveSettings(input: SaveAppSettingsInput): Promise<AppSettingsView> {
    const uiLanguage = normalizedLanguage(input?.uiLanguage)
    const agentLanguage = normalizedLanguage(input?.agentLanguage)
    const write = async (): Promise<void> => {
      await mkdir(dirname(this.settingsPath), { recursive: true })
      const temporaryPath = `${this.settingsPath}.tmp`
      await writeFile(
        temporaryPath,
        `${JSON.stringify({ uiLanguage, agentLanguage }, null, 2)}\n`,
        'utf8'
      )
      await rename(temporaryPath, this.settingsPath)
      this.uiLanguage = uiLanguage
      this.agentLanguage = agentLanguage
      this.configurationError = undefined
    }
    this.writeQueue = this.writeQueue.then(write, write)
    return this.writeQueue.then(() => this.getSettings())
  }
}

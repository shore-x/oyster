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
  if (!APP_LANGUAGES.includes(value as AppLanguage)) throw new Error('应用语言无效')
  return value as AppLanguage
}

function parseSettings(value: unknown): { language: AppLanguage } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('应用设置必须是对象')
  }
  return {
    language: normalizedLanguage((value as Record<string, unknown>).language)
  }
}

/** Owns the single application language consumed by both UI and Agent invocations. */
export class AppSettingsService {
  private language: AppLanguage = DEFAULT_APP_SETTINGS.language
  private configurationError?: string
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(readonly settingsPath: string) {}

  async initialize(): Promise<void> {
    this.language = DEFAULT_APP_SETTINGS.language
    this.configurationError = undefined
    try {
      this.language = parseSettings(JSON.parse(await readFile(this.settingsPath, 'utf8'))).language
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      this.configurationError = error instanceof Error ? error.message : String(error)
    }
  }

  get languageSetting(): AppLanguage {
    return this.language
  }

  getSettings(): AppSettingsView {
    return {
      language: this.language,
      settingsPath: this.settingsPath,
      ...(this.configurationError ? { error: this.configurationError } : {})
    }
  }

  saveSettings(input: SaveAppSettingsInput): Promise<AppSettingsView> {
    const language = normalizedLanguage(input?.language)
    const write = async (): Promise<void> => {
      await mkdir(dirname(this.settingsPath), { recursive: true })
      const temporaryPath = `${this.settingsPath}.tmp`
      await writeFile(temporaryPath, `${JSON.stringify({ language }, null, 2)}\n`, 'utf8')
      await rename(temporaryPath, this.settingsPath)
      this.language = language
      this.configurationError = undefined
    }
    this.writeQueue = this.writeQueue.then(write, write)
    return this.writeQueue.then(() => this.getSettings())
  }
}

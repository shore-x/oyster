export const APP_LANGUAGES = ['zh-CN', 'en-US'] as const

export type AppLanguage = typeof APP_LANGUAGES[number]

export const DEFAULT_APP_SETTINGS = {
  language: 'zh-CN' as AppLanguage
}

export interface AppSettingsView {
  language: AppLanguage
  settingsPath: string
  error?: string
}

export interface SaveAppSettingsInput {
  language: AppLanguage
}

export interface AppSettingsApi {
  getSettings(): Promise<AppSettingsView>
  saveSettings(input: SaveAppSettingsInput): Promise<AppSettingsView>
}

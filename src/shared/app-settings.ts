export const APP_LANGUAGES = ['zh-CN', 'en-US'] as const

export type AppLanguage = typeof APP_LANGUAGES[number]

export const DEFAULT_APP_SETTINGS = {
  uiLanguage: 'zh-CN' as AppLanguage,
  agentLanguage: 'zh-CN' as AppLanguage
}

export interface AppSettingsView {
  uiLanguage: AppLanguage
  agentLanguage: AppLanguage
  settingsPath: string
  error?: string
}

export interface SaveAppSettingsInput {
  uiLanguage: AppLanguage
  agentLanguage: AppLanguage
}

export interface AppSettingsApi {
  getSettings(): Promise<AppSettingsView>
  saveSettings(input: SaveAppSettingsInput): Promise<AppSettingsView>
}

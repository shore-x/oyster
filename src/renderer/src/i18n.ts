import { createSignal } from 'solid-js'
import {
  DEFAULT_APP_SETTINGS,
  type AppLanguage,
  type AppSettingsView
} from '../../shared/app-settings'

const [language, setLanguage] = createSignal<AppLanguage>(DEFAULT_APP_SETTINGS.uiLanguage)
const [agentLanguage, setAgentLanguage] = createSignal<AppLanguage>(DEFAULT_APP_SETTINGS.agentLanguage)
const [settings, setSettings] = createSignal<AppSettingsView>()
const [loading, setLoading] = createSignal(true)
const [error, setError] = createSignal<string>()

function apply(value: AppSettingsView): void {
  setSettings(value)
  setLanguage(value.uiLanguage)
  setAgentLanguage(value.agentLanguage)
  setError(value.error)
  document.documentElement.lang = value.uiLanguage
}

export async function loadAppSettings(): Promise<void> {
  try {
    setLoading(true)
    setError(undefined)
    apply(await window.oyster.appSettings.getSettings())
  } catch (cause) {
    setError(cause instanceof Error ? cause.message : String(cause))
  } finally {
    setLoading(false)
  }
}

async function saveLanguages(uiLanguage: AppLanguage, nextAgentLanguage: AppLanguage): Promise<void> {
  try {
    setLoading(true)
    setError(undefined)
    apply(await window.oyster.appSettings.saveSettings({
      uiLanguage,
      agentLanguage: nextAgentLanguage
    }))
  } catch (cause) {
    setError(cause instanceof Error ? cause.message : String(cause))
  } finally {
    setLoading(false)
  }
}

export function saveUiLanguage(value: AppLanguage): Promise<void> {
  return saveLanguages(value, agentLanguage())
}

export function saveAgentLanguage(value: AppLanguage): Promise<void> {
  return saveLanguages(language(), value)
}

export function appLanguage(): AppLanguage {
  return language()
}

export function agentOutputLanguage(): AppLanguage {
  return agentLanguage()
}

export function currentAppSettings(): AppSettingsView | undefined {
  return settings()
}

export function appSettingsLoading(): boolean {
  return loading()
}

export function appSettingsError(): string | undefined {
  return error()
}

/** Bilingual UI text stays next to its product meaning; reading the signal makes JSX reactive. */
export function uiText(simplifiedChinese: string, english: string): string {
  return language() === 'en-US' ? english : simplifiedChinese
}

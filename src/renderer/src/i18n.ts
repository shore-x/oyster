import { createSignal } from 'solid-js'
import {
  DEFAULT_APP_SETTINGS,
  type AppLanguage,
  type AppSettingsView
} from '../../shared/app-settings'

const [language, setLanguage] = createSignal<AppLanguage>(DEFAULT_APP_SETTINGS.language)
const [settings, setSettings] = createSignal<AppSettingsView>()
const [loading, setLoading] = createSignal(true)
const [error, setError] = createSignal<string>()

function apply(value: AppSettingsView): void {
  setSettings(value)
  setLanguage(value.language)
  setError(value.error)
  document.documentElement.lang = value.language
}

export async function loadAppLanguage(): Promise<void> {
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

export async function saveAppLanguage(value: AppLanguage): Promise<void> {
  try {
    setLoading(true)
    setError(undefined)
    apply(await window.oyster.appSettings.saveSettings({ language: value }))
  } catch (cause) {
    setError(cause instanceof Error ? cause.message : String(cause))
  } finally {
    setLoading(false)
  }
}

export function appLanguage(): AppLanguage {
  return language()
}

export function appLanguageSettings(): AppSettingsView | undefined {
  return settings()
}

export function appLanguageLoading(): boolean {
  return loading()
}

export function appLanguageError(): string | undefined {
  return error()
}

/** Bilingual UI text stays next to its product meaning; reading the signal makes JSX reactive. */
export function uiText(simplifiedChinese: string, english: string): string {
  return language() === 'en-US' ? english : simplifiedChinese
}

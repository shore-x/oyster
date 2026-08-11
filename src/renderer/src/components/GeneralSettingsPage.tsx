import { Show } from 'solid-js'
import type { AppLanguage } from '../../../shared/app-settings'
import {
  appLanguage,
  appLanguageError,
  appLanguageLoading,
  appLanguageSettings,
  saveAppLanguage,
  uiText
} from '../i18n'
import { Icon } from '../ui'

export function GeneralSettingsPage() {
  return (
    <div class="general-settings" data-testid="general-settings-page">
      <Show when={appLanguageError()}>{(message) => (
        <div class="page-error" role="status"><Icon name="warning" />{message()}</div>
      )}</Show>

      <section class="settings-card">
        <div class="settings-card__heading">
          <div>
            <h2>{uiText('语言', 'Language')}</h2>
            <p>{uiText(
              '统一控制 Oyster 界面，以及 Agent 回复和维护仓库时使用的自然语言。',
              'Controls the Oyster interface and the natural language Agents use in replies and repository maintenance.'
            )}</p>
          </div>
        </div>
        <label class="general-setting-row">
          <span>
            <strong>{uiText('应用语言', 'Application language')}</strong>
            <small>{uiText(
              '切换后界面立即更新；新的 Agent Invocation 会自动收到相同的语言要求。',
              'The interface updates immediately; new Agent Invocations automatically receive the same language instruction.'
            )}</small>
          </span>
          <select
            value={appLanguage()}
            disabled={appLanguageLoading()}
            data-testid="app-language-select"
            aria-label={uiText('应用语言', 'Application language')}
            onChange={(event) => void saveAppLanguage(event.currentTarget.value as AppLanguage)}
          >
            <option value="zh-CN">简体中文</option>
            <option value="en-US">English</option>
          </select>
        </label>
      </section>

      <p class="general-settings__path" title={appLanguageSettings()?.settingsPath}>
        {appLanguageSettings()?.settingsPath || uiText('正在读取应用设置…', 'Reading application settings…')}
      </p>
    </div>
  )
}

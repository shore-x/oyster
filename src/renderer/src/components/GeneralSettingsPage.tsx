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
import { Button, Icon } from '../ui'

export function GeneralSettingsPage(props: {
  designDocumentsBusy?: 'browse' | 'open'
  designDocumentsError?: string
  onBrowseDesignDocuments(): void
  onOpenDesignDocuments(): void
}) {
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

      <section class="settings-card general-settings__documentation">
        <div class="settings-card__heading">
          <div>
            <h2>{uiText('Oyster 设计文档', 'Oyster Design Documents')}</h2>
            <p>{uiText(
              '查看随 Oyster 发布的产品、架构与决策文档。设计文档是应用资料，不属于工作台内容。',
              'View the product, architecture, and decision documents bundled with Oyster. These are application resources, not Workbench content.'
            )}</p>
          </div>
        </div>
        <Show when={props.designDocumentsError}>{(message) => (
          <div class="page-error general-settings__documentation-error" role="status">
            <Icon name="warning" />{message()}
          </div>
        )}</Show>
        <div class="general-setting-row">
          <span>
            <strong>{uiText('内置资料', 'Bundled Resources')}</strong>
            <small>{uiText(
              '可以在 Oyster 中浏览，也可以用系统文件管理器打开。',
              'Browse them in Oyster or open the folder in the system file manager.'
            )}</small>
          </span>
          <div class="general-setting-actions">
            <Button
              variant="secondary"
              icon="skill"
              data-testid="browse-design-documents"
              disabled={Boolean(props.designDocumentsBusy)}
              onClick={props.onBrowseDesignDocuments}
            >{props.designDocumentsBusy === 'browse' ? uiText('正在读取…', 'Reading…') : uiText('浏览', 'Browse')}</Button>
            <Button
              variant="ghost"
              icon="folder"
              data-testid="open-design-documents"
              disabled={Boolean(props.designDocumentsBusy)}
              onClick={props.onOpenDesignDocuments}
            >{props.designDocumentsBusy === 'open' ? uiText('正在打开…', 'Opening…') : uiText('打开文件夹', 'Open Folder')}</Button>
          </div>
        </div>
      </section>

      <p class="general-settings__path" title={appLanguageSettings()?.settingsPath}>
        {appLanguageSettings()?.settingsPath || uiText('正在读取应用设置…', 'Reading application settings…')}
      </p>
    </div>
  )
}

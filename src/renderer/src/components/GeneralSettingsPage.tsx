import { Show } from 'solid-js'
import type { AppLanguage } from '../../../shared/app-settings'
import {
  agentOutputLanguage,
  appLanguage,
  appSettingsError,
  appSettingsLoading,
  currentAppSettings,
  saveAgentLanguage,
  saveUiLanguage,
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
      <Show when={appSettingsError()}>{(message) => (
        <div class="page-error" role="status"><Icon name="warning" />{message()}</div>
      )}</Show>

      <section class="settings-card">
        <div class="settings-card__heading">
          <div>
            <h2>{uiText('语言', 'Languages')}</h2>
            <p>{uiText(
              '分别设置 Oyster 界面语言，以及 Agent 回复和维护 Repository 内容时使用的自然语言。',
              'Set the Oyster interface language independently from the language Agents use in replies and Repository content.'
            )}</p>
          </div>
        </div>
        <label class="general-setting-row">
          <span>
            <strong>{uiText('界面语言', 'Interface language')}</strong>
            <small>{uiText(
              '切换后界面、日期和数字格式会立即更新，不会改写现有内容。',
              'The interface, dates, and number formats update immediately without rewriting existing content.'
            )}</small>
          </span>
          <select
            value={appLanguage()}
            disabled={appSettingsLoading()}
            data-testid="ui-language-select"
            aria-label={uiText('界面语言', 'Interface language')}
            onChange={(event) => void saveUiLanguage(event.currentTarget.value as AppLanguage)}
          >
            <option value="zh-CN">简体中文</option>
            <option value="en-US">English</option>
          </select>
        </label>
        <label class="general-setting-row">
          <span>
            <strong>{uiText('Agent 输出语言', 'Agent output language')}</strong>
            <small>{uiText(
              '新的 Agent Invocation 会使用该语言回复，并维护自然语言形式的 Repository 内容；已有内容保持不变。',
              'New Agent Invocations use this language for replies and natural-language Repository content; existing content remains unchanged.'
            )}</small>
          </span>
          <select
            value={agentOutputLanguage()}
            disabled={appSettingsLoading()}
            data-testid="agent-language-select"
            aria-label={uiText('Agent 输出语言', 'Agent output language')}
            onChange={(event) => void saveAgentLanguage(event.currentTarget.value as AppLanguage)}
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

      <p class="general-settings__path" title={currentAppSettings()?.settingsPath}>
        {currentAppSettings()?.settingsPath || uiText('正在读取应用设置…', 'Reading application settings…')}
      </p>
    </div>
  )
}

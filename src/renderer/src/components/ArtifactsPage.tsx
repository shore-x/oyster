import { For, Show, createEffect, createSignal, type JSX } from 'solid-js'
import type { ArtifactSummary } from '../../../shared/artifacts'
import { createArtifactsController } from '../artifacts-controller'
import { appLanguage, uiText } from '../i18n'
import { Button, Icon, Markdown, Tab, TabList } from '../ui'
import { FolderBrowserPage } from './FolderBrowserPage'
import './ArtifactsPage.css'

function modifiedAtLabel(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(appLanguage(), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}

function attentionSummary(value: string): string {
  const compact = value
    .replace(/^\s{0,3}#{1,6}\s+/gmu, '')
    .replace(/\*\*([^*]+)\*\*/gu, '$1')
    .replace(/__([^_]+)__/gu, '$1')
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/^\s*[-*+]\s+/gmu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  return compact.length > 110 ? `${compact.slice(0, 109).trimEnd()}…` : compact
}

function FolderCard(props: {
  testId: string
  title: string
  description: string
  badge?: {
    class: string
    label: string
    testId?: string
  }
  browseTestId: string
  openTestId: string
  disabled?: boolean
  opening?: boolean
  onBrowse(): void
  onOpen(): void
  children?: JSX.Element
}) {
  return (
    <article class="folder-card" data-testid={props.testId}>
      <header class="folder-card__header">
        <span class="folder-card__mark"><Icon name="folder" /></span>
        <div class="folder-card__identity">
          <div class="folder-card__identity-heading">
            <h2>{props.title}</h2>
            <Show when={props.badge}>
              {(badge) => (
                <span class={`folder-card__badge ${badge().class}`} data-testid={badge().testId}>
                  {badge().label}
                </span>
              )}
            </Show>
          </div>
          <span>{props.description}</span>
        </div>
        <div class="folder-card__actions">
          <Button
            variant="secondary"
            icon="skill"
            data-testid={props.browseTestId}
            disabled={props.disabled}
            onClick={props.onBrowse}
          >{uiText('查看内容', 'View Content')}</Button>
          <Button
            variant="ghost"
            icon="folder"
            data-testid={props.openTestId}
            disabled={props.disabled}
            onClick={props.onOpen}
          >{props.opening ? uiText('正在打开…', 'Opening…') : uiText('打开文件夹', 'Open Folder')}</Button>
        </div>
      </header>
      {props.children}
    </article>
  )
}

function ArtifactCard(props: {
  artifact: ArtifactSummary
  busy?: string
  onBrowse(): void
  onOpen(): void
  onManageSkill(): void
}) {
  return (
    <FolderCard
      testId="artifact-card"
      title={props.artifact.directoryName}
      description={`${uiText('说明更新于', 'Guidance updated')} ${modifiedAtLabel(props.artifact.modifiedAt)}`}
      badge={props.artifact.skill ? {
        class: 'artifact-skill-badge',
        label: 'Skill',
        testId: 'artifact-skill-badge'
      } : undefined}
      browseTestId="browse-artifact"
      openTestId="open-artifact"
      disabled={Boolean(props.busy)}
      opening={props.busy === `open:${props.artifact.directoryName}`}
      onBrowse={props.onBrowse}
      onOpen={props.onOpen}
    >
      <details class="artifact-card__details ui-disclosure">
        <summary>
          <span class="artifact-card__details-summary">
            <strong>{uiText('目标与维护说明', 'Goals and Maintenance Guidance')}</strong>
            <span>{attentionSummary(props.artifact.attention) || uiText('暂无维护说明', 'No maintenance guidance')}</span>
          </span>
        </summary>
        <div class="ui-disclosure__content">
          <Show when={props.artifact.skill}>
            {(skill) => (
              <section class={`artifact-card__skill artifact-card__skill--${skill().status}`} data-testid="artifact-skill-summary">
                <div class="artifact-card__skill-identity">
                  <div>
                    <strong>{skill().name || 'Skill'}</strong>
                    <span>{skill().status === 'ready'
                      ? uiText('可在目标 Agent 中绑定', 'Can be bound in target Agents')
                      : uiText('当前 Skill 暂不可绑定', 'This Skill cannot be bound')}</span>
                  </div>
                  <span class={`artifact-card__skill-status artifact-card__skill-status--${skill().status}`}>
                    {skill().status === 'ready' ? uiText('可绑定', 'Ready') : uiText('声明无效', 'Invalid declaration')}
                  </span>
                </div>
                <code data-testid="artifact-skill-path" title={skill().skillPath}>{skill().skillPath}</code>
                <Show when={skill().issue}>
                  <p><Icon name="warning" />{skill().issue}</p>
                </Show>
                <div class="artifact-card__skill-actions">
                  <Button
                    variant="secondary"
                    icon="link"
                    data-testid="manage-artifact-skill"
                    disabled={Boolean(props.busy)}
                    onClick={props.onManageSkill}
                  >{uiText('在 Skills 中管理', 'Manage in Skills')}</Button>
                </div>
              </section>
            )}
          </Show>
          <div class="artifact-card__attention-label">
            {uiText('目标与维护说明', 'Goals and Maintenance Guidance')}
          </div>
          <Markdown
            class="artifact-card__attention"
            text={props.artifact.attention}
          />
        </div>
      </details>
    </FolderCard>
  )
}

export interface ArtifactBrowserTarget {
  folderPath: string
  label: string
}

export function ArtifactsPage(props: {
  browserTarget?: ArtifactBrowserTarget
  onBrowseArtifact(artifact: ArtifactSummary): void
  onCloseBrowser?(): void
  onStartConversation(): void
  onManageSkill(artifactDirectoryName: string): void
}) {
  const controller = createArtifactsController()
  const [view, setView] = createSignal<'overview' | 'files'>('overview')

  createEffect(() => {
    if (props.browserTarget) setView('files')
  })

  return (
    <div class="artifacts-page" data-testid="artifacts-page">
      <header class="page-header">
        <div>
          <h1>{uiText('工作台', 'Workbench')}</h1>
          <div class="page-summary">
            <span><strong>{controller.snapshot()?.artifacts.length ?? '—'}</strong> {uiText('项内容', 'items')}</span>
            <span class="page-summary__separator">·</span>
            <span>{uiText('与 Agent 共同创建和维护', 'Created and maintained with Agents')}</span>
          </div>
        </div>
        <div class="page-header__actions">
          <Show when={view() === 'overview'}>
            <Button
              variant="primary"
              icon="chat"
              data-testid="start-artifact-conversation"
              onClick={props.onStartConversation}
            >{uiText('与 Agent 对话', 'Chat with Agent')}</Button>
            <Button
              variant="secondary"
              icon="refresh"
              data-testid="refresh-artifacts"
              disabled={Boolean(controller.busy())}
              onClick={() => void controller.refresh()}
            >{controller.busy() === 'refresh' ? uiText('正在刷新…', 'Refreshing…') : uiText('刷新', 'Refresh')}</Button>
          </Show>
        </div>
      </header>

      <TabList class="page-tabs artifacts-page__tabs" ariaLabel={uiText('工作台视图', 'Workbench views')}>
        <Tab
          data-testid="artifacts-tab-overview"
          selected={view() === 'overview'}
          onClick={() => setView('overview')}
        >{uiText('概览', 'Overview')}</Tab>
        <Tab
          data-testid="artifacts-tab-files"
          selected={view() === 'files'}
          onClick={() => setView('files')}
        >{uiText('文件', 'Files')}</Tab>
      </TabList>

      <div class="artifacts-page__panel artifacts-page__panel--overview" hidden={view() !== 'overview'}>
        <Show when={controller.error()}>
          <div class="page-error" role="alert"><Icon name="warning" />{controller.error()}</div>
        </Show>

        <Show when={(controller.snapshot()?.invalidDirectories.length ?? 0) > 0}>
          <section class="artifact-invalid" data-testid="invalid-artifact-directories" aria-labelledby="artifact-invalid-title">
            <div class="artifact-invalid__heading">
              <Icon name="warning" />
              <div>
                <h2 id="artifact-invalid-title">{uiText('未识别的文件夹', 'Unrecognized Folders')}</h2>
                <p>{uiText(
                  '以下文件夹缺少可读取的 AGENTS.md，因此暂时无法在工作台中展示。',
                  'These folders lack a readable AGENTS.md and cannot currently appear in the Workbench.'
                )}</p>
              </div>
            </div>
            <ul>
              <For each={controller.snapshot()?.invalidDirectories ?? []}>
                {(directory) => <li><code>{directory}</code></li>}
              </For>
            </ul>
          </section>
        </Show>

        <section class="artifact-list" aria-label={uiText('工作台内容', 'Workbench content')}>
          <Show
            when={controller.snapshot()}
            fallback={(
              <div class="artifact-list__empty">
                <Icon name="folder" />
                <strong>{controller.error()
                  ? uiText('无法读取工作台内容', 'Unable to Read Workbench Content')
                  : uiText('正在读取工作台…', 'Reading Workbench…')}</strong>
                <p>{controller.error()
                  ? uiText('请检查错误信息并刷新重试。', 'Check the error and refresh to retry.')
                  : uiText('正在加载你与 Agent 共同维护的内容。', 'Loading content maintained with Agents.')}</p>
              </div>
            )}
          >
            {(snapshot) => (
              <Show
                when={snapshot().artifacts.length > 0}
                fallback={(
                  <div class="artifact-list__empty">
                    <Icon name="folder" />
                    <strong>{uiText('工作台中还没有内容', 'The Workbench Is Empty')}</strong>
                    <p>{uiText(
                      '在对话中告诉 Agent 你想完成什么，它会在需要时创建并维护相应内容。',
                      'Tell the Agent what you want to accomplish; it will create and maintain the appropriate content when needed.'
                    )}</p>
                    <Button variant="primary" icon="chat" onClick={props.onStartConversation}>
                      {uiText('与 Agent 开始', 'Start with Agent')}
                    </Button>
                  </div>
                )}
              >
                <For each={snapshot().artifacts}>
                  {(artifact) => (
                    <ArtifactCard
                      artifact={artifact}
                      busy={controller.busy()}
                      onBrowse={() => props.onBrowseArtifact(artifact)}
                      onOpen={() => void controller.openFolder(
                        artifact.directoryPath,
                        artifact.directoryName
                      )}
                      onManageSkill={() => props.onManageSkill(artifact.directoryName)}
                    />
                  )}
                </For>
              </Show>
            )}
          </Show>
        </section>
      </div>

      <div class="artifacts-page__panel artifacts-page__panel--files" hidden={view() !== 'files'}>
        <Show
          when={props.browserTarget}
          fallback={(
            <div class="artifacts-page__file-empty">
              <Icon name="folder" />
              <strong>{uiText('选择一项内容', 'Select an Item')}</strong>
              <p>{uiText('回到“概览”，从一项工作台内容进入文件浏览。', 'Return to Overview and open Files from a Workbench item.')}</p>
              <Button variant="secondary" icon="back" onClick={() => setView('overview')}>{uiText('返回概览', 'Back to Overview')}</Button>
            </div>
          )}
        >
          {(target) => (
            <div data-testid="page-folder-browser">
              <FolderBrowserPage
                embedded
                folderPath={target().folderPath}
                label={target().label}
                onBack={() => {
                  setView('overview')
                  props.onCloseBrowser?.()
                }}
              />
            </div>
          )}
        </Show>
      </div>
    </div>
  )
}

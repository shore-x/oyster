import { For, Show, createEffect, createSignal, type JSX } from 'solid-js'
import type { ArtifactSummary } from '../../../shared/artifacts'
import { createArtifactsController } from '../artifacts-controller'
import { Button, Icon, Markdown } from '../ui'
import { FolderBrowserPage } from './FolderBrowserPage'
import './ArtifactsPage.css'
import { appLanguage, uiText } from '../i18n'

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
  const compact = value.replace(/\s+/gu, ' ').trim()
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
          >{uiText('浏览', 'Browse')}</Button>
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
      description={`${uiText('AGENTS.md 更新于', 'AGENTS.md updated')} ${modifiedAtLabel(props.artifact.modifiedAt)}`}
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
            <strong>{uiText('Attention 与绑定详情', 'Attention and Binding Details')}</strong>
            <span>{attentionSummary(props.artifact.attention) || uiText('暂无 Attention 内容', 'No Attention content')}</span>
          </span>
        </summary>
        <div class="ui-disclosure__content">
          <Show when={props.artifact.skill}>
            {(skill) => (
              <section class={`artifact-card__skill artifact-card__skill--${skill().status}`} data-testid="artifact-skill-summary">
                <div class="artifact-card__skill-identity">
                  <div>
                    <strong>{skill().name || uiText('Skill 输出', 'Skill output')}</strong>
                    <span>{skill().status === 'ready'
                      ? uiText('可在目标 Agent 中绑定', 'Can be bound in target Agents')
                      : uiText('输出暂不可绑定', 'Output cannot be bound')}</span>
                  </div>
                  <span class={`artifact-card__skill-status artifact-card__skill-status--${skill().status}`}>
                    {skill().status === 'ready' ? uiText('可绑定', 'Ready') : uiText('输出无效', 'Invalid output')}
                  </span>
                </div>
                <code data-testid="artifact-skill-output-path" title={skill().outputPath}>{skill().outputPath}</code>
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
          <div class="artifact-card__attention-label">AGENTS.md · Attention</div>
          <Markdown
            class="artifact-card__attention"
            text={props.artifact.attention}
          />
        </div>
      </details>
    </FolderCard>
  )
}

function DesignDocumentsCard(props: {
  opening: boolean
  onBrowse(): void
  onOpen(): void
}) {
  return (
    <FolderCard
      testId="design-documents-card"
      title={uiText('Oyster 设计文档', 'Oyster Design Documents')}
      description={uiText('随 Oyster 发布的产品、架构与决策文档', 'Product, architecture, and decision documents bundled with Oyster')}
      badge={{ class: 'artifact-built-in-badge', label: uiText('内置', 'Built-in') }}
      browseTestId="browse-design-documents"
      openTestId="open-design-documents"
      disabled={props.opening}
      opening={props.opening}
      onBrowse={props.onBrowse}
      onOpen={props.onOpen}
    />
  )
}

export interface ArtifactBrowserTarget {
  folderPath: string
  label: string
}

export function ArtifactsPage(props: {
  browserTarget?: ArtifactBrowserTarget
  onBrowseDesignDocuments(): void
  onOpenDesignDocuments(): Promise<void>
  onBrowseArtifact(artifact: ArtifactSummary): void
  onCloseBrowser?(): void
  onManageSkill(artifactDirectoryName: string): void
}) {
  const controller = createArtifactsController()
  const [view, setView] = createSignal<'overview' | 'files'>('overview')
  const [directoryName, setDirectoryName] = createSignal('')
  const [attention, setAttention] = createSignal('')
  const [openingDesignDocuments, setOpeningDesignDocuments] = createSignal(false)

  createEffect(() => {
    if (props.browserTarget) setView('files')
  })

  async function createArtifact(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    const input = {
      directoryName: directoryName().trim(),
      attention: attention().trim()
    }
    if (!controller.snapshot() || !input.directoryName || !input.attention) return
    if (await controller.createArtifact(input)) {
      setDirectoryName('')
      setAttention('')
    }
  }

  async function openDesignDocuments(): Promise<void> {
    setOpeningDesignDocuments(true)
    try {
      await props.onOpenDesignDocuments()
    } finally {
      setOpeningDesignDocuments(false)
    }
  }

  return (
    <div class="artifacts-page" data-testid="artifacts-page">
      <header class="page-header">
        <div>
          <h1>{uiText('产物', 'Artifacts')}</h1>
          <div class="page-summary">
            <span><strong>1</strong> {uiText('组设计文档', 'design document set')}</span>
            <span class="page-summary__separator">·</span>
            <span><strong>{controller.snapshot()?.artifacts.length ?? '—'}</strong> Artifacts</span>
          </div>
        </div>
        <div class="page-header__actions">
          <Show when={view() === 'overview'}>
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

      <div class="page-tabs artifacts-page__tabs" role="tablist" aria-label={uiText('产物视图', 'Artifact views')}>
        <button
          type="button"
          role="tab"
          data-testid="artifacts-tab-overview"
          aria-selected={view() === 'overview'}
          onClick={() => setView('overview')}
        >{uiText('概览', 'Overview')}</button>
        <button
          type="button"
          role="tab"
          data-testid="artifacts-tab-files"
          aria-selected={view() === 'files'}
          onClick={() => setView('files')}
        >{uiText('文件', 'Files')}</button>
      </div>

      <div class="artifacts-page__panel artifacts-page__panel--overview" hidden={view() !== 'overview'}>
      <Show when={controller.error()}>
        <div class="page-error" role="alert"><Icon name="warning" />{controller.error()}</div>
      </Show>

      <section class="artifact-repository" aria-labelledby="artifact-repository-title">
        <div>
          <h2 id="artifact-repository-title">Oyster Repository</h2>
          <p>{uiText(
            'Artifact 位于统一仓库的 artifacts/；其中一级子文件夹存在 AGENTS.md 时，即识别为一个 Artifact。',
            'Artifacts live under artifacts/ in the unified Repository; a first-level folder with an AGENTS.md is recognized as an Artifact.'
          )}</p>
          <code data-testid="artifact-repository-path">
            {controller.snapshot()?.repositoryPath || (controller.busy() === 'load' ? uiText('正在读取…', 'Reading…') : '—')}
          </code>
        </div>
        <Button
          variant="secondary"
          icon="folder"
          data-testid="open-artifact-repository"
          disabled={Boolean(controller.busy()) || !controller.snapshot()?.repositoryPath}
          onClick={() => void controller.openRepository()}
        >{controller.busy() === 'open-repository' ? uiText('正在打开…', 'Opening…') : uiText('打开仓库', 'Open Repository')}</Button>
      </section>

      <details class="artifact-create ui-disclosure">
        <summary>
          <span class="artifact-create__heading">
            <h2 id="artifact-create-title">{uiText('创建 Artifact', 'Create Artifact')}</h2>
            <p>{uiText('按需展开，填写文件夹名称与长期 Attention。', 'Expand when needed and provide a folder name and durable Attention.')}</p>
          </span>
        </summary>
        <div class="ui-disclosure__content">
          <form data-testid="artifact-create-form" onSubmit={(event) => void createArtifact(event)}>
          <label class="artifact-field">
            <span>{uiText('文件夹名称', 'Folder Name')}</span>
            <input
              type="text"
              required
              autocomplete="off"
              data-testid="artifact-directory-name"
              value={directoryName()}
              placeholder={uiText('例如 agent-memory-tracking', 'For example, agent-memory-tracking')}
              disabled={controller.busy() === 'create'}
              onInput={(event) => setDirectoryName(event.currentTarget.value)}
            />
          </label>
          <label class="artifact-field artifact-field--attention">
            <span>Attention</span>
            <textarea
              required
              data-testid="artifact-attention"
              value={attention()}
              placeholder={uiText(
                '描述这个 Artifact 长期关注的目标、范围和维护原则。',
                'Describe this Artifact’s long-term goals, scope, and maintenance principles.'
              )}
              disabled={controller.busy() === 'create'}
              onInput={(event) => setAttention(event.currentTarget.value)}
            />
          </label>
          <div class="artifact-create__actions">
            <Button
              type="submit"
              variant="primary"
              icon="plus"
              data-testid="create-artifact"
              disabled={
                Boolean(controller.busy())
                || !controller.snapshot()
                || !directoryName().trim()
                || !attention().trim()
              }
            >{controller.busy() === 'create' ? uiText('正在创建…', 'Creating…') : uiText('创建 Artifact', 'Create Artifact')}</Button>
          </div>
          </form>
        </div>
      </details>

      <Show when={(controller.snapshot()?.invalidDirectories.length ?? 0) > 0}>
        <section class="artifact-invalid" data-testid="invalid-artifact-directories" aria-labelledby="artifact-invalid-title">
          <div class="artifact-invalid__heading">
            <Icon name="warning" />
            <div>
              <h2 id="artifact-invalid-title">{uiText('未识别的文件夹', 'Unrecognized Folders')}</h2>
              <p>{uiText(
                '以下可见一级目录缺少可读取的普通 AGENTS.md，因此不会作为 Artifact 展示。',
                'These visible first-level directories lack a readable regular AGENTS.md and are not shown as Artifacts.'
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

      <section class="artifact-list" aria-label={uiText('产物', 'Artifacts')}>
        <DesignDocumentsCard
          opening={openingDesignDocuments()}
          onBrowse={props.onBrowseDesignDocuments}
          onOpen={() => void openDesignDocuments()}
        />
        <Show
          when={controller.snapshot()}
          fallback={(
            <div class="artifact-list__empty">
              <Icon name="folder" />
              <strong>{controller.error() ? uiText('无法读取 Artifact', 'Unable to Read Artifacts') : uiText('正在读取 Artifact…', 'Reading Artifacts…')}</strong>
              <p>{controller.error()
                ? uiText('请检查错误信息并刷新重试。', 'Check the error and refresh to retry.')
                : uiText('正在加载统一 Repository 的 Artifact 文件层。', 'Loading the Artifact file layer from the unified Repository.')}</p>
            </div>
          )}
        >
          {(snapshot) => (
            <Show
              when={snapshot().artifacts.length > 0}
              fallback={(
                <div class="artifact-list__empty">
                  <Icon name="folder" />
                  <strong>{uiText('还没有 Artifact', 'No Artifacts Yet')}</strong>
                  <p>{uiText(
                    '创建后，APP 会在固定仓库目录中生成文件夹和 AGENTS.md。',
                    'After creation, the app generates a folder and AGENTS.md in the fixed Repository directory.'
                  )}</p>
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
              <strong>{uiText('选择一个文件夹', 'Select a Folder')}</strong>
              <p>{uiText('回到“概览”，从设计文档或 Artifact 卡片进入文件浏览。', 'Return to Overview and open Files from a design document or Artifact card.')}</p>
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

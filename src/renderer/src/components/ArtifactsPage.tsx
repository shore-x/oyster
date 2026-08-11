import { For, Show, createEffect, createSignal, type JSX } from 'solid-js'
import type { ArtifactSummary } from '../../../shared/artifacts'
import { createArtifactsController } from '../artifacts-controller'
import { Button, Icon, Markdown } from '../ui'
import { FolderBrowserPage } from './FolderBrowserPage'
import './ArtifactsPage.css'

function modifiedAtLabel(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
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
          >浏览</Button>
          <Button
            variant="ghost"
            icon="folder"
            data-testid={props.openTestId}
            disabled={props.disabled}
            onClick={props.onOpen}
          >{props.opening ? '正在打开…' : '打开文件夹'}</Button>
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
      description={`AGENTS.md 更新于 ${modifiedAtLabel(props.artifact.modifiedAt)}`}
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
            <strong>Attention 与绑定详情</strong>
            <span>{attentionSummary(props.artifact.attention) || '暂无 Attention 内容'}</span>
          </span>
        </summary>
        <div class="ui-disclosure__content">
          <Show when={props.artifact.skill}>
            {(skill) => (
              <section class={`artifact-card__skill artifact-card__skill--${skill().status}`} data-testid="artifact-skill-summary">
                <div class="artifact-card__skill-identity">
                  <div>
                    <strong>{skill().name || 'Skill 输出'}</strong>
                    <span>{skill().status === 'ready' ? '可在目标 Agent 中绑定' : '输出暂不可绑定'}</span>
                  </div>
                  <span class={`artifact-card__skill-status artifact-card__skill-status--${skill().status}`}>
                    {skill().status === 'ready' ? '可绑定' : '输出无效'}
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
                  >在 Skills 中管理</Button>
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
      title="Oyster 设计文档"
      description="随 Oyster 发布的产品、架构与决策文档"
      badge={{ class: 'artifact-built-in-badge', label: '内置' }}
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
          <h1>产物</h1>
          <div class="page-summary">
            <span><strong>1</strong> 组设计文档</span>
            <span class="page-summary__separator">·</span>
            <span><strong>{controller.snapshot()?.artifacts.length ?? '—'}</strong> 个 Artifact</span>
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
            >{controller.busy() === 'refresh' ? '正在刷新…' : '刷新'}</Button>
          </Show>
        </div>
      </header>

      <div class="page-tabs artifacts-page__tabs" role="tablist" aria-label="产物视图">
        <button
          type="button"
          role="tab"
          data-testid="artifacts-tab-overview"
          aria-selected={view() === 'overview'}
          onClick={() => setView('overview')}
        >概览</button>
        <button
          type="button"
          role="tab"
          data-testid="artifacts-tab-files"
          aria-selected={view() === 'files'}
          onClick={() => setView('files')}
        >文件</button>
      </div>

      <div class="artifacts-page__panel artifacts-page__panel--overview" hidden={view() !== 'overview'}>
      <Show when={controller.error()}>
        <div class="page-error" role="alert"><Icon name="warning" />{controller.error()}</div>
      </Show>

      <section class="artifact-repository" aria-labelledby="artifact-repository-title">
        <div>
          <h2 id="artifact-repository-title">Oyster Repository</h2>
          <p>Artifact 位于统一仓库的 artifacts/；其中一级子文件夹存在 AGENTS.md 时，即识别为一个 Artifact。</p>
          <code data-testid="artifact-repository-path">
            {controller.snapshot()?.repositoryPath || (controller.busy() === 'load' ? '正在读取…' : '—')}
          </code>
        </div>
        <Button
          variant="secondary"
          icon="folder"
          data-testid="open-artifact-repository"
          disabled={Boolean(controller.busy()) || !controller.snapshot()?.repositoryPath}
          onClick={() => void controller.openRepository()}
        >{controller.busy() === 'open-repository' ? '正在打开…' : '打开仓库'}</Button>
      </section>

      <details class="artifact-create ui-disclosure">
        <summary>
          <span class="artifact-create__heading">
            <h2 id="artifact-create-title">创建 Artifact</h2>
            <p>按需展开，填写文件夹名称与长期 Attention。</p>
          </span>
        </summary>
        <div class="ui-disclosure__content">
          <form data-testid="artifact-create-form" onSubmit={(event) => void createArtifact(event)}>
          <label class="artifact-field">
            <span>文件夹名称</span>
            <input
              type="text"
              required
              autocomplete="off"
              data-testid="artifact-directory-name"
              value={directoryName()}
              placeholder="例如 agent-memory-tracking"
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
              placeholder="描述这个 Artifact 长期关注的目标、范围和维护原则。"
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
            >{controller.busy() === 'create' ? '正在创建…' : '创建 Artifact'}</Button>
          </div>
          </form>
        </div>
      </details>

      <Show when={(controller.snapshot()?.invalidDirectories.length ?? 0) > 0}>
        <section class="artifact-invalid" data-testid="invalid-artifact-directories" aria-labelledby="artifact-invalid-title">
          <div class="artifact-invalid__heading">
            <Icon name="warning" />
            <div>
              <h2 id="artifact-invalid-title">未识别的文件夹</h2>
              <p>以下可见一级目录缺少可读取的普通 AGENTS.md，因此不会作为 Artifact 展示。</p>
            </div>
          </div>
          <ul>
            <For each={controller.snapshot()?.invalidDirectories ?? []}>
              {(directory) => <li><code>{directory}</code></li>}
            </For>
          </ul>
        </section>
      </Show>

      <section class="artifact-list" aria-label="产物">
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
              <strong>{controller.error() ? '无法读取 Artifact' : '正在读取 Artifact…'}</strong>
              <p>{controller.error() ? '请检查错误信息并刷新重试。' : '正在加载统一 Repository 的 Artifact 文件层。'}</p>
            </div>
          )}
        >
          {(snapshot) => (
            <Show
              when={snapshot().artifacts.length > 0}
              fallback={(
                <div class="artifact-list__empty">
                  <Icon name="folder" />
                  <strong>还没有 Artifact</strong>
                  <p>创建后，APP 会在固定仓库目录中生成文件夹和 AGENTS.md。</p>
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
              <strong>选择一个文件夹</strong>
              <p>回到“概览”，从设计文档或 Artifact 卡片进入文件浏览。</p>
              <Button variant="secondary" icon="back" onClick={() => setView('overview')}>返回概览</Button>
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

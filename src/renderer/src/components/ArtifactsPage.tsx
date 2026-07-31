import { For, Show, createSignal } from 'solid-js'
import type { ArtifactSummary } from '../../../shared/artifacts'
import { createArtifactsController } from '../artifacts-controller'
import { Button, Icon, Markdown } from '../ui'
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

function ArtifactCard(props: {
  artifact: ArtifactSummary
  busy?: string
  onOpen(): void
}) {
  return (
    <article class="artifact-card" data-testid="artifact-card">
      <header class="artifact-card__header">
        <span class="artifact-card__mark"><Icon name="folder" /></span>
        <div class="artifact-card__identity">
          <h2>{props.artifact.directoryName}</h2>
          <span>AGENTS.md 更新于 {modifiedAtLabel(props.artifact.modifiedAt)}</span>
        </div>
        <Button
          variant="ghost"
          icon="folder"
          data-testid="open-artifact"
          disabled={Boolean(props.busy)}
          onClick={props.onOpen}
        >{props.busy === `open:${props.artifact.directoryName}` ? '正在打开…' : '打开文件夹'}</Button>
      </header>
      <div class="artifact-card__attention-label">AGENTS.md · Attention</div>
      <Markdown
        class="artifact-card__attention"
        text={props.artifact.attention}
      />
    </article>
  )
}

export function ArtifactsPage() {
  const controller = createArtifactsController()
  const [directoryName, setDirectoryName] = createSignal('')
  const [attention, setAttention] = createSignal('')

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

  return (
    <div class="artifacts-page" data-testid="artifacts-page">
      <header class="page-header">
        <div>
          <h1>协作产物</h1>
          <div class="page-summary">
            <span><strong>{controller.snapshot()?.artifacts.length ?? '—'}</strong> 个 Artifact</span>
            <span class="page-summary__separator">·</span>
            <span>由本地文件夹直接承载</span>
          </div>
        </div>
        <div class="page-header__actions">
          <Button
            variant="secondary"
            icon="refresh"
            data-testid="refresh-artifacts"
            disabled={Boolean(controller.busy())}
            onClick={() => void controller.refresh()}
          >{controller.busy() === 'refresh' ? '正在刷新…' : '刷新'}</Button>
        </div>
      </header>

      <Show when={controller.error()}>
        <div class="page-error" role="alert"><Icon name="warning" />{controller.error()}</div>
      </Show>

      <section class="artifact-repository" aria-labelledby="artifact-repository-title">
        <div>
          <h2 id="artifact-repository-title">Artifact Repository</h2>
          <p>APP 管理的固定目录。一级子文件夹中存在 AGENTS.md 时，即识别为一个 Artifact。</p>
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

      <section class="artifact-create" aria-labelledby="artifact-create-title">
        <div class="artifact-create__heading">
          <h2 id="artifact-create-title">创建 Artifact</h2>
          <p>文件夹名称用于标识 Artifact；AGENTS.md 描述需要长期关注和维护的内容。</p>
        </div>
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
      </section>

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

      <section class="artifact-list" aria-label="Artifacts">
        <Show
          when={controller.snapshot()}
          fallback={(
            <div class="artifact-list__empty">
              <Icon name="folder" />
              <strong>{controller.error() ? '无法读取 Artifact' : '正在读取 Artifact…'}</strong>
              <p>{controller.error() ? '请检查错误信息并刷新重试。' : '正在加载固定 Artifact Repository。'}</p>
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
                    onOpen={() => void controller.openArtifact(artifact.directoryName)}
                  />
                )}
              </For>
            </Show>
          )}
        </Show>
      </section>
    </div>
  )
}

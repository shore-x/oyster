import { For, Show, createEffect, createMemo, createSignal } from 'solid-js'
import type {
  DiscoveredSkill,
  ManagedSkillBindingInput,
  ManagedSkillSummary,
  SkillBindingTargetState,
  SkillBindingTargetSummary,
  SkillScope
} from '../../../shared/skills'
import {
  createManagedSkillsController,
  managedSkillOperationKey
} from '../managed-skills-controller'
import { createSkillDiscoveryController } from '../skill-discovery-controller'
import { Button, Icon, Markdown } from '../ui'
import './SkillsPage.css'
import { appLanguage, uiText } from '../i18n'

export type SkillsPageView = 'managed' | 'external'

export interface SkillsNavigationRequest {
  artifactDirectoryName: string
  version: number
}

export interface SkillsPageProps {
  navigationRequest?: SkillsNavigationRequest
  /** Useful for direct links and isolated rendering; the application defaults to managed Skills. */
  initialView?: SkillsPageView
}

export function skillScopeLabel(scope: SkillScope): string {
  return {
    user: uiText('全局', 'Global'),
    project: uiText('项目', 'Project'),
    admin: uiText('管理', 'Admin'),
    system: uiText('系统', 'System'),
    other: uiText('其他', 'Other')
  }[scope]
}

export function skillBindingStateLabel(state: SkillBindingTargetState): string {
  return {
    unbound: uiText('未绑定', 'Unbound'),
    bound: uiText('已绑定', 'Bound'),
    conflict: uiText('冲突', 'Conflict'),
    error: uiText('错误', 'Error')
  }[state]
}

export function groupSkillsByAgent(skills: readonly DiscoveredSkill[]) {
  const groups = new Map<DiscoveredSkill['agentType'], {
    agentType: DiscoveredSkill['agentType']
    agentDisplayName: string
    skills: DiscoveredSkill[]
  }>()

  for (const skill of skills) {
    const existing = groups.get(skill.agentType)
    if (existing) {
      existing.skills.push(skill)
      continue
    }
    groups.set(skill.agentType, {
      agentType: skill.agentType,
      agentDisplayName: skill.agentDisplayName,
      skills: [skill]
    })
  }

  return [...groups.values()]
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** unit
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

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

function SkillListItem(props: {
  skill: DiscoveredSkill
  selected: boolean
  onSelect(): void
}) {
  return (
    <button
      type="button"
      class="skills-browser__item"
      data-testid="skill-list-item"
      aria-selected={props.selected}
      onClick={props.onSelect}
    >
      <strong>{props.skill.name}</strong>
      <span class="skills-browser__item-badges">
        <span class={`skill-scope skill-scope--${props.skill.scope}`}>
          {skillScopeLabel(props.skill.scope)}
        </span>
      </span>
      <Show when={props.skill.scope === 'project' && props.skill.projectPath}>
        <code title={props.skill.projectPath}>{props.skill.projectPath}</code>
      </Show>
    </button>
  )
}

function ManagedSkillListItem(props: {
  skill: ManagedSkillSummary
  selected: boolean
  onSelect(): void
}) {
  const boundCount = () => props.skill.targets.filter((target) => target.state === 'bound').length
  return (
    <button
      type="button"
      class="skills-browser__item managed-skill-list-item"
      data-testid="managed-skill-list-item"
      aria-selected={props.selected}
      onClick={props.onSelect}
    >
      <strong>{props.skill.name || props.skill.artifactDirectoryName}</strong>
      <span class="skills-browser__item-badges">
        <span class={`managed-skill-status managed-skill-status--${props.skill.status}`}>
          {props.skill.status === 'ready' ? uiText('可绑定', 'Ready') : uiText('输出无效', 'Invalid output')}
        </span>
        <Show when={props.skill.status === 'ready'}>
          <span>{boundCount()} {uiText('个目标已绑定', 'targets bound')}</span>
        </Show>
      </span>
      <code title={props.skill.artifactDirectoryName}>{props.skill.artifactDirectoryName}</code>
    </button>
  )
}

function ManagedTargetRow(props: {
  skill: ManagedSkillSummary
  target: SkillBindingTargetSummary
  busy: boolean
  canBind: boolean
  actionError?: string
  onBind(input: ManagedSkillBindingInput): void
  onUnbind(input: ManagedSkillBindingInput): void
}) {
  const input = (): ManagedSkillBindingInput => ({
    artifactDirectoryName: props.skill.artifactDirectoryName,
    targetId: props.target.id
  })
  return (
    <article
      class={`managed-target managed-target--${props.target.state}`}
      data-testid="managed-skill-target"
      data-agent-type={props.target.agentType}
    >
      <div class="managed-target__identity">
        <strong>{props.target.agentDisplayName}</strong>
        <span>{uiText('全局', 'Global')}</span>
        <Show when={props.target.shared}>
          <span class="managed-target__shared">{uiText('共享注册目录', 'Shared registration directory')}</span>
        </Show>
      </div>
      <div class="managed-target__location">
        <span
          class={`managed-target__state managed-target__state--${props.target.state}`}
          data-testid="managed-target-state"
        >{skillBindingStateLabel(props.target.state)}</span>
        <code title={props.target.bindingPath || props.target.registrationRoot}>
          {props.target.bindingPath || props.target.registrationRoot}
        </code>
        <Show when={props.target.message}>
          <small>{props.target.message}</small>
        </Show>
        <Show when={props.actionError}>
          <small class="managed-target__error" role="alert">{props.actionError}</small>
        </Show>
      </div>
      <div class="managed-target__action">
        <Show when={props.target.state === 'unbound' && props.canBind}>
          <Button
            variant="secondary"
            icon="link"
            data-testid="bind-managed-skill"
            disabled={props.busy}
            onClick={() => props.onBind(input())}
          >{props.busy ? uiText('正在绑定…', 'Binding…') : uiText('绑定', 'Bind')}</Button>
        </Show>
        <Show when={props.target.state === 'bound'}>
          <Button
            variant="ghost"
            icon="trash"
            data-testid="unbind-managed-skill"
            disabled={props.busy}
            onClick={() => props.onUnbind(input())}
          >{props.busy ? uiText('正在解绑…', 'Unbinding…') : uiText('解绑', 'Unbind')}</Button>
        </Show>
      </div>
    </article>
  )
}

export function SkillsPage(props: SkillsPageProps = {}) {
  const external = createSkillDiscoveryController()
  const managed = createManagedSkillsController()
  const [view, setView] = createSignal<SkillsPageView>(props.initialView ?? 'managed')
  const externalSkillCount = createMemo(() => external.snapshot()?.skills.length)
  const managedSkillCount = createMemo(() => managed.snapshot()?.skills.length)
  const skillGroups = createMemo(() => groupSkillsByAgent(external.snapshot()?.skills ?? []))
  const agentCount = createMemo(() => {
    const snapshot = external.snapshot()
    return snapshot ? new Set(snapshot.skills.map((skill) => skill.agentType)).size : undefined
  })
  const loadingExternalDocument = createMemo(() => external.busy()?.startsWith('read:') ?? false)
  const loadingManagedDocument = createMemo(() => {
    const directoryName = managed.selectedDirectoryName()
    return directoryName ? managed.isBusy(`read:${directoryName}`) : false
  })
  let navigationGeneration = 0

  createEffect(() => {
    const request = props.navigationRequest
    if (!request) return
    const generation = ++navigationGeneration
    setView('managed')
    void (async () => {
      const refreshed = await managed.refresh()
      if (refreshed && generation === navigationGeneration) {
        await managed.select(request.artifactDirectoryName)
      }
    })()
  })

  return (
    <div class="skills-page" data-testid="skills-page">
      <header class="page-header">
        <div>
          <h1>Skills</h1>
          <div class="page-summary">
            <Show
              when={view() === 'managed'}
              fallback={(
                <>
                  <span><strong>{externalSkillCount() ?? '—'}</strong> {uiText('个外部注册', 'external registrations')}</span>
                  <span class="page-summary__separator">·</span>
                  <span><strong>{agentCount() ?? '—'}</strong> Agents</span>
                  <span class="page-summary__separator">·</span>
                  <span>{uiText('只读展示原始注册位置', 'Read-only view of original registrations')}</span>
                </>
              )}
            >
              <span><strong>{managedSkillCount() ?? '—'}</strong> Skill Artifacts</span>
              <span class="page-summary__separator">·</span>
              <span>{uiText('通过符号链接管理用户级绑定', 'Manage user-level bindings through symbolic links')}</span>
            </Show>
          </div>
        </div>
        <div class="page-header__actions">
          <Show
            when={view() === 'managed'}
            fallback={(
              <Button
                variant="primary"
                size="wide"
                icon="refresh"
                data-testid="discover-skills"
                disabled={Boolean(external.busy())}
                onClick={() => void external.discover()}
              >{external.busy() === 'discover' ? uiText('正在发现…', 'Discovering…') : uiText('发现本机 Skill', 'Discover Local Skills')}</Button>
            )}
          >
            <Button
              variant="secondary"
              icon="refresh"
              data-testid="refresh-managed-skills"
              disabled={managed.isBusy('load') || managed.isBusy('refresh')}
              onClick={() => void managed.refresh()}
            >{managed.isBusy('refresh') ? uiText('正在刷新…', 'Refreshing…') : uiText('刷新', 'Refresh')}</Button>
          </Show>
        </div>
      </header>

      <div class="skills-page__tabs" role="tablist" aria-label={uiText('Skill 视图', 'Skill views')}>
        <button
          type="button"
          role="tab"
          data-testid="skills-view-managed"
          aria-selected={view() === 'managed'}
          onClick={() => setView('managed')}
        >{uiText('Oyster 管理', 'Managed by Oyster')}</button>
        <button
          type="button"
          role="tab"
          data-testid="skills-view-external"
          aria-selected={view() === 'external'}
          onClick={() => setView('external')}
        >{uiText('外部发现', 'External Discovery')}</button>
      </div>

      <Show when={view() === 'managed'}>
        <div class="skills-page__view" data-testid="managed-skills-view">
          <Show when={managed.error()}>
            <div class="page-error" role="alert"><Icon name="warning" />{managed.error()}</div>
          </Show>

          <Show when={(managed.snapshot()?.errors.length ?? 0) > 0}>
            <section class="managed-skill-errors" aria-label={uiText('Skill Artifact 错误', 'Skill Artifact errors')}>
              <div class="skill-discovery-errors__heading">
                <Icon name="warning" />
                <div>
                  <strong>{uiText('部分 Skill Artifact 无法读取', 'Some Skill Artifacts Cannot Be Read')}</strong>
                  <span>{uiText('其他可用 Skill 仍可正常管理。', 'Other available Skills can still be managed.')}</span>
                </div>
              </div>
              <ul>
                <For each={managed.snapshot()?.errors ?? []}>{(entry) => (
                  <li>
                    <Show when={entry.artifactDirectoryName}>
                      <code>{entry.artifactDirectoryName}</code>
                    </Show>
                    <span>{entry.message}</span>
                  </li>
                )}</For>
              </ul>
            </section>
          </Show>

          <section class="skills-browser managed-skills-browser" aria-label={uiText('Oyster 管理的 Skills', 'Skills managed by Oyster')}>
            <aside class="skills-browser__list" aria-label="Skill Artifacts">
              <div class="skills-browser__list-heading">
                <span>Skill Artifacts</span>
                <strong>{managedSkillCount() ?? '—'}</strong>
              </div>
              <div class="skills-browser__list-scroll" data-testid="managed-skill-list-scroll">
                <Show
                  when={managed.snapshot()?.skills.length}
                  fallback={(
                    <div class="skills-browser__empty-list">
                      {managed.snapshot()
                        ? uiText('还没有 Skill Artifact。在 Artifact 的 output/ 中提供 SKILL.md 后即可管理。', 'No Skill Artifacts yet. Add SKILL.md under an Artifact’s output/ to manage it here.')
                        : managed.error()
                          ? uiText('无法读取 Skill Artifact。', 'Unable to read Skill Artifacts.')
                          : uiText('正在读取 Skill Artifact…', 'Reading Skill Artifacts…')}
                    </div>
                  )}
                >
                  <For each={managed.snapshot()?.skills ?? []}>{(skill) => (
                    <ManagedSkillListItem
                      skill={skill}
                      selected={managed.selectedDirectoryName() === skill.artifactDirectoryName}
                      onSelect={() => void managed.select(skill.artifactDirectoryName)}
                    />
                  )}</For>
                </Show>
              </div>
            </aside>

            <div class="skills-browser__detail" data-testid="managed-skill-detail-scroll">
              <Show
                when={managed.selectedSkill()}
                fallback={<div class="skills-browser__empty-detail">{uiText('选择一个 Skill Artifact 查看输出和 Agent 绑定。', 'Select a Skill Artifact to view its output and Agent bindings.')}</div>}
              >
                {(skill) => (
                  <>
                    <header class="skill-detail__header managed-skill-detail__header">
                      <div>
                        <div class="skill-detail__badges">
                          <span class="skill-agent-badge">{uiText('Oyster 管理', 'Managed by Oyster')}</span>
                          <span class={`managed-skill-status managed-skill-status--${skill().status}`}>
                            {skill().status === 'ready' ? uiText('可绑定', 'Ready') : uiText('输出无效', 'Invalid output')}
                          </span>
                        </div>
                        <h2>{skill().name || skill().artifactDirectoryName}</h2>
                        <Show when={skill().description}>
                          <p>{skill().description}</p>
                        </Show>
                        <Show when={skill().issue}>
                          <p class="managed-skill-detail__issue"><Icon name="warning" />{skill().issue}</p>
                        </Show>
                      </div>
                      <Button
                        variant="secondary"
                        icon="folder"
                        data-testid="open-managed-skill-folder"
                        disabled={managed.isBusy(`open:${skill().artifactDirectoryName}`)}
                        onClick={() => void managed.openFolder(skill().artifactDirectoryName)}
                      >{managed.isBusy(`open:${skill().artifactDirectoryName}`) ? uiText('正在打开…', 'Opening…') : uiText('打开输出目录', 'Open Output Folder')}</Button>
                    </header>

                    <dl class="skill-detail__metadata managed-skill-detail__metadata">
                      <div>
                        <dt>Artifact</dt>
                        <dd>{skill().artifactDirectoryName}</dd>
                      </div>
                      <div>
                        <dt>{uiText('状态', 'Status')}</dt>
                        <dd>{skill().status === 'ready' ? uiText('Skill 输出可用', 'Skill output available') : uiText('Skill 输出无效', 'Skill output invalid')}</dd>
                      </div>
                      <div class="skill-detail__metadata-wide">
                        <dt>{uiText('Artifact 位置', 'Artifact Location')}</dt>
                        <dd><code data-testid="managed-skill-artifact-path">{skill().artifactPath}</code></dd>
                      </div>
                      <div class="skill-detail__metadata-wide">
                        <dt>{uiText('输出目录', 'Output Folder')}</dt>
                        <dd><code data-testid="managed-skill-output-path">{skill().outputPath}</code></dd>
                      </div>
                      <Show when={skill().documentPath}>
                        <div class="skill-detail__metadata-wide">
                          <dt>{uiText('入口文档', 'Entry Document')}</dt>
                          <dd><code data-testid="managed-skill-document-path">{skill().documentPath}</code></dd>
                        </div>
                      </Show>
                    </dl>

                    <section class="managed-bindings" aria-labelledby="managed-bindings-title">
                      <div class="managed-bindings__heading">
                        <div>
                          <h3 id="managed-bindings-title">{uiText('Agent 注入', 'Agent Injection')}</h3>
                          <p>{uiText(
                            '在目标 Agent 的用户级注册位置创建指向 output/ 的目录符号链接。',
                            'Creates a directory symbolic link to output/ in the target Agent’s user-level registration location.'
                          )}</p>
                        </div>
                        <span>{uiText('用户级', 'User Level')}</span>
                      </div>
                      <Show when={skill().status !== 'ready'}>
                        <div class="managed-bindings__unavailable">
                          {uiText(
                            '当前输出不能创建新绑定；已有 Oyster 绑定仍可在下方解绑。',
                            'The current output cannot create new bindings; existing Oyster bindings can still be removed below.'
                          )}
                        </div>
                      </Show>
                      <div class="managed-bindings__targets">
                        <For each={skill().targets}>{(target) => {
                          const input = (): ManagedSkillBindingInput => ({
                            artifactDirectoryName: skill().artifactDirectoryName,
                            targetId: target.id
                          })
                          const busy = () => (
                            managed.isBusy(managedSkillOperationKey('bind', input()))
                            || managed.isBusy(managedSkillOperationKey('unbind', input()))
                          )
                          return (
                            <ManagedTargetRow
                              skill={skill()}
                              target={target}
                              busy={busy()}
                              canBind={skill().status === 'ready'}
                              actionError={managed.actionError(input())}
                              onBind={(value) => void managed.bind(value)}
                              onUnbind={(value) => void managed.unbind(value)}
                            />
                          )
                        }}</For>
                      </div>
                    </section>

                    <Show when={skill().documentPath}>
                      <section class="skill-document" aria-labelledby="managed-skill-document-title">
                        <div class="skill-document__heading">
                          <div>
                            <h3 id="managed-skill-document-title">SKILL.md</h3>
                            <Show when={managed.document()}>
                              {(document) => (
                                <span>{formatBytes(document().sizeBytes)} · {uiText('更新于', 'updated')} {modifiedAtLabel(document().modifiedAt)}</span>
                              )}
                            </Show>
                          </div>
                          <span>{uiText('Markdown 预览', 'Markdown Preview')}</span>
                        </div>
                        <Show
                          when={managed.document()}
                          fallback={(
                            <div class="skill-document__empty">
                              {loadingManagedDocument() ? uiText('正在读取文档…', 'Reading document…') : uiText('该入口文档暂时无法预览。', 'This entry document cannot be previewed right now.')}
                            </div>
                          )}
                        >
                          {(document) => (
                            <Markdown
                              class="skill-document__content"
                              testId="managed-skill-document-preview"
                              text={document().content}
                              allowImages={false}
                            />
                          )}
                        </Show>
                      </section>
                    </Show>
                  </>
                )}
              </Show>
            </div>
          </section>
        </div>
      </Show>

      <Show when={view() === 'external'}>
        <div class="skills-page__view" data-testid="external-skills-view">
          <Show when={external.error()}>
            <div class="page-error" role="alert"><Icon name="warning" />{external.error()}</div>
          </Show>

          <Show when={(external.snapshot()?.errors.length ?? 0) > 0}>
            <section class="skill-discovery-errors" aria-label={uiText('Skill 发现错误', 'Skill discovery errors')}>
              <div class="skill-discovery-errors__heading">
                <Icon name="warning" />
                <div>
                  <strong>{uiText('部分 Skill 位置无法读取', 'Some Skill Locations Cannot Be Read')}</strong>
                  <span>{uiText('其他已发现结果仍可正常查看。', 'Other discovered results remain available.')}</span>
                </div>
              </div>
              <ul>
                <For each={external.snapshot()?.errors ?? []}>{(entry) => (
                  <li>
                    <strong>{entry.agentType}</strong>
                    <code title={entry.path}>{entry.path}</code>
                    <span>{entry.message}</span>
                  </li>
                )}</For>
              </ul>
            </section>
          </Show>

          <section class="skills-browser" aria-label={uiText('已发现的 Agent Skills', 'Discovered Agent Skills')}>
            <aside class="skills-browser__list" aria-label="Skills">
              <div class="skills-browser__list-heading">
                <span>{uiText('按 Agent 分组', 'Grouped by Agent')}</span>
                <strong>{externalSkillCount() ?? '—'}</strong>
              </div>
              <div class="skills-browser__list-scroll" data-testid="skill-list-scroll">
                <Show
                  when={external.snapshot()?.skills.length}
                  fallback={(
                    <div class="skills-browser__empty-list">
                      {external.snapshot()
                        ? uiText('没有发现 Skill。可重新发现本机 Agent 的注册位置。', 'No Skills found. Discover local Agent registrations again.')
                        : external.error()
                          ? uiText('无法读取 Skill。', 'Unable to read Skills.')
                          : uiText('正在读取 Skill…', 'Reading Skills…')}
                    </div>
                  )}
                >
                  <For each={skillGroups()}>{(group) => (
                    <section
                      class="skill-agent-group"
                      data-testid="skill-agent-group"
                      data-agent-type={group.agentType}
                      aria-labelledby={`skill-agent-group-${group.agentType}`}
                    >
                      <header class="skill-agent-group__header">
                        <h3 id={`skill-agent-group-${group.agentType}`}>{group.agentDisplayName}</h3>
                        <span>{group.skills.length}</span>
                      </header>
                      <div class="skill-agent-group__items">
                        <For each={group.skills}>{(skill) => (
                          <SkillListItem
                            skill={skill}
                            selected={external.selectedId() === skill.id}
                            onSelect={() => void external.select(skill.id)}
                          />
                        )}</For>
                      </div>
                    </section>
                  )}</For>
                </Show>
              </div>
            </aside>

            <div class="skills-browser__detail" data-testid="skill-detail-scroll">
              <Show
                when={external.selectedSkill()}
                fallback={<div class="skills-browser__empty-detail">{uiText('选择一个 Skill 查看原始内容和位置。', 'Select a Skill to view its original content and location.')}</div>}
              >
                {(skill) => (
                  <>
                    <header class="skill-detail__header">
                      <div>
                        <div class="skill-detail__badges">
                          <span class="skill-agent-badge">{skill().agentDisplayName}</span>
                          <span
                            class={`skill-scope skill-scope--${skill().scope}`}
                            data-testid="skill-scope"
                          >{skillScopeLabel(skill().scope)}</span>
                        </div>
                        <h2>{skill().name}</h2>
                        <Show when={skill().description}>
                          <p>{skill().description}</p>
                        </Show>
                      </div>
                      <Button
                        variant="secondary"
                        icon="folder"
                        data-testid="open-skill-folder"
                        disabled={Boolean(external.busy())}
                        onClick={() => void external.openFolder(skill().id)}
                      >{external.busy() === `open:${skill().id}` ? uiText('正在打开…', 'Opening…') : uiText('打开文件夹', 'Open Folder')}</Button>
                    </header>

                    <dl class="skill-detail__metadata">
                      <div>
                        <dt>Agent</dt>
                        <dd>{skill().agentDisplayName}</dd>
                      </div>
                      <div>
                        <dt>{uiText('作用域', 'Scope')}</dt>
                        <dd>{skillScopeLabel(skill().scope)}</dd>
                      </div>
                      <div>
                        <dt>{uiText('格式', 'Format')}</dt>
                        <dd>{skill().format === 'agent_skill' ? 'Agent Skill' : 'Markdown'}</dd>
                      </div>
                      <Show when={skill().scope === 'project' && skill().projectPath}>
                        <div class="skill-detail__metadata-wide">
                          <dt>{uiText('项目位置', 'Project Location')}</dt>
                          <dd><code data-testid="skill-project-path">{skill().projectPath}</code></dd>
                        </div>
                      </Show>
                      <div class="skill-detail__metadata-wide">
                        <dt>{uiText('原始文件夹', 'Original Folder')}</dt>
                        <dd><code data-testid="skill-directory-path">{skill().directoryPath}</code></dd>
                      </div>
                      <div class="skill-detail__metadata-wide">
                        <dt>{uiText('入口文档', 'Entry Document')}</dt>
                        <dd><code data-testid="skill-document-path">{skill().documentPath}</code></dd>
                      </div>
                    </dl>

                    <section class="skill-document" aria-labelledby="skill-document-title">
                      <div class="skill-document__heading">
                        <div>
                          <h3 id="skill-document-title">{skill().documentFileName}</h3>
                          <span>{formatBytes(skill().sizeBytes)} · {uiText('更新于', 'updated')} {modifiedAtLabel(skill().modifiedAt)}</span>
                        </div>
                        <span>{uiText('Markdown 预览', 'Markdown Preview')}</span>
                      </div>
                      <Show
                        when={external.document()}
                        fallback={(
                          <div class="skill-document__empty">
                            {loadingExternalDocument() ? uiText('正在读取文档…', 'Reading document…') : uiText('该入口文档暂时无法预览。', 'This entry document cannot be previewed right now.')}
                          </div>
                        )}
                      >
                        {(document) => (
                          <Markdown
                            class="skill-document__content"
                            testId="skill-document-preview"
                            text={document().content}
                            allowImages={false}
                          />
                        )}
                      </Show>
                    </section>
                  </>
                )}
              </Show>
            </div>
          </section>
        </div>
      </Show>
    </div>
  )
}

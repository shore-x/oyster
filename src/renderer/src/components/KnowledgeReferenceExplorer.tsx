import { For, Show } from 'solid-js'
import type {
  KnowledgeNeighborhoodGroup,
  KnowledgeNeighborhoodProjection,
  KnowledgeNeighborhoodRole
} from '../../../shared/knowledge'

export interface KnowledgeReferenceExplorerProps {
  projection: KnowledgeNeighborhoodProjection
  hoveredTitle?: string
  hoverProjection?: KnowledgeNeighborhoodProjection
  hoverLoading?: boolean
  onSelect(title: string): void
  onHover(title?: string): void
}

function group(
  projection: KnowledgeNeighborhoodProjection,
  kind: KnowledgeNeighborhoodRole
): KnowledgeNeighborhoodGroup {
  return projection.groups.find((candidate) => candidate.kind === kind)
    ?? { kind, memberTitles: [] }
}

function occurrenceCount(
  projection: KnowledgeNeighborhoodProjection,
  title: string,
  role: KnowledgeNeighborhoodRole
): number {
  return projection.edges
    .filter((edge) => role === 'incoming'
      ? edge.sourceTitle === title && edge.targetTitle === projection.centerTitle
      : edge.sourceTitle === projection.centerTitle && edge.targetTitle === title)
    .reduce((total, edge) => total + edge.occurrenceCount, 0)
}

export function KnowledgeReferenceExplorer(props: KnowledgeReferenceExplorerProps) {
  const incoming = () => group(props.projection, 'incoming').memberTitles
  const outgoing = () => group(props.projection, 'outgoing').memberTitles
  const node = (title: string) => props.projection.nodes.find((candidate) => candidate.title === title)
  const hoverIncoming = () => props.hoverProjection
    ? group(props.hoverProjection, 'incoming').memberTitles
    : []
  const hoverOutgoing = () => props.hoverProjection
    ? group(props.hoverProjection, 'outgoing').memberTitles
    : []

  const renderGroup = (
    role: KnowledgeNeighborhoodRole,
    titles: string[]
  ) => {
    const incomingRole = role === 'incoming'
    return (
      <section class={`knowledge-reference-explorer__group knowledge-reference-explorer__group--${role}`}>
        <header>
          <div>
            <h3>{incomingRole ? '被这些 Statement 引用' : '当前 Statement 引用了'}</h3>
            <p>{incomingRole
              ? '以下正文直接引用当前 Statement。'
              : '当前正文直接引用以下 Statement。'}</p>
          </div>
          <span>{titles.length} 项</span>
        </header>
        <Show
          when={titles.length}
          fallback={<p class="knowledge-reference-explorer__empty">暂无直接关系</p>}
        >
          <ol class="knowledge-reference-explorer__list">
            <For each={titles}>{(title) => {
              const statementNode = () => node(title)
              const count = () => occurrenceCount(props.projection, title, role)
              const mutual = () => statementNode()?.roles.length === 2
              const expandedNeighborhood = () => props.hoveredTitle === title
                && props.hoverProjection?.centerTitle === title
              return (
                <li>
                  <details
                    class="knowledge-reference-explorer__item ui-disclosure"
                    onMouseEnter={() => props.onHover(title)}
                    onMouseLeave={(event) => {
                      if (!event.currentTarget.open) props.onHover(undefined)
                    }}
                    onToggle={(event) => {
                      if (event.currentTarget.open) props.onHover(title)
                      else if (props.hoveredTitle === title) props.onHover(undefined)
                    }}
                  >
                    <summary>
                      <span class="knowledge-reference-explorer__summary">
                        <strong>{title}</strong>
                        <span>{statementNode()?.excerpt || '这个 Statement 暂无正文摘要。'}</span>
                      </span>
                    </summary>
                    <div class="knowledge-reference-explorer__detail ui-disclosure__content">
                      <p class="knowledge-reference-explorer__relation-copy">
                        {incomingRole
                          ? `「${title}」在正文中引用了「${props.projection.centerTitle}」。`
                          : `「${props.projection.centerTitle}」在正文中引用了「${title}」。`}
                        <Show when={count() > 1}> 共出现 {count()} 次。</Show>
                        <Show when={mutual()}> 两者互相引用。</Show>
                      </p>
                      <Show
                        when={!props.hoverLoading || props.hoveredTitle !== title}
                        fallback={<p class="knowledge-reference-explorer__loading">正在读取它的直接关系…</p>}
                      >
                        <Show when={expandedNeighborhood()}>
                          <dl class="knowledge-reference-explorer__neighbors">
                            <div>
                              <dt>被引用</dt>
                              <dd>{hoverIncoming().length ? hoverIncoming().join('、') : '无'}</dd>
                            </div>
                            <div>
                              <dt>引用</dt>
                              <dd>{hoverOutgoing().length ? hoverOutgoing().join('、') : '无'}</dd>
                            </div>
                          </dl>
                        </Show>
                      </Show>
                      <button type="button" onClick={() => props.onSelect(title)}>打开 Statement</button>
                    </div>
                  </details>
                </li>
              )
            }}</For>
          </ol>
        </Show>
      </section>
    )
  }

  return (
    <section class="knowledge-reference-explorer" aria-label="Statement 直接引用">
      <header class="knowledge-reference-explorer__header">
        <div>
          <span>直接引用</span>
          <h2>{props.projection.centerTitle}</h2>
        </div>
        <p>关系从正文中的名称引用动态派生；展开条目可查看上下文与相邻关系。</p>
      </header>

      <div class="knowledge-reference-explorer__groups">
        {renderGroup('incoming', incoming())}
        {renderGroup('outgoing', outgoing())}
      </div>

      <Show when={props.projection.unresolvedReferences.length}>
        <details class="knowledge-reference-explorer__unresolved ui-disclosure">
          <summary>{props.projection.unresolvedReferences.length} 个引用在当前知识视图中没有目标</summary>
          <div class="ui-disclosure__content">
            <ul>
              <For each={props.projection.unresolvedReferences}>{(reference) => (
                <li>
                  <code>{reference.targetTitle}</code>
                  <span>{reference.occurrenceCount > 1 ? `${reference.occurrenceCount} 次` : '1 次'}</span>
                </li>
              )}</For>
            </ul>
          </div>
        </details>
      </Show>
    </section>
  )
}

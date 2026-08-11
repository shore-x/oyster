import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type JSX
} from 'solid-js'
import type {
  ChatConversationDetail
} from '../../../shared/chat'
import type { KnowledgeStatement } from '../../../shared/knowledge'
import { createChatController } from '../chat-controller'
import { backendLabel, connectionStatusLabel, reasoningLabel } from '../processing-configuration'
import { Button, Icon } from '../ui'
import { AgentInvocationExplorer } from './AgentInvocationView'
import { parseStatementContent } from './KnowledgeStatementBrowser'

export interface ChatPageProps {
  onOpenKnowledge?(title: string): void
}

function ChatKnowledgeInspector(props: {
  title: string
  onOpen(title: string): void
  onClose(): void
}) {
  const [statement, setStatement] = createSignal<KnowledgeStatement>()
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string>()
  let readGeneration = 0

  createEffect(() => {
    const title = props.title
    const generation = ++readGeneration
    setLoading(true)
    setError(undefined)
    setStatement(undefined)
    void window.oyster.knowledge.read(title)
      .then((result) => {
        if (generation !== readGeneration) return
        setStatement(result)
        if (!result) setError('当前知识库中没有找到这条知识。')
      })
      .catch((cause) => {
        if (generation === readGeneration) setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (generation === readGeneration) setLoading(false)
      })
  })

  createEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose()
    }
    document.addEventListener('keydown', closeOnEscape)
    onCleanup(() => document.removeEventListener('keydown', closeOnEscape))
  })

  return (
    <aside class="chat-knowledge-inspector" role="complementary" aria-label="知识详情" data-testid="chat-knowledge-inspector">
      <header class="context-inspector__toolbar">
        <div>
          <span>知识库</span>
          <strong>{props.title}</strong>
        </div>
        <button type="button" aria-label="关闭知识详情" onClick={props.onClose}>
          <Icon name="close" />
        </button>
      </header>
      <div class="chat-knowledge-inspector__content">
        <Show when={loading()}><div class="context-inspector__state">正在读取知识…</div></Show>
        <Show when={error()}>{(message) => <div class="context-inspector__state context-inspector__state--error">{message()}</div>}</Show>
        <Show when={statement()}>{(current) => (
          <article>
            <h2>{current().title}</h2>
            <div>
              <For each={parseStatementContent(current().content)}>{(part) => (
                <Show when={part.kind === 'link' ? part : undefined} fallback={part.kind === 'text' ? part.value : ''}>
                  {(link) => (
                    <button type="button" class="context-inspector__link" onClick={() => props.onOpen(link().target)}>
                      {link().label}
                    </button>
                  )}
                </Show>
              )}</For>
            </div>
          </article>
        )}</Show>
      </div>
    </aside>
  )
}

function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}

function ExistingBinding(props: { conversation: ChatConversationDetail }) {
  return (
    <div class="chat-binding-summary" data-testid="chat-current-binding">
      <div>
        <span>Connection</span>
        <strong>{props.conversation.binding.connectionId}</strong>
      </div>
      <div>
        <span>Model</span>
        <strong>{props.conversation.binding.modelId}</strong>
      </div>
      <div>
        <span>Reasoning</span>
        <strong>{reasoningLabel(props.conversation.binding.reasoningEffort)}</strong>
      </div>
    </div>
  )
}

export function ChatPage(props: ChatPageProps) {
  const controller = createChatController()
  const [draft, setDraft] = createSignal('')
  const [knowledgeTitle, setKnowledgeTitle] = createSignal<string>()
  const sortedConversations = createMemo(() => controller.state().conversations
    .slice()
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)))
  const defaultBinding = createMemo(() => controller.backendState().defaultLlm)
  const defaultConnection = createMemo(() => controller.backendState().connections.find(
    (connection) => connection.id === defaultBinding()?.connectionId
  ))
  const defaultModel = createMemo(() => defaultConnection()?.models.find(
    (model) => model.id === defaultBinding()?.modelId
  ))
  const defaultLlmUsable = createMemo(() => {
    const binding = defaultBinding()
    const model = defaultModel()
    return Boolean(
      binding
      && defaultConnection()
      && model
      && (!binding.reasoningEffort || model.reasoningEfforts.includes(binding.reasoningEffort))
    )
  })
  const currentInvocationActive = createMemo(() => controller.hasActiveInvocation(
    controller.selectedConversationId()
  ))
  const canSend = createMemo(() => Boolean(
    draft().trim()
      && !controller.loading()
      && !currentInvocationActive()
      && !controller.sending()
      && (!controller.creatingNew() || defaultLlmUsable())
  ))
  const toolLabel = (name: string): string | undefined => (
    controller.state().agent.tools.find((tool) => tool.name === name)?.label
  )
  let messageScroller: HTMLDivElement | undefined
  let previousConversationId: string | undefined

  createEffect(() => {
    const conversationId = controller.selectedConversationId()
    const messageCount = controller.conversation()?.messages.length ?? 0
    const invocationRevision = controller.conversation()?.invocations.map((invocation) => [
      invocation.status,
      invocation.messages.length,
      invocation.toolCalls.length,
      invocation.modelCalls.length
    ].join(':')).join('|') ?? ''
    invocationRevision
    requestAnimationFrame(() => {
      if (!messageScroller) return
      const changedConversation = conversationId !== previousConversationId
      previousConversationId = conversationId
      const nearBottom = messageScroller.scrollHeight - messageScroller.scrollTop - messageScroller.clientHeight < 140
      if (changedConversation || nearBottom || messageCount <= 2) {
        messageScroller.scrollTop = messageScroller.scrollHeight
      }
    })
  })

  function startNew(): void {
    controller.startNew()
    setDraft('')
  }

  async function submit(): Promise<void> {
    if (!canSend()) return
    const text = draft()
    setDraft('')
    const outcome = await controller.send(text)
    if (!outcome.completed && !outcome.userMessageRecorded && !draft()) setDraft(text)
  }

  function onComposerKeyDown(event: KeyboardEvent & { currentTarget: HTMLTextAreaElement }): void {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
    event.preventDefault()
    if (canSend()) void submit()
  }

  return (
    <div class="chat-page" data-testid="chat-page">
      <header class="page-header chat-page__header">
        <div>
          <h1>对话</h1>
          <div class="page-summary">
            <span><strong>{controller.state().conversations.length}</strong> 个对话</span>
            <span class="page-summary__separator">·</span>
            <span>管理知识与产物</span>
          </div>
        </div>
        <Button variant="primary" icon="plus" onClick={startNew}>新对话</Button>
      </header>

      <Show when={controller.error() || controller.state().configurationError || controller.backendState().configurationError}>
        <div class="page-error chat-page__error" role="status">
          <Icon name="warning" />
          {controller.error() || controller.state().configurationError || controller.backendState().configurationError}
        </div>
      </Show>

      <section class="chat-workspace" aria-label="对话工作区">
        <aside class="chat-conversations" aria-label="历史对话">
          <div class="chat-conversations__heading">
            <span>历史对话</span>
            <strong>{sortedConversations().length}</strong>
          </div>
          <Show
            when={!controller.loading()}
            fallback={<div class="chat-conversations__empty">正在读取对话…</div>}
          >
            <Show
              when={sortedConversations().length}
              fallback={<div class="chat-conversations__empty">还没有历史对话。</div>}
            >
              <div class="chat-conversations__list">
                <For each={sortedConversations()}>{(item) => (
                  <button
                    type="button"
                    class="chat-conversation-item"
                    aria-selected={!controller.creatingNew() && controller.selectedConversationId() === item.id}
                    onClick={() => void controller.readConversation(item.id)}
                  >
                    <span class="chat-conversation-item__title">
                      <strong>{item.title || '未命名对话'}</strong>
                      <Show when={controller.hasActiveInvocation(item.id)}><em>调用中</em></Show>
                    </span>
                    <span>{item.binding.modelId}</span>
                    <small>{formatTime(item.updatedAt)} · {item.messageCount} 条消息</small>
                  </button>
                )}</For>
              </div>
            </Show>
          </Show>
        </aside>

        <div class="chat-conversation-detail">
          <div class="chat-conversation-detail__toolbar">
            <Show
              when={controller.creatingNew()}
              fallback={(
                <Show
                  when={controller.conversation()}
                  fallback={<div class="chat-binding-empty">选择一个对话，或开始新对话。</div>}
                >{(current) => <ExistingBinding conversation={current()} />}</Show>
              )}
            >
              <Show
                when={defaultLlmUsable()}
                fallback={<div class="chat-binding-empty">请先在“设置 / AI 后端”中配置可用的默认 LLM。</div>}
              >
                <div class="chat-binding-summary" data-testid="chat-default-binding">
                  <div><span>默认 Connection</span><strong>{defaultConnection()?.displayName}</strong></div>
                  <div><span>Model</span><strong>{defaultModel()?.id}</strong></div>
                  <div><span>Reasoning</span><strong>{reasoningLabel(defaultBinding()?.reasoningEffort)}</strong></div>
                  <small>{backendLabel(defaultConnection()!.backendKind)} · {connectionStatusLabel(defaultConnection()!.status)} · 创建后固定到该 Chat Conversation</small>
                </div>
              </Show>
            </Show>
          </div>

          <div class="chat-messages" ref={messageScroller} aria-live="polite">
            <Show when={controller.loadingConversationId()}>
              <div class="chat-messages__empty">正在读取对话…</div>
            </Show>
            <Show when={!controller.loadingConversationId() && controller.creatingNew()}>
              <div class="chat-messages__empty">
                <span class="chat-messages__empty-mark">O</span>
                <strong>开始一段新对话</strong>
                <p>使用“设置 / AI 后端”保存的默认 LLM，可以询问现有知识，或让 Agent 更新 Knowledge Statement。</p>
              </div>
            </Show>
            <Show when={!controller.loadingConversationId() && !controller.creatingNew() && !controller.conversation()?.invocations.length}>
              <div class="chat-messages__empty">这个对话还没有消息。</div>
            </Show>
            <For each={controller.conversation()?.invocations ?? []}>{(invocation) => (
              <AgentInvocationExplorer
                invocation={invocation}
                compact
                toolLabel={toolLabel}
                onOpenKnowledge={(title) => {
                  setKnowledgeTitle(title)
                  props.onOpenKnowledge?.(title)
                }}
              />
            )}</For>
          </div>

          <div class="chat-composer">
            <textarea
              value={draft()}
              rows={3}
              placeholder={controller.creatingNew() && !defaultLlmUsable()
                ? '请先在“设置 / AI 后端”中配置可用的默认 LLM'
                : '输入消息；Enter 发送，Shift+Enter 换行'}
              disabled={controller.loading()}
              onInput={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={onComposerKeyDown as JSX.EventHandlerUnion<HTMLTextAreaElement, KeyboardEvent>}
            />
            <div class="chat-composer__footer">
              <span>{draft().length ? `${draft().length.toLocaleString()} 字符` : 'Agent 可以查询和更新正式知识库'}</span>
              <Show
                when={currentInvocationActive()}
                fallback={(
                  <Button
                    variant="primary"
                    icon="play"
                    data-testid="chat-send"
                    disabled={!canSend()}
                    onClick={() => void submit()}
                  >{controller.sending() ? '发送中…' : '发送'}</Button>
                )}
              >
                <Button
                  variant="secondary"
                  icon="stop"
                  data-testid="chat-stop"
                  disabled={Boolean(controller.cancellingConversationId())}
                  onClick={() => void controller.stop()}
                >{controller.cancellingConversationId() ? '停止中…' : '停止'}</Button>
              </Show>
            </div>
          </div>
        </div>
      </section>
      <Show when={knowledgeTitle()}>{(title) => (
        <ChatKnowledgeInspector
          title={title()}
          onOpen={setKnowledgeTitle}
          onClose={() => setKnowledgeTitle(undefined)}
        />
      )}</Show>
    </div>
  )
}

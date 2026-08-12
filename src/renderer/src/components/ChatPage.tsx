import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  type JSX
} from 'solid-js'
import type {
  ChatConversationDetail
} from '../../../shared/chat'
import type { AgentModelCallRecord } from '../../../shared/agent-runtime'
import type { KnowledgeStatement } from '../../../shared/knowledge'
import { createChatController } from '../chat-controller'
import { backendLabel, connectionStatusLabel, reasoningLabel } from '../processing-configuration'
import { Button, Icon, Inspector, Markdown } from '../ui'
import { AgentInvocationExplorer, AgentModelCallInspector } from './AgentInvocationView'
import { appLanguage, uiText } from '../i18n'

export interface ChatPageProps {
  onOpenKnowledge?(title: string): void
}

export function ChatKnowledgeInspector(props: {
  title: string
  canGoBack: boolean
  onBack(): void
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
        if (!result) setError(uiText(
          '当前知识库中没有找到这条知识。',
          'This Knowledge Statement was not found in the current Knowledge Store.'
        ))
      })
      .catch((cause) => {
        if (generation === readGeneration) setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (generation === readGeneration) setLoading(false)
      })
  })

  return (
    <Inspector
      class="chat-knowledge-inspector"
      size="narrow"
      ariaLabel={uiText('知识详情', 'Knowledge details')}
      eyebrow={uiText('知识库', 'Knowledge')}
      title={props.title}
      backLabel={uiText('返回上一条知识', 'Back to previous Knowledge')}
      onBack={props.canGoBack ? props.onBack : undefined}
      closeLabel={uiText('关闭', 'Close')}
      onClose={props.onClose}
      contentClass="chat-knowledge-inspector__content"
      data-testid="chat-knowledge-inspector"
    >
        <Show when={loading()}><div class="context-inspector__state">{uiText('正在读取知识…', 'Reading Knowledge…')}</div></Show>
        <Show when={error()}>{(message) => <div class="context-inspector__state context-inspector__state--error">{message()}</div>}</Show>
        <Show when={statement()}>{(current) => (
          <article>
            <h2>{current().title}</h2>
            <Markdown text={current().content} onOpenKnowledge={props.onOpen} />
          </article>
        )}</Show>
    </Inspector>
  )
}

function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value
  return new Intl.DateTimeFormat(appLanguage(), {
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
        <span>{uiText('连接', 'Connection')}</span>
        <strong>{props.conversation.binding.connectionId}</strong>
      </div>
      <div>
        <span>{uiText('模型', 'Model')}</span>
        <strong>{props.conversation.binding.modelId}</strong>
      </div>
      <div>
        <span>{uiText('推理强度', 'Reasoning')}</span>
        <strong>{reasoningLabel(props.conversation.binding.reasoningEffort)}</strong>
      </div>
    </div>
  )
}

export function ChatPage(props: ChatPageProps) {
  const controller = createChatController()
  const [draft, setDraft] = createSignal('')
  const [knowledgeHistory, setKnowledgeHistory] = createSignal<string[]>([])
  const [modelCallSelection, setModelCallSelection] = createSignal<{
    call: AgentModelCallRecord
    index: number
  }>()
  const knowledgeTitle = () => knowledgeHistory().at(-1)
  const openKnowledge = (title: string, replaceHistory = false): void => {
    setModelCallSelection(undefined)
    setKnowledgeHistory((current) => {
      if (replaceHistory) return [title]
      return current.at(-1) === title ? current : [...current, title]
    })
  }
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
          <h1>{uiText('对话', 'Chat')}</h1>
          <div class="page-summary">
            <span><strong>{controller.state().conversations.length}</strong> {uiText('个对话', 'conversations')}</span>
            <span class="page-summary__separator">·</span>
            <span>{uiText('管理知识与工作台内容', 'Manage Knowledge and Workbench content')}</span>
          </div>
        </div>
        <Button variant="primary" icon="plus" onClick={startNew}>{uiText('新对话', 'New Chat')}</Button>
      </header>

      <Show when={controller.error() || controller.state().configurationError || controller.backendState().configurationError}>
        <div class="page-error chat-page__error" role="status">
          <Icon name="warning" />
          {controller.error() || controller.state().configurationError || controller.backendState().configurationError}
        </div>
      </Show>

      <section class="chat-workspace" aria-label={uiText('对话工作区', 'Chat workspace')}>
        <aside class="chat-conversations" aria-label={uiText('历史对话', 'Chat history')}>
          <div class="chat-conversations__heading">
            <span>{uiText('历史对话', 'Chat History')}</span>
            <strong>{sortedConversations().length}</strong>
          </div>
          <Show
            when={!controller.loading()}
            fallback={<div class="chat-conversations__empty">{uiText('正在读取对话…', 'Reading chats…')}</div>}
          >
            <Show
              when={sortedConversations().length}
              fallback={<div class="chat-conversations__empty">{uiText('还没有历史对话。', 'No chat history yet.')}</div>}
            >
              <div class="chat-conversations__list">
                <For each={sortedConversations()}>{(item) => (
                  <button
                    type="button"
                    class="chat-conversation-item"
                    aria-selected={!controller.creatingNew() && controller.selectedConversationId() === item.conversationId}
                    onClick={() => void controller.readConversation(item.conversationId)}
                  >
                    <span class="chat-conversation-item__title">
                      <strong>{item.title || uiText('未命名对话', 'Untitled Chat')}</strong>
                      <Show when={controller.hasActiveInvocation(item.conversationId)}><em>{uiText('调用中', 'Running')}</em></Show>
                    </span>
                    <span>{item.binding.modelId}</span>
                    <small>{formatTime(item.updatedAt)} · {item.messageCount} {uiText('条消息', 'messages')}</small>
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
                  fallback={<div class="chat-binding-empty">{uiText('选择一个对话，或开始新对话。', 'Select a chat or start a new one.')}</div>}
                >{(current) => <ExistingBinding conversation={current()} />}</Show>
              )}
            >
              <Show
                when={defaultLlmUsable()}
                fallback={<div class="chat-binding-empty">{uiText(
                  '请先在“设置 / AI 后端”中配置可用的默认 LLM。',
                  'Configure an available default LLM in Settings / AI Backends first.'
                )}</div>}
              >
                <div class="chat-binding-summary" data-testid="chat-default-binding">
                  <div><span>{uiText('默认连接', 'Default Connection')}</span><strong>{defaultConnection()?.displayName}</strong></div>
                  <div><span>{uiText('模型', 'Model')}</span><strong>{defaultModel()?.id}</strong></div>
                  <div><span>{uiText('推理强度', 'Reasoning')}</span><strong>{reasoningLabel(defaultBinding()?.reasoningEffort)}</strong></div>
                  <small>{backendLabel(defaultConnection()!.backendKind)} · {connectionStatusLabel(defaultConnection()!.status)} · {uiText('创建后固定到该 Chat Conversation', 'Fixed to this Chat Conversation after creation')}</small>
                </div>
              </Show>
            </Show>
          </div>

          <div class="chat-messages" ref={messageScroller} aria-live="polite">
            <Show when={controller.loadingConversationId()}>
              <div class="chat-messages__empty">{uiText('正在读取对话…', 'Reading chat…')}</div>
            </Show>
            <Show when={!controller.loadingConversationId() && controller.creatingNew()}>
              <div class="chat-messages__empty">
                <span class="chat-messages__empty-mark">O</span>
                <strong>{uiText('开始一段新对话', 'Start a New Chat')}</strong>
                <p>{uiText(
                  '使用“设置 / AI 后端”保存的默认 LLM，可以询问现有知识，或让 Agent 更新 Knowledge Statement。',
                  'Use the default LLM saved in Settings / AI Backends to ask about existing Knowledge or have the Agent update Knowledge Statements.'
                )}</p>
              </div>
            </Show>
            <Show when={!controller.loadingConversationId() && !controller.creatingNew() && !controller.conversation()?.invocations.length}>
              <div class="chat-messages__empty">{uiText('这个对话还没有消息。', 'This chat has no messages yet.')}</div>
            </Show>
            <For each={controller.conversation()?.invocations ?? []}>{(invocation) => (
              <AgentInvocationExplorer
                invocation={invocation}
                compact
                toolLabel={toolLabel}
                onOpenKnowledge={(title) => {
                  openKnowledge(title, true)
                  props.onOpenKnowledge?.(title)
                }}
                onInspectModelCall={(call, index) => {
                  setKnowledgeHistory([])
                  setModelCallSelection({ call, index })
                }}
              />
            )}</For>
          </div>

          <div class="chat-composer">
            <textarea
              value={draft()}
              rows={3}
              placeholder={controller.creatingNew() && !defaultLlmUsable()
                ? uiText('请先在“设置 / AI 后端”中配置可用的默认 LLM', 'Configure an available default LLM in Settings / AI Backends first')
                : uiText('输入消息；Enter 发送，Shift+Enter 换行', 'Type a message; Enter to send, Shift+Enter for a new line')}
              disabled={controller.loading()}
              onInput={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={onComposerKeyDown as JSX.EventHandlerUnion<HTMLTextAreaElement, KeyboardEvent>}
            />
            <div class="chat-composer__footer">
              <span>{draft().length
                ? `${draft().length.toLocaleString(appLanguage())} ${uiText('字符', 'characters')}`
                : uiText('Agent 可以查询和更新正式知识库', 'The Agent can query and update the formal Knowledge Store')}</span>
              <Show
                when={currentInvocationActive()}
                fallback={(
                  <Button
                    variant="primary"
                    icon="play"
                    data-testid="chat-send"
                    disabled={!canSend()}
                    onClick={() => void submit()}
                  >{controller.sending() ? uiText('发送中…', 'Sending…') : uiText('发送', 'Send')}</Button>
                )}
              >
                <Button
                  variant="secondary"
                  icon="stop"
                  data-testid="chat-stop"
                  disabled={Boolean(controller.cancellingConversationId())}
                  onClick={() => void controller.stop()}
                >{controller.cancellingConversationId() ? uiText('停止中…', 'Stopping…') : uiText('停止', 'Stop')}</Button>
              </Show>
            </div>
          </div>
        </div>
      </section>
      <Show when={knowledgeTitle()}>{(title) => (
        <ChatKnowledgeInspector
          title={title()}
          canGoBack={knowledgeHistory().length > 1}
          onBack={() => setKnowledgeHistory((current) => current.slice(0, -1))}
          onOpen={openKnowledge}
          onClose={() => setKnowledgeHistory([])}
        />
      )}</Show>
      <Show when={modelCallSelection()}>{(selection) => (
        <Inspector
          class="chat-model-call-inspector"
          size="medium"
          ariaLabel={uiText('模型调用详情', 'Model Call details')}
          title={uiText('模型调用详情', 'Model Call Details')}
          closeLabel={uiText('关闭', 'Close')}
          onClose={() => setModelCallSelection(undefined)}
          data-testid="chat-model-call-inspector"
        >
          <AgentModelCallInspector call={selection().call} index={selection().index} />
        </Inspector>
      )}</Show>
    </div>
  )
}

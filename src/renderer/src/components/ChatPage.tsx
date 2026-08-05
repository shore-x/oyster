import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  type JSX
} from 'solid-js'
import type {
  ChatMessageView,
  ChatSessionDetail,
  ChatToolCallView
} from '../../../shared/chat'
import { createChatController, type LiveChatToolActivity } from '../chat-controller'
import { backendLabel, connectionStatusLabel, reasoningLabel } from '../processing-configuration'
import { Button, Icon, Markdown } from '../ui'

export interface ChatPageProps {
  onOpenKnowledge?(title: string): void
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

function formatUnknown(value: unknown): string {
  if (value === undefined) return '—'
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function stopLabel(reason: Extract<ChatMessageView, { role: 'assistant' }>['stopReason']): string | undefined {
  if (reason === 'length') return '回答达到模型输出上限'
  if (reason === 'aborted') return '回答已停止'
  if (reason === 'error') return '回答失败'
  return undefined
}

function ToolActivity(props: {
  call: ChatToolCallView
  label?: string
  result?: { text: string; isError: boolean; details?: unknown }
  live?: LiveChatToolActivity
}) {
  const status = () => props.live?.status
    ?? (props.result ? (props.result.isError ? 'failed' : 'completed') : 'running')
  const statusText = () => status() === 'running' ? '运行中' : status() === 'failed' ? '失败' : '完成'
  const resultText = () => props.live?.result === undefined
    ? props.result?.details ?? props.result?.text
    : props.live.result

  return (
    <details class={`chat-tool chat-tool--${status()}`} data-tool-call-id={props.call.id}>
      <summary>
        <span class="chat-tool__marker" aria-hidden="true" />
        <span class="chat-tool__identity">
          <strong>{props.label || props.call.name}</strong>
          <code>{props.call.name}</code>
        </span>
        <span class="chat-tool__status">{statusText()}</span>
      </summary>
      <div class="chat-tool__body">
        <div>
          <span>Input</span>
          <pre>{formatUnknown(props.live?.input ?? props.call.input)}</pre>
        </div>
        <Show when={status() !== 'running'}>
          <div>
            <span>Result</span>
            <pre>{formatUnknown(resultText())}</pre>
          </div>
        </Show>
      </div>
    </details>
  )
}

function AssistantMessage(props: {
  message: Extract<ChatMessageView, { role: 'assistant' }>
  session?: ChatSessionDetail
  liveActivities: LiveChatToolActivity[]
  toolLabel(name: string): string | undefined
  onOpenKnowledge?(title: string): void
  streaming?: boolean
  includeUnmatchedLive?: boolean
}) {
  const calls = createMemo(() => {
    const known = new Map(props.message.toolCalls.map((call) => [call.id, call]))
    if (props.includeUnmatchedLive) for (const activity of props.liveActivities) {
      if (!known.has(activity.toolCallId)) {
        known.set(activity.toolCallId, {
          id: activity.toolCallId,
          name: activity.toolName,
          input: activity.input
        })
      }
    }
    return [...known.values()]
  })
  const historicalResult = (toolCallId: string) => {
    const entry = props.session?.messages.find((candidate) => (
      candidate.message.role === 'tool' && candidate.message.toolCallId === toolCallId
    ))
    return entry?.message.role === 'tool' ? entry.message : undefined
  }
  const liveActivity = (toolCallId: string) => (
    props.liveActivities.find((candidate) => candidate.toolCallId === toolCallId)
  )
  const note = () => stopLabel(props.message.stopReason)

  return (
    <article class={`chat-message chat-message--assistant${props.streaming ? ' chat-message--streaming' : ''}`}>
      <div class="chat-message__role">Oyster</div>
      <Show when={props.message.text}>
        <Markdown
          class="chat-message__text"
          text={props.message.text}
          onOpenKnowledge={props.onOpenKnowledge}
        />
      </Show>
      <Show when={calls().length}>
        <div class="chat-message__tools" aria-label="Agent 工具活动">
          <For each={calls()}>{(call) => (
            <ToolActivity
              call={call}
              label={props.toolLabel(call.name)}
              result={historicalResult(call.id)}
              live={liveActivity(call.id)}
            />
          )}</For>
        </div>
      </Show>
      <Show when={props.streaming && !props.message.text && !calls().length}>
        <div class="chat-message__waiting"><span />正在思考…</div>
      </Show>
      <Show when={note()}>{(value) => (
        <p class={`chat-message__note${props.message.stopReason === 'error' ? ' chat-message__note--error' : ''}`}>
          {props.message.error || value()}
        </p>
      )}</Show>
    </article>
  )
}

function ExistingBinding(props: { session: ChatSessionDetail }) {
  return (
    <div class="chat-binding-summary" data-testid="chat-current-binding">
      <div>
        <span>Connection</span>
        <strong>{props.session.binding.connectionId}</strong>
      </div>
      <div>
        <span>Model</span>
        <strong>{props.session.binding.modelId}</strong>
      </div>
      <div>
        <span>Reasoning</span>
        <strong>{reasoningLabel(props.session.binding.reasoningEffort)}</strong>
      </div>
    </div>
  )
}

export function ChatPage(props: ChatPageProps) {
  const controller = createChatController()
  const [draft, setDraft] = createSignal('')
  const sortedSessions = createMemo(() => controller.snapshot().sessions
    .slice()
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)))
  const defaultBinding = createMemo(() => controller.backendSnapshot().defaultLlm)
  const defaultConnection = createMemo(() => controller.backendSnapshot().connections.find(
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
  const currentRunning = createMemo(() => controller.isSessionRunning(controller.selectedSessionId()))
  const canSend = createMemo(() => Boolean(
    draft().trim()
      && !controller.loading()
      && !currentRunning()
      && !controller.sending()
      && (!controller.creatingNew() || defaultLlmUsable())
  ))
  const toolLabel = (name: string): string | undefined => (
    controller.snapshot().agent.tools.find((tool) => tool.name === name)?.label
  )
  let messageScroller: HTMLDivElement | undefined
  let previousSessionId: string | undefined

  createEffect(() => {
    const sessionId = controller.selectedSessionId()
    const messageCount = controller.session()?.messages.length ?? 0
    const streamLength = controller.streamingMessage()?.role === 'assistant'
      ? controller.streamingMessage()?.text.length ?? 0
      : 0
    controller.liveToolActivities().length
    requestAnimationFrame(() => {
      if (!messageScroller) return
      const changedSession = sessionId !== previousSessionId
      previousSessionId = sessionId
      const nearBottom = messageScroller.scrollHeight - messageScroller.scrollTop - messageScroller.clientHeight < 140
      if (changedSession || nearBottom || messageCount <= 2 || streamLength <= 1) {
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

  const streamingAssistant = createMemo(() => {
    const message = controller.streamingMessage()
    return message?.role === 'assistant' ? message : undefined
  })
  const unattachedLiveActivities = createMemo(() => {
    const knownCallIds = new Set<string>()
    for (const entry of controller.session()?.messages ?? []) {
      if (entry.message.role === 'assistant') {
        for (const call of entry.message.toolCalls) knownCallIds.add(call.id)
      }
    }
    for (const call of streamingAssistant()?.toolCalls ?? []) knownCallIds.add(call.id)
    return controller.liveToolActivities().filter((activity) => !knownCallIds.has(activity.toolCallId))
  })

  return (
    <div class="chat-page" data-testid="chat-page">
      <header class="page-header chat-page__header">
        <div>
          <h1>对话</h1>
          <div class="page-summary">
            <span><strong>{controller.snapshot().sessions.length}</strong> 个会话</span>
            <span class="page-summary__separator">·</span>
            <span>管理知识与协作产物</span>
          </div>
        </div>
        <Button variant="primary" icon="plus" onClick={startNew}>新对话</Button>
      </header>

      <Show when={controller.error() || controller.snapshot().configurationError || controller.backendSnapshot().configurationError}>
        <div class="page-error chat-page__error" role="status">
          <Icon name="warning" />
          {controller.error() || controller.snapshot().configurationError || controller.backendSnapshot().configurationError}
        </div>
      </Show>

      <section class="chat-workspace" aria-label="对话工作区">
        <aside class="chat-sessions" aria-label="历史会话">
          <div class="chat-sessions__heading">
            <span>历史会话</span>
            <strong>{sortedSessions().length}</strong>
          </div>
          <Show
            when={!controller.loading()}
            fallback={<div class="chat-sessions__empty">正在读取会话…</div>}
          >
            <Show
              when={sortedSessions().length}
              fallback={<div class="chat-sessions__empty">还没有历史会话。</div>}
            >
              <div class="chat-sessions__list">
                <For each={sortedSessions()}>{(item) => (
                  <button
                    type="button"
                    class="chat-session"
                    aria-selected={!controller.creatingNew() && controller.selectedSessionId() === item.id}
                    onClick={() => void controller.readSession(item.id)}
                  >
                    <span class="chat-session__title">
                      <strong>{item.title || '未命名对话'}</strong>
                      <Show when={controller.isSessionRunning(item.id)}><em>运行中</em></Show>
                    </span>
                    <span>{item.binding.modelId}</span>
                    <small>{formatTime(item.updatedAt)} · {item.messageCount} 条消息</small>
                  </button>
                )}</For>
              </div>
            </Show>
          </Show>
        </aside>

        <div class="chat-conversation">
          <div class="chat-conversation__toolbar">
            <Show
              when={controller.creatingNew()}
              fallback={(
                <Show
                  when={controller.session()}
                  fallback={<div class="chat-binding-empty">选择一个会话，或开始新对话。</div>}
                >{(current) => <ExistingBinding session={current()} />}</Show>
              )}
            >
              <Show
                when={defaultLlmUsable()}
                fallback={<div class="chat-binding-empty">请先在 AI 后端页面配置可用的默认 LLM。</div>}
              >
                <div class="chat-binding-summary" data-testid="chat-default-binding">
                  <div><span>默认 Connection</span><strong>{defaultConnection()?.displayName}</strong></div>
                  <div><span>Model</span><strong>{defaultModel()?.id}</strong></div>
                  <div><span>Reasoning</span><strong>{reasoningLabel(defaultBinding()?.reasoningEffort)}</strong></div>
                  <small>{backendLabel(defaultConnection()!.backendKind)} · {connectionStatusLabel(defaultConnection()!.status)} · 创建后固定到该 Session</small>
                </div>
              </Show>
            </Show>
          </div>

          <div class="chat-messages" ref={messageScroller} aria-live="polite">
            <Show when={controller.loadingSessionId()}>
              <div class="chat-messages__empty">正在读取对话…</div>
            </Show>
            <Show when={!controller.loadingSessionId() && controller.creatingNew()}>
              <div class="chat-messages__empty">
                <span class="chat-messages__empty-mark">O</span>
                <strong>开始一段新对话</strong>
                <p>使用 AI 后端页面保存的默认 LLM，可以询问现有知识，或让 Agent 更新 Knowledge Statement。</p>
              </div>
            </Show>
            <Show when={!controller.loadingSessionId() && !controller.creatingNew() && !controller.session()?.messages.length}>
              <div class="chat-messages__empty">这个会话还没有消息。</div>
            </Show>
            <For each={controller.session()?.messages ?? []}>{(entry) => (
              <Show when={entry.message.role !== 'tool'}>
                <Show
                  when={entry.message.role === 'assistant' ? entry.message : undefined}
                  fallback={(
                    <article class="chat-message chat-message--user">
                      <div class="chat-message__role">你</div>
                      <Markdown
                        class="chat-message__text"
                        text={entry.message.role === 'user' ? entry.message.text : ''}
                        onOpenKnowledge={props.onOpenKnowledge}
                      />
                    </article>
                  )}
                >{(assistant) => (
                  <AssistantMessage
                    message={assistant()}
                    session={controller.session()}
                    liveActivities={controller.liveToolActivities()}
                    toolLabel={toolLabel}
                    onOpenKnowledge={props.onOpenKnowledge}
                  />
                )}</Show>
              </Show>
            )}</For>
            <Show when={streamingAssistant() || unattachedLiveActivities().length}>
              <AssistantMessage
                message={streamingAssistant() ?? {
                  role: 'assistant',
                  text: '',
                  toolCalls: [],
                  model: controller.session()?.binding.modelId || defaultBinding()?.modelId || '',
                  stopReason: 'toolUse',
                  timestamp: Date.now()
                }}
                session={controller.session()}
                liveActivities={streamingAssistant() ? controller.liveToolActivities() : unattachedLiveActivities()}
                toolLabel={toolLabel}
                onOpenKnowledge={props.onOpenKnowledge}
                streaming
                includeUnmatchedLive
              />
            </Show>
          </div>

          <div class="chat-composer">
            <textarea
              value={draft()}
              rows={3}
              placeholder={controller.creatingNew() && !defaultLlmUsable()
                ? '请先在 AI 后端页面配置可用的默认 LLM'
                : '输入消息；Enter 发送，Shift+Enter 换行'}
              disabled={controller.loading()}
              onInput={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={onComposerKeyDown as JSX.EventHandlerUnion<HTMLTextAreaElement, KeyboardEvent>}
            />
            <div class="chat-composer__footer">
              <span>{draft().length ? `${draft().length.toLocaleString()} 字符` : 'Agent 可以查询和更新正式知识库'}</span>
              <Show
                when={currentRunning()}
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
                  disabled={Boolean(controller.cancellingSessionId())}
                  onClick={() => void controller.stop()}
                >{controller.cancellingSessionId() ? '停止中…' : '停止'}</Button>
              </Show>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}

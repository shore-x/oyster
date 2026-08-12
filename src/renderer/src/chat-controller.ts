import { createSignal, onCleanup, onMount } from 'solid-js'
import type { AiBackendSnapshot } from '../../shared/ai-backends'
import type {
  ChatConversationDetail,
  ChatEvent,
  ChatStateView
} from '../../shared/chat'
import { uiText } from './i18n'

const EMPTY_CHAT_STATE: ChatStateView = {
  agent: {
    agentId: 'chat_agent',
    displayName: 'Conversation Agent',
    description: '',
    runtime: 'pi_coding_agent',
    tools: [],
    builtInInstructions: '',
    defaultInstructions: '',
    isDefaultCustomized: false
  },
  conversations: []
}

const EMPTY_BACKEND_STATE: AiBackendSnapshot = { options: [], connections: [] }

export interface ChatSendOutcome {
  completed: boolean
  /** False only when the failed request never entered the persisted Pi transcript. */
  userMessageRecorded: boolean
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function isCancellation(cause: unknown): boolean {
  return /(?:abort|cancel|取消|停止)/i.test(errorText(cause))
}

export function createChatController() {
  const [state, setState] = createSignal<ChatStateView>(EMPTY_CHAT_STATE)
  const [backendState, setBackendState] = createSignal<AiBackendSnapshot>(EMPTY_BACKEND_STATE)
  const [selectedConversationId, setSelectedConversationId] = createSignal<string>()
  const [conversation, setConversation] = createSignal<ChatConversationDetail>()
  const [creatingNew, setCreatingNew] = createSignal(true)
  const [loading, setLoading] = createSignal(true)
  const [loadingConversationId, setLoadingConversationId] = createSignal<string>()
  const [sending, setSending] = createSignal(false)
  const [cancellingConversationId, setCancellingConversationId] = createSignal<string>()
  const [error, setError] = createSignal<string>()
  const [invocationStates, setInvocationStates] = createSignal<Record<
    string,
    Extract<ChatEvent, { type: 'invocation_state_changed' }>
  >>({})
  let readGeneration = 0
  let selectionInitialized = false

  function replaceSummary(detail: ChatConversationDetail): void {
    setState((current) => {
      const existing = current.conversations.some((candidate) => candidate.conversationId === detail.conversationId)
      const conversations = existing
        ? current.conversations.map((candidate) => candidate.conversationId === detail.conversationId ? detail : candidate)
        : [detail, ...current.conversations]
      return { ...current, conversations }
    })
  }

  function handleEvent(event: ChatEvent): void {
    if (event.type === 'state_changed') {
      setState(event.state)
      return
    }
    if (event.type === 'invocation_state_changed') {
      setInvocationStates((current) => ({ ...current, [event.conversationId]: event }))
      if (event.status === 'failed') setError(event.error || uiText('对话 Agent Invocation 失败。', 'Chat Agent Invocation failed.'))
      return
    }
    if (event.type === 'message_appended') {
      if (event.conversationId === selectedConversationId()) {
        setConversation((current) => {
          if (!current || current.conversationId !== event.conversationId) return current
          const messages = current.messages.some((entry) => entry.id === event.entry.id)
            ? current.messages.map((entry) => entry.id === event.entry.id ? event.entry : entry)
            : [...current.messages, event.entry]
          return { ...current, messages, messageCount: messages.length }
        })
      }
      return
    }
    if (event.conversationId === selectedConversationId()) {
      setConversation((current) => {
        if (!current || current.conversationId !== event.conversationId) return current
        const invocations = current.invocations.some(
          (invocation) => invocation.invocationId === event.invocation.invocationId
        )
          ? current.invocations.map((invocation) => (
              invocation.invocationId === event.invocation.invocationId ? event.invocation : invocation
            ))
          : [...current.invocations, event.invocation]
        return { ...current, invocations }
      })
    }
  }

  async function readConversation(conversationId: string): Promise<boolean> {
    const generation = ++readGeneration
    setCreatingNew(false)
    setSelectedConversationId(conversationId)
    setLoadingConversationId(conversationId)
    setError(undefined)
    try {
      const detail = await window.oyster.chat.readConversation(conversationId)
      if (generation !== readGeneration || selectedConversationId() !== conversationId) return false
      setConversation(detail)
      replaceSummary(detail)
      return true
    } catch (cause) {
      if (generation === readGeneration) setError(errorText(cause))
      return false
    } finally {
      if (generation === readGeneration) setLoadingConversationId(undefined)
    }
  }

  function startNew(): void {
    readGeneration++
    selectionInitialized = true
    setCreatingNew(true)
    setSelectedConversationId(undefined)
    setConversation(undefined)
    setLoadingConversationId(undefined)
    setError(undefined)
  }

  onMount(() => {
    let receivedChatState = false
    let receivedBackendState = false
    const unsubscribeChat = window.oyster.chat.subscribe((event) => {
      if (event.type === 'state_changed') receivedChatState = true
      handleEvent(event)
    })
    const unsubscribeBackends = window.oyster.aiBackends.subscribe((next) => {
      receivedBackendState = true
      setBackendState(next)
    })

    void Promise.all([
      window.oyster.chat.getState().then((initial) => {
        if (!receivedChatState) setState(initial)
        if (selectionInitialized) return
        selectionInitialized = true
        const first = initial.conversations
          .slice()
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]
        if (first) void readConversation(first.conversationId)
        else startNew()
      }),
      window.oyster.aiBackends.getSnapshot().then((initial) => {
        if (!receivedBackendState) setBackendState(initial)
      })
    ]).catch((cause) => setError(errorText(cause))).finally(() => setLoading(false))

    onCleanup(() => {
      unsubscribeChat()
      unsubscribeBackends()
    })
  })

  async function send(text: string): Promise<ChatSendOutcome> {
    const normalized = text.trim()
    if (!normalized || sending()) return { completed: false, userMessageRecorded: false }
    setSending(true)
    setError(undefined)
    let conversationId = selectedConversationId()
    const previousMessageIds = new Set(
      conversation()?.conversationId === conversationId
        ? conversation()?.messages.map((entry) => entry.id)
        : []
    )
    try {
      if (!conversationId) {
        const created = await window.oyster.chat.createConversation({})
        selectionInitialized = true
        setCreatingNew(false)
        setSelectedConversationId(created.conversationId)
        setConversation(created)
        replaceSummary(created)
        conversationId = created.conversationId
      }
      const detail = await window.oyster.chat.sendMessage({ conversationId, text: normalized })
      if (selectedConversationId() === conversationId) setConversation(detail)
      replaceSummary(detail)
      return { completed: true, userMessageRecorded: true }
    } catch (cause) {
      if (!isCancellation(cause)) setError(errorText(cause))
      let userMessageRecorded = false
      if (conversationId) {
        try {
          const detail = await window.oyster.chat.readConversation(conversationId)
          userMessageRecorded = detail.messages.some((entry) => (
            !previousMessageIds.has(entry.id)
            && entry.message.role === 'user'
            && entry.message.text.trim() === normalized
          ))
          if (selectedConversationId() === conversationId) setConversation(detail)
          replaceSummary(detail)
        } catch {
          userMessageRecorded = true
        }
      }
      return { completed: false, userMessageRecorded }
    } finally {
      setSending(false)
    }
  }

  async function stop(): Promise<void> {
    const conversationId = selectedConversationId()
    if (!conversationId || cancellingConversationId()) return
    try {
      setCancellingConversationId(conversationId)
      setError(undefined)
      await window.oyster.chat.cancelInvocation({ conversationId })
    } catch (cause) {
      if (!isCancellation(cause)) setError(errorText(cause))
    } finally {
      setCancellingConversationId(undefined)
    }
  }

  function hasActiveInvocation(conversationId: string | undefined): boolean {
    if (!conversationId) return sending()
    const local = invocationStates()[conversationId]?.status
    if (local) return local === 'in_progress'
    return state().conversations.find(
      (candidate) => candidate.conversationId === conversationId
    )?.hasActiveInvocation ?? false
  }

  return {
    state,
    backendState,
    selectedConversationId,
    conversation,
    creatingNew,
    loading,
    loadingConversationId,
    sending,
    cancellingConversationId,
    error,
    hasActiveInvocation,
    startNew,
    readConversation,
    send,
    stop
  }
}

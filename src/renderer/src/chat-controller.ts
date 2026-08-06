import { createSignal, onCleanup, onMount } from 'solid-js'
import type { AiBackendSnapshot } from '../../shared/ai-backends'
import type {
  ChatEvent,
  ChatSessionDetail,
  ChatSnapshot
} from '../../shared/chat'

const EMPTY_CHAT_SNAPSHOT: ChatSnapshot = {
  agent: {
    id: 'chat_agent',
    displayName: 'Conversation Agent',
    description: '',
    runtime: 'pi_agent_core',
    tools: [],
    builtInInstructions: '',
    defaultInstructions: '',
    isDefaultCustomized: false
  },
  sessions: []
}

const EMPTY_BACKEND_SNAPSHOT: AiBackendSnapshot = { options: [], connections: [] }

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
  const [snapshot, setSnapshot] = createSignal<ChatSnapshot>(EMPTY_CHAT_SNAPSHOT)
  const [backendSnapshot, setBackendSnapshot] = createSignal<AiBackendSnapshot>(EMPTY_BACKEND_SNAPSHOT)
  const [selectedSessionId, setSelectedSessionId] = createSignal<string>()
  const [session, setSession] = createSignal<ChatSessionDetail>()
  const [creatingNew, setCreatingNew] = createSignal(true)
  const [loading, setLoading] = createSignal(true)
  const [loadingSessionId, setLoadingSessionId] = createSignal<string>()
  const [sending, setSending] = createSignal(false)
  const [cancellingSessionId, setCancellingSessionId] = createSignal<string>()
  const [error, setError] = createSignal<string>()
  const [runStates, setRunStates] = createSignal<Record<string, ChatEvent & { type: 'run_state_changed' }>>({})
  let readGeneration = 0
  let selectionInitialized = false

  function replaceSummary(detail: ChatSessionDetail): void {
    setSnapshot((current) => {
      const existing = current.sessions.some((candidate) => candidate.id === detail.id)
      const sessions = existing
        ? current.sessions.map((candidate) => candidate.id === detail.id ? detail : candidate)
        : [detail, ...current.sessions]
      return { ...current, sessions }
    })
  }

  function handleEvent(event: ChatEvent): void {
    if (event.type === 'snapshot_changed') {
      setSnapshot(event.snapshot)
      return
    }
    if (event.type === 'run_state_changed') {
      setRunStates((current) => ({ ...current, [event.sessionId]: event }))
      if (event.status === 'failed') setError(event.error || '对话 Agent 运行失败。')
      return
    }
    if (event.type === 'message_appended') {
      if (event.sessionId === selectedSessionId()) {
        setSession((current) => {
          if (!current || current.id !== event.sessionId) return current
          const messages = current.messages.some((entry) => entry.id === event.entry.id)
            ? current.messages.map((entry) => entry.id === event.entry.id ? event.entry : entry)
            : [...current.messages, event.entry]
          return { ...current, messages, messageCount: messages.length }
        })
      }
      return
    }
    if (event.type === 'run_updated') {
      if (event.sessionId === selectedSessionId()) {
        setSession((current) => {
          if (!current || current.id !== event.sessionId) return current
          const runs = current.runs.some((run) => run.id === event.run.id)
            ? current.runs.map((run) => run.id === event.run.id ? event.run : run)
            : [...current.runs, event.run]
          return { ...current, runs }
        })
      }
      return
    }
  }

  async function readSession(sessionId: string): Promise<boolean> {
    const generation = ++readGeneration
    setCreatingNew(false)
    setSelectedSessionId(sessionId)
    setLoadingSessionId(sessionId)
    setError(undefined)
    try {
      const detail = await window.oyster.chat.readSession(sessionId)
      if (generation !== readGeneration || selectedSessionId() !== sessionId) return false
      setSession(detail)
      replaceSummary(detail)
      return true
    } catch (cause) {
      if (generation === readGeneration) setError(errorText(cause))
      return false
    } finally {
      if (generation === readGeneration) setLoadingSessionId(undefined)
    }
  }

  function startNew(): void {
    readGeneration++
    selectionInitialized = true
    setCreatingNew(true)
    setSelectedSessionId(undefined)
    setSession(undefined)
    setLoadingSessionId(undefined)
    setError(undefined)
  }

  onMount(() => {
    let receivedChatSnapshot = false
    let receivedBackendSnapshot = false
    const unsubscribeChat = window.oyster.chat.subscribe((event) => {
      if (event.type === 'snapshot_changed') receivedChatSnapshot = true
      handleEvent(event)
    })
    const unsubscribeBackends = window.oyster.aiBackends.subscribe((next) => {
      receivedBackendSnapshot = true
      setBackendSnapshot(next)
    })

    void Promise.all([
      window.oyster.chat.getSnapshot().then((initial) => {
        if (!receivedChatSnapshot) setSnapshot(initial)
        if (selectionInitialized) return
        selectionInitialized = true
        const first = initial.sessions
          .slice()
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]
        if (first) void readSession(first.id)
        else startNew()
      }),
      window.oyster.aiBackends.getSnapshot().then((initial) => {
        if (!receivedBackendSnapshot) setBackendSnapshot(initial)
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
    let sessionId = selectedSessionId()
    const previousMessageIds = new Set(
      session()?.id === sessionId ? session()?.messages.map((entry) => entry.id) : []
    )
    try {
      if (!sessionId) {
        const created = await window.oyster.chat.createSession({})
        selectionInitialized = true
        setCreatingNew(false)
        setSelectedSessionId(created.id)
        setSession(created)
        replaceSummary(created)
        sessionId = created.id
      }
      setRunStates((current) => ({
        ...current,
        [sessionId!]: { type: 'run_state_changed', sessionId: sessionId!, status: 'running' }
      }))
      const detail = await window.oyster.chat.sendMessage({ sessionId, text: normalized })
      if (selectedSessionId() === sessionId) setSession(detail)
      replaceSummary(detail)
      return { completed: true, userMessageRecorded: true }
    } catch (cause) {
      if (sessionId) {
        setRunStates((current) => ({
          ...current,
          [sessionId!]: {
            type: 'run_state_changed',
            sessionId: sessionId!,
            status: isCancellation(cause) ? 'cancelled' : 'failed',
            ...(!isCancellation(cause) ? { error: errorText(cause) } : {})
          }
        }))
      }
      if (!isCancellation(cause)) setError(errorText(cause))
      let userMessageRecorded = false
      if (sessionId) {
        try {
          const detail = await window.oyster.chat.readSession(sessionId)
          userMessageRecorded = detail.messages.some((entry) => (
            !previousMessageIds.has(entry.id)
            && entry.message.role === 'user'
            && entry.message.text.trim() === normalized
          ))
          if (selectedSessionId() === sessionId) setSession(detail)
          replaceSummary(detail)
        } catch {
          // If persistence cannot be verified, avoid encouraging a duplicate retry.
          userMessageRecorded = true
        }
      }
      return { completed: false, userMessageRecorded }
    } finally {
      setSending(false)
    }
  }

  async function stop(): Promise<void> {
    const sessionId = selectedSessionId()
    if (!sessionId || cancellingSessionId()) return
    try {
      setCancellingSessionId(sessionId)
      setError(undefined)
      await window.oyster.chat.cancelRun({ sessionId })
    } catch (cause) {
      if (!isCancellation(cause)) setError(errorText(cause))
    } finally {
      setCancellingSessionId(undefined)
    }
  }

  function isSessionRunning(sessionId: string | undefined): boolean {
    if (!sessionId) return sending()
    const local = runStates()[sessionId]?.status
    if (local) return local === 'running'
    return snapshot().sessions.find((candidate) => candidate.id === sessionId)?.isRunning ?? false
  }

  return {
    snapshot,
    backendSnapshot,
    selectedSessionId,
    session,
    creatingNew,
    loading,
    loadingSessionId,
    sending,
    cancellingSessionId,
    error,
    isSessionRunning,
    startNew,
    readSession,
    send,
    stop
  }
}

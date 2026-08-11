import { For, Show, createEffect, createMemo, createSignal, createUniqueId, onCleanup } from 'solid-js'
import type {
  AgentInvocationMessageRecord,
  AgentInvocationDebugRecord,
  AgentModelCallRecord,
  AgentInvocationStatus,
  AgentToolCallRecord,
  SerializableJsonValue
} from '../../../shared/agent-runtime'
import { Icon, Markdown } from '../ui'
import { uiText } from '../i18n'

type JsonObject = { [key: string]: SerializableJsonValue }

export interface AgentInvocationViewProps {
  invocation: AgentInvocationDebugRecord
  agentDisplayName?: string
  toolLabel?(name: string): string | undefined
  onOpenKnowledge?(title: string): void
}

function objectValue(value: SerializableJsonValue | undefined): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function arrayValue(value: SerializableJsonValue | undefined): SerializableJsonValue[] {
  return Array.isArray(value) ? value : []
}

function stringValue(value: SerializableJsonValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function pretty(value: unknown): string {
  if (value === undefined) return '—'
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function formatDuration(durationMs?: number): string {
  if (durationMs === undefined) return uiText('进行中', 'In progress')
  if (durationMs < 1_000) return `${durationMs} ms`
  return `${(durationMs / 1_000).toFixed(1)} s`
}

export function agentInvocationStatusLabel(status: AgentInvocationStatus): string {
  if (status === 'in_progress') return uiText('运行中', 'Running')
  if (status === 'completed') return uiText('已完成', 'Completed')
  if (status === 'cancelled') return uiText('已取消', 'Cancelled')
  return uiText('失败', 'Failed')
}

function messageContent(message: AgentInvocationMessageRecord): SerializableJsonValue[] {
  const record = objectValue(message.message)
  const content = record?.content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return arrayValue(content)
}

function contentText(message: AgentInvocationMessageRecord): string {
  return messageContent(message).flatMap((value) => {
    const block = objectValue(value)
    if (block?.type === 'text') return stringValue(block.text) ?? ''
    if (block?.type === 'image') return '[Image]'
    return []
  }).filter(Boolean).join('\n')
}

function thinkingBlocks(message: AgentInvocationMessageRecord): JsonObject[] {
  return messageContent(message).flatMap((value) => {
    const block = objectValue(value)
    return block?.type === 'thinking' ? [block] : []
  })
}

function messageError(message: AgentInvocationMessageRecord): string | undefined {
  return stringValue(objectValue(message.message)?.errorMessage)
}

function toolResultBody(call: AgentToolCallRecord): SerializableJsonValue | undefined {
  const result = objectValue(call.result)
  if (result?.content !== undefined && result.details !== undefined) return call.result
  return result?.details ?? result?.content ?? call.result
}

function modelCallTitle(call: AgentModelCallRecord, index: number): string {
  return call.purpose === 'context_compaction'
    ? `${uiText('上下文压缩', 'Context Compaction')} ${index + 1}`
    : `${uiText('模型调用', 'Model Call')} ${index + 1}`
}

type TimelineItem =
  | { kind: 'message'; sequence: number; message: AgentInvocationMessageRecord }
  | { kind: 'tool'; sequence: number; call: AgentToolCallRecord }
  | { kind: 'model'; sequence: number; call: AgentModelCallRecord }

function timelineItems(invocation: AgentInvocationDebugRecord): TimelineItem[] {
  const items: TimelineItem[] = invocation.messages.flatMap((message) => (
    message.role === 'tool' ? [] : [{ kind: 'message' as const, sequence: message.sequence, message }]
  ))
  items.push(...invocation.toolCalls.map((call) => ({ kind: 'tool' as const, sequence: call.sequence, call })))
  items.push(...invocation.modelCalls.flatMap((call) => (
    call.purpose === 'context_compaction' || !call.outputMessageId
      ? [{ kind: 'model' as const, sequence: call.sequence, call }]
      : []
  )))
  return items.sort((left, right) => left.sequence - right.sequence)
}

function timelineItemKey(item: TimelineItem): string {
  if (item.kind === 'message') return `message:${item.message.id}`
  if (item.kind === 'tool') return `tool:${item.call.id}`
  return `model:${item.call.id}`
}

function ToolCall(props: { call: AgentToolCallRecord; label?: string }) {
  const status = () => props.call.status
  const [expanded, setExpanded] = createSignal(false)
  const payloadId = `agent-tool-payload-${createUniqueId()}`
  return (
    <section
      class={`agent-activity-tool agent-activity-status--${status()}${expanded() ? ' agent-activity-tool--expanded' : ''}`}
      data-tool-call-id={props.call.id}
    >
      <button
        type="button"
        class="agent-activity-tool__toggle"
        aria-expanded={expanded()}
        aria-controls={payloadId}
        onClick={() => setExpanded((value) => !value)}
      >
        <span class="agent-activity-marker" aria-hidden="true" />
        <span class="agent-activity-tool__identity">
          <strong>{props.label || props.call.name}</strong>
          <Show when={props.label && props.label !== props.call.name}>
            <code>{props.call.name}</code>
          </Show>
        </span>
        <span class="agent-activity-tool__state">{agentInvocationStatusLabel(status())} · {formatDuration(props.call.durationMs)}</span>
      </button>
      <div id={payloadId} class="agent-activity-tool__payloads" hidden={!expanded()}>
        <section><h5>Input</h5><pre>{pretty(props.call.input)}</pre></section>
        <Show when={props.call.result !== undefined}>
          <section><h5>Result</h5><pre>{pretty(toolResultBody(props.call))}</pre></section>
        </Show>
      </div>
    </section>
  )
}

function Message(props: {
  message: AgentInvocationMessageRecord
  assistantName: string
  modelCall?: AgentModelCallRecord
  onSelectModelCall?(id: string): void
  onOpenKnowledge?(title: string): void
}) {
  const text = () => contentText(props.message)
  const thinking = () => thinkingBlocks(props.message)
  return (
    <article class={`agent-activity-message agent-activity-message--${props.message.role}`}>
      <div class="agent-activity-message__heading">
        <strong>{props.message.role === 'user' ? uiText('你', 'You') : props.message.role === 'assistant' ? props.assistantName : 'Runtime'}</strong>
        <Show when={props.modelCall && props.onSelectModelCall}>
          <button type="button" onClick={() => props.onSelectModelCall?.(props.modelCall!.id)}>{uiText('查看模型调用', 'View Model Call')}</button>
        </Show>
      </div>
      <For each={thinking()}>{(block) => (
        <details class="agent-activity-thinking">
          <summary>{uiText('思考过程', 'Thinking')}</summary>
          <pre>{block.redacted === true ? uiText('[Provider 已隐藏思考内容]', '[Thinking content hidden by Provider]') : stringValue(block.thinking) || '—'}</pre>
        </details>
      )}</For>
      <Show when={text()} fallback={props.message.status === 'streaming'
        ? <div class="agent-activity-waiting"><span />{uiText('正在等待模型输出…', 'Waiting for model output…')}</div>
        : undefined}>
        {(value) => <Markdown class="agent-activity-message__text" text={value()} onOpenKnowledge={props.onOpenKnowledge} />}
      </Show>
      <Show when={messageError(props.message)}>{(error) => <p class="agent-activity-error">{error()}</p>}</Show>
    </article>
  )
}

function TimelineEntry(props: AgentInvocationViewProps & {
  item: TimelineItem
  onSelectModelCall?(id: string): void
}) {
  const modelCallForMessage = (messageId: string) => props.invocation.modelCalls.find(
    (call) => call.outputMessageId === messageId
  )
  return (
    <>
      <Show when={props.item.kind === 'message' ? props.item.message : undefined}>
        {(message) => <Message
          message={message()}
          assistantName={props.agentDisplayName ?? 'Oyster'}
          modelCall={modelCallForMessage(message().id)}
          onSelectModelCall={props.onSelectModelCall}
          onOpenKnowledge={props.onOpenKnowledge}
        />}
      </Show>
      <Show when={props.item.kind === 'tool' ? props.item.call : undefined}>
        {(call) => <ToolCall call={call()} label={props.toolLabel?.(call().name)} />}
      </Show>
      <Show when={props.item.kind === 'model' ? props.item.call : undefined}>
        {(call) => (
          <button
            type="button"
            class={`agent-activity-model-activity agent-activity-status--${call().status}`}
            onClick={() => props.onSelectModelCall?.(call().id)}
          >
            <span class="agent-activity-marker" aria-hidden="true" />
            <span><strong>{call().purpose === 'context_compaction' ? uiText('压缩上下文', 'Compact Context') : uiText('请求模型', 'Request Model')}</strong><small>{call().model.id}</small></span>
            <span>{agentInvocationStatusLabel(call().status)} · {formatDuration(call().durationMs)}</span>
          </button>
        )}
      </Show>
    </>
  )
}

export function AgentInvocationTimeline(props: AgentInvocationViewProps & {
  onSelectModelCall?(id: string): void
}) {
  const items = createMemo(() => timelineItems(props.invocation))
  // Invocation snapshots are cloned on every update. Stable primitive keys keep existing
  // disclosure components and their scroll anchors alive while records evolve.
  const itemsByKey = createMemo(() => new Map(
    items().map((item) => [timelineItemKey(item), item])
  ))
  const itemKeys = createMemo(() => items().map(timelineItemKey))
  return (
    <div class="agent-activity-timeline" data-testid="agent-invocation-timeline">
      <Show when={itemKeys().length} fallback={<div class="agent-activity-empty">{uiText('Agent 启动后，执行轨迹会显示在这里。', 'The execution trace appears here after the Agent starts.')}</div>}>
        <For each={itemKeys()}>{(key) => (
          <TimelineEntry
            {...props}
            item={itemsByKey().get(key)!}
            onSelectModelCall={props.onSelectModelCall}
          />
        )}</For>
      </Show>
    </div>
  )
}

export function AgentModelCallInspector(props: {
  call: AgentModelCallRecord
  index: number
}) {
  const output = () => objectValue(props.call.output)
  return (
    <article class="agent-call-inspector" data-testid="agent-model-call-inspector">
      <header>
        <div><span>{props.call.purpose === 'context_compaction' ? 'Context Compaction' : 'Agent'}</span><h3>{modelCallTitle(props.call, props.index)}</h3></div>
        <span class={`agent-call-inspector__status agent-activity-status--${props.call.status}`}>{agentInvocationStatusLabel(props.call.status)} · {formatDuration(props.call.durationMs)}</span>
      </header>
      <div class="agent-call-inspector__overview">
        <div><span>Model</span><strong>{props.call.model.id}</strong></div>
        <div><span>Provider</span><strong>{props.call.model.provider}</strong></div>
        <div><span>API</span><strong>{props.call.model.api}</strong></div>
        <div><span>Context Messages</span><strong>{props.call.context.messages.length}</strong></div>
      </div>
      <details open class="agent-call-inspector__section">
        <summary>System Prompt</summary>
        <pre data-testid="agent-model-call-system-prompt">{props.call.context.systemPrompt || '—'}</pre>
      </details>
      <details open class="agent-call-inspector__section">
        <summary>{uiText('Messages（完整 Pi Context）', 'Messages (Complete Pi Context)')}</summary>
        <pre data-testid="agent-model-call-context">{pretty(props.call.context.messages)}</pre>
      </details>
      <details class="agent-call-inspector__section">
        <summary>Tools（{props.call.context.tools?.length ?? 0}）</summary>
        <pre>{pretty(props.call.context.tools ?? [])}</pre>
      </details>
      <details class="agent-call-inspector__section">
        <summary>Generation Options</summary>
        <pre>{pretty(props.call.options ?? {})}</pre>
      </details>
      <details class="agent-call-inspector__section">
        <summary>{uiText('Provider Request（最终 Payload）', 'Provider Request (Final Payload)')}</summary>
        <pre data-testid="agent-model-call-provider-request">{pretty(props.call.providerRequest ?? {})}</pre>
      </details>
      <details class="agent-call-inspector__section">
        <summary>Provider Response</summary>
        <pre data-testid="agent-model-call-provider-response">{pretty(props.call.providerResponse ?? {})}</pre>
      </details>
      <details open class="agent-call-inspector__section">
        <summary>Output</summary>
        <pre data-testid="agent-model-call-output">{pretty(props.call.output)}</pre>
        <Show when={output()?.usage}><p>Stop reason: {stringValue(output()?.stopReason) || '—'} · Usage: {pretty(output()?.usage)}</p></Show>
        <Show when={props.call.error}><p class="agent-activity-error">{props.call.error}</p></Show>
      </details>
    </article>
  )
}

export function AgentInvocationExplorer(props: AgentInvocationViewProps & {
  compact?: boolean
  onInspectModelCall?(call: AgentModelCallRecord, index: number): void
}) {
  const [selectedCallId, setSelectedCallId] = createSignal<string>()
  const inspectorTitleId = `agent-invocation-inspector-${createUniqueId()}`
  const selectedCall = createMemo(() => props.invocation.modelCalls.find(
    (call) => call.id === selectedCallId()
  ))
  const inspectModelCall = (id: string): void => {
    const index = props.invocation.modelCalls.findIndex((call) => call.id === id)
    const call = props.invocation.modelCalls[index]
    if (!call) return
    if (props.onInspectModelCall) {
      props.onInspectModelCall(call, index)
      return
    }
    setSelectedCallId(id)
  }
  createEffect(() => {
    if (!selectedCall()) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setSelectedCallId(undefined)
    }
    document.addEventListener('keydown', closeOnEscape)
    onCleanup(() => document.removeEventListener('keydown', closeOnEscape))
  })
  return (
    <section class={`agent-invocation-view agent-invocation-view--${props.invocation.status}${props.compact ? ' agent-invocation-view--compact' : ''}`} data-testid="agent-invocation-view">
      <Show when={props.compact}>
        <header class="agent-invocation-view__compact-header">
          <strong>{props.agentDisplayName ?? props.invocation.agentId}</strong>
          <span title={props.invocation.parentInvocationId}>{props.invocation.parentInvocationId ? uiText('子 Agent', 'Child Agent') : uiText('根 Agent', 'Root Agent')} · {agentInvocationStatusLabel(props.invocation.status)}</span>
        </header>
      </Show>
      <Show when={!props.compact}>
        <header class="agent-invocation-view__summary">
          <div><span>Agent</span><strong>{props.agentDisplayName ?? props.invocation.agentId}</strong></div>
          <div><span>Turns</span><strong>{props.invocation.turns.length}</strong></div>
          <div><span>Model Calls</span><strong>{props.invocation.modelCalls.length}</strong></div>
          <div><span>Tool Calls</span><strong>{props.invocation.toolCalls.length}</strong></div>
          <div><span>Status</span><strong>{agentInvocationStatusLabel(props.invocation.status)}</strong></div>
        </header>
      </Show>
      <Show when={props.invocation.error}>{(error) => <p class="agent-activity-error">{error()}</p>}</Show>
      <div class={`agent-invocation-view__workspace${selectedCall() ? ' agent-invocation-view__workspace--inspecting' : ''}`}>
        <AgentInvocationTimeline {...props} onSelectModelCall={inspectModelCall} />
        <Show when={selectedCall()}>{(call) => (
          <aside
            class="agent-invocation-view__inspector"
            role="complementary"
            aria-labelledby={inspectorTitleId}
            data-testid="agent-invocation-inspector"
          >
            <div class="agent-invocation-view__inspector-toolbar">
              <strong id={inspectorTitleId}>{uiText('模型调用详情', 'Model Call Details')}</strong>
              <button class="agent-invocation-view__close" type="button" onClick={() => setSelectedCallId(undefined)}>
                <Icon name="close" />
                <span>{uiText('关闭', 'Close')}</span>
              </button>
            </div>
            <AgentModelCallInspector call={call()} index={props.invocation.modelCalls.findIndex((item) => item.id === call().id)} />
          </aside>
        )}</Show>
      </div>
    </section>
  )
}

/** Generic multi-Agent projection; business pages only decide which invocations belong together. */
export function AgentInvocationCollectionExplorer(props: {
  invocations: AgentInvocationDebugRecord[]
  agentDisplayName?(invocation: AgentInvocationDebugRecord): string
  followLatestInvocation?: boolean
  toolLabel?: AgentInvocationViewProps['toolLabel']
  onOpenKnowledge?: AgentInvocationViewProps['onOpenKnowledge']
  onInspectModelCall?(
    invocation: AgentInvocationDebugRecord,
    call: AgentModelCallRecord,
    index: number
  ): void
}) {
  const [selectedInvocationId, setSelectedInvocationId] = createSignal<string>()
  const selectedInvocation = createMemo(() => props.invocations.find((invocation) => invocation.id === selectedInvocationId()))
  let knownInvocationIds = new Set<string>()
  createEffect(() => {
    const invocations = props.invocations
    const newInvocations = invocations.filter((invocation) => !knownInvocationIds.has(invocation.id))
    const newInvocationToFollow = [...newInvocations].reverse().find((invocation) => invocation.status === 'in_progress')
      ?? (props.followLatestInvocation ? newInvocations[newInvocations.length - 1] : undefined)
    if (newInvocationToFollow) {
      setSelectedInvocationId(newInvocationToFollow.id)
    } else if (!selectedInvocation()) {
      setSelectedInvocationId(
        invocations.find((invocation) => invocation.status === 'failed')?.id
        ?? invocations.find((invocation) => invocation.status === 'in_progress')?.id
        ?? invocations[0]?.id
      )
    }
    knownInvocationIds = new Set(invocations.map((invocation) => invocation.id))
  })
  return (
    <section class="agent-invocation-collection" data-testid="agent-invocation-collection">
      <Show when={props.invocations.length > 1}>
        <div class="agent-invocation-collection__selector" aria-label="Agent Invocations">
          <For each={props.invocations}>{(invocation, index) => (
            <button
              type="button"
              aria-selected={selectedInvocation()?.id === invocation.id}
              onClick={() => setSelectedInvocationId(invocation.id)}
            >
              <span>{index() + 1}</span>
              <strong>{props.agentDisplayName?.(invocation) ?? invocation.agentId}</strong>
              <small>{agentInvocationStatusLabel(invocation.status)} · {invocation.modelCalls.length} {uiText('次模型', 'model calls')}</small>
            </button>
          )}</For>
        </div>
      </Show>
      <Show when={selectedInvocation()} fallback={<div class="agent-activity-empty">{uiText('没有实际启动的 Agent Invocation。', 'No Agent Invocation was actually started.')}</div>}>
        {(invocation) => <AgentInvocationExplorer
          invocation={invocation()}
          agentDisplayName={props.agentDisplayName?.(invocation())}
          toolLabel={props.toolLabel}
          onOpenKnowledge={props.onOpenKnowledge}
          onInspectModelCall={(call, index) => props.onInspectModelCall?.(invocation(), call, index)}
        />}
      </Show>
    </section>
  )
}

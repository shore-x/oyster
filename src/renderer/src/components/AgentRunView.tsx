import { For, Show, createEffect, createMemo, createSignal } from 'solid-js'
import type {
  AgentMessageRecord,
  AgentModelCallRecord,
  AgentRunRecord,
  AgentRunStatus,
  AgentToolCallRecord,
  SerializableJsonValue
} from '../../../shared/agent-runtime'
import { Markdown } from '../ui'

type JsonObject = { [key: string]: SerializableJsonValue }

export interface AgentRunViewProps {
  run: AgentRunRecord
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
  if (durationMs === undefined) return '进行中'
  if (durationMs < 1_000) return `${durationMs} ms`
  return `${(durationMs / 1_000).toFixed(1)} s`
}

export function agentRunStatusLabel(status: AgentRunStatus): string {
  if (status === 'running') return '运行中'
  if (status === 'completed') return '已完成'
  if (status === 'cancelled') return '已取消'
  return '失败'
}

function messageContent(message: AgentMessageRecord): SerializableJsonValue[] {
  const record = objectValue(message.message)
  const content = record?.content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return arrayValue(content)
}

function contentText(message: AgentMessageRecord): string {
  return messageContent(message).flatMap((value) => {
    const block = objectValue(value)
    if (block?.type === 'text') return stringValue(block.text) ?? ''
    if (block?.type === 'image') return '[Image]'
    return []
  }).filter(Boolean).join('\n')
}

function thinkingBlocks(message: AgentMessageRecord): JsonObject[] {
  return messageContent(message).flatMap((value) => {
    const block = objectValue(value)
    return block?.type === 'thinking' ? [block] : []
  })
}

function messageError(message: AgentMessageRecord): string | undefined {
  return stringValue(objectValue(message.message)?.errorMessage)
}

function toolResultBody(call: AgentToolCallRecord): SerializableJsonValue | undefined {
  const result = objectValue(call.result)
  if (result?.content !== undefined && result.details !== undefined) return call.result
  return result?.details ?? result?.content ?? call.result
}

function modelCallTitle(call: AgentModelCallRecord, index: number): string {
  return call.purpose === 'context_compaction' ? `上下文压缩 ${index + 1}` : `模型调用 ${index + 1}`
}

type TimelineItem =
  | { kind: 'message'; sequence: number; message: AgentMessageRecord }
  | { kind: 'tool'; sequence: number; call: AgentToolCallRecord }
  | { kind: 'model'; sequence: number; call: AgentModelCallRecord }

function timelineItems(run: AgentRunRecord): TimelineItem[] {
  const items: TimelineItem[] = run.messages.flatMap((message) => (
    message.role === 'tool' ? [] : [{ kind: 'message' as const, sequence: message.sequence, message }]
  ))
  items.push(...run.toolCalls.map((call) => ({ kind: 'tool' as const, sequence: call.sequence, call })))
  items.push(...run.modelCalls.flatMap((call) => (
    call.purpose === 'context_compaction' || !call.outputMessageId
      ? [{ kind: 'model' as const, sequence: call.sequence, call }]
      : []
  )))
  return items.sort((left, right) => left.sequence - right.sequence)
}

function ToolCall(props: { call: AgentToolCallRecord; label?: string }) {
  const status = () => props.call.status
  return (
    <details class={`agent-trace-tool agent-trace-status--${status()}`} data-tool-call-id={props.call.id}>
      <summary>
        <span class="agent-trace-marker" aria-hidden="true" />
        <span class="agent-trace-tool__identity">
          <strong>{props.label || props.call.name}</strong>
          <Show when={props.label && props.label !== props.call.name}>
            <code>{props.call.name}</code>
          </Show>
        </span>
        <span>{agentRunStatusLabel(status())} · {formatDuration(props.call.durationMs)}</span>
      </summary>
      <div class="agent-trace-tool__payloads">
        <section><h5>Input</h5><pre>{pretty(props.call.input)}</pre></section>
        <Show when={props.call.result !== undefined}>
          <section><h5>Result</h5><pre>{pretty(toolResultBody(props.call))}</pre></section>
        </Show>
      </div>
    </details>
  )
}

function Message(props: {
  message: AgentMessageRecord
  modelCall?: AgentModelCallRecord
  onSelectModelCall?(id: string): void
  onOpenKnowledge?(title: string): void
}) {
  const text = () => contentText(props.message)
  const thinking = () => thinkingBlocks(props.message)
  return (
    <article class={`agent-trace-message agent-trace-message--${props.message.role}`}>
      <div class="agent-trace-message__heading">
        <strong>{props.message.role === 'user' ? '你' : props.message.role === 'assistant' ? 'Oyster' : 'Runtime'}</strong>
        <Show when={props.modelCall && props.onSelectModelCall}>
          <button type="button" onClick={() => props.onSelectModelCall?.(props.modelCall!.id)}>查看模型调用</button>
        </Show>
      </div>
      <For each={thinking()}>{(block) => (
        <details class="agent-trace-thinking">
          <summary>思考过程</summary>
          <pre>{block.redacted === true ? '[Provider 已隐藏思考内容]' : stringValue(block.thinking) || '—'}</pre>
        </details>
      )}</For>
      <Show when={text()} fallback={props.message.status === 'streaming'
        ? <div class="agent-trace-waiting"><span />正在等待模型输出…</div>
        : undefined}>
        {(value) => <Markdown class="agent-trace-message__text" text={value()} onOpenKnowledge={props.onOpenKnowledge} />}
      </Show>
      <Show when={messageError(props.message)}>{(error) => <p class="agent-trace-error">{error()}</p>}</Show>
    </article>
  )
}

export function AgentRunTimeline(props: AgentRunViewProps & {
  onSelectModelCall?(id: string): void
}) {
  const items = createMemo(() => timelineItems(props.run))
  const modelCallForMessage = (messageId: string) => props.run.modelCalls.find(
    (call) => call.outputMessageId === messageId
  )
  return (
    <div class="agent-trace-timeline" data-testid="agent-run-timeline">
      <Show when={items().length} fallback={<div class="agent-trace-empty">Agent 启动后，执行轨迹会显示在这里。</div>}>
        <For each={items()}>{(item) => (
          <>
            <Show when={item.kind === 'message' ? item.message : undefined}>
              {(message) => <Message
                message={message()}
                modelCall={modelCallForMessage(message().id)}
                onSelectModelCall={props.onSelectModelCall}
                onOpenKnowledge={props.onOpenKnowledge}
              />}
            </Show>
            <Show when={item.kind === 'tool' ? item.call : undefined}>
              {(call) => <ToolCall call={call()} label={props.toolLabel?.(call().name)} />}
            </Show>
            <Show when={item.kind === 'model' ? item.call : undefined}>
              {(call) => (
                <button
                  type="button"
                  class={`agent-trace-model-activity agent-trace-status--${call().status}`}
                  onClick={() => props.onSelectModelCall?.(call().id)}
                >
                  <span class="agent-trace-marker" aria-hidden="true" />
                  <span><strong>{call().purpose === 'context_compaction' ? '压缩上下文' : '请求模型'}</strong><small>{call().model.id}</small></span>
                  <span>{agentRunStatusLabel(call().status)} · {formatDuration(call().durationMs)}</span>
                </button>
              )}
            </Show>
          </>
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
        <span class={`agent-call-inspector__status agent-trace-status--${props.call.status}`}>{agentRunStatusLabel(props.call.status)} · {formatDuration(props.call.durationMs)}</span>
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
        <summary>Messages（完整 Pi Context）</summary>
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
      <details open class="agent-call-inspector__section">
        <summary>Output</summary>
        <pre data-testid="agent-model-call-output">{pretty(props.call.output)}</pre>
        <Show when={output()?.usage}><p>Stop reason: {stringValue(output()?.stopReason) || '—'} · Usage: {pretty(output()?.usage)}</p></Show>
        <Show when={props.call.error}><p class="agent-trace-error">{props.call.error}</p></Show>
      </details>
    </article>
  )
}

export function AgentRunExplorer(props: AgentRunViewProps & { compact?: boolean }) {
  const [selectedCallId, setSelectedCallId] = createSignal<string>()
  const selectedCall = createMemo(() => props.run.modelCalls.find(
    (call) => call.id === selectedCallId()
  ))
  createEffect(() => {
    if (selectedCallId() && selectedCall()) return
    const failed = props.run.modelCalls.find((call) => call.status === 'failed')
    setSelectedCallId(failed?.id)
  })
  return (
    <section class={`agent-run-view agent-run-view--${props.run.status}${props.compact ? ' agent-run-view--compact' : ''}`} data-testid="agent-run-view">
      <Show when={!props.compact}>
        <header class="agent-run-view__summary">
          <div><span>Turns</span><strong>{props.run.turns.length}</strong></div>
          <div><span>Model Calls</span><strong>{props.run.modelCalls.length}</strong></div>
          <div><span>Tool Calls</span><strong>{props.run.toolCalls.length}</strong></div>
          <div><span>Status</span><strong>{agentRunStatusLabel(props.run.status)}</strong></div>
        </header>
      </Show>
      <Show when={props.run.error}>{(error) => <p class="agent-trace-error">{error()}</p>}</Show>
      <div class={`agent-run-view__workspace${selectedCall() ? ' agent-run-view__workspace--inspecting' : ''}`}>
        <AgentRunTimeline {...props} onSelectModelCall={setSelectedCallId} />
        <Show when={selectedCall()}>{(call) => (
          <div class="agent-run-view__inspector">
            <button class="agent-run-view__close" type="button" onClick={() => setSelectedCallId(undefined)}>关闭调用详情</button>
            <AgentModelCallInspector call={call()} index={props.run.modelCalls.findIndex((item) => item.id === call().id)} />
          </div>
        )}</Show>
      </div>
    </section>
  )
}

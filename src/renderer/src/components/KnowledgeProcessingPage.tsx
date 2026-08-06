import { For, Show, createEffect, createMemo, createSignal } from 'solid-js'
import type {
  KnowledgeMaintenanceResult,
  ProcessingStageView
} from '../../../shared/knowledge-processing'
import { createKnowledgeProcessingController } from '../knowledge-processing-controller'
import {
  backendLabel,
  connectionCanAttemptRun,
  connectionStatusLabel,
  providerLabel,
  reasoningLabel,
  runtimeLabel,
  selectedLlmModel
} from '../processing-configuration'
import { Button, Icon } from '../ui'
import { AgentTodoList } from './AgentTodoList'
import { FullChainWorkspace } from './FullChainWorkspace'
import { fullChainResultView } from './FullChainRunDetails'
import { ProcessingDebugTracePanel } from './ProcessingDebugTracePanel'
import { ProcessingRunHistoryWorkspace } from './ProcessingRunHistoryWorkspace'
import { SessionMetadata, sessionOptionLabel } from './SessionMetadata'

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs} ms`
  return `${(durationMs / 1_000).toFixed(1)} s`
}

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN')
}

function MaintenanceResult(props: { result: KnowledgeMaintenanceResult }) {
  const [selectedTitle, setSelectedTitle] = createSignal<string>()
  const selectedStatement = createMemo(() => props.result.contribution.statements.find(
    (statement) => statement.title === selectedTitle()
  ) ?? props.result.contribution.statements[0])
  const completedTodos = createMemo(() => props.result.todos.filter(
    (todo) => todo.status === 'completed'
  ).length)

  createEffect(() => setSelectedTitle(props.result.contribution.statements[0]?.title))

  return (
    <section class="processing-result" data-testid="processing-result-knowledge_maintenance_agent">
      <div class="processing-result__heading">
        <div><Icon name="check" /><h3>知识维护结果</h3></div>
        <span>{completedTodos()} / {props.result.todos.length} 个 Todo 已完成 · 尚未写入知识层</span>
      </div>
      <Show
        when={props.result.contribution.statements.length}
        fallback={<div class="sandbox-knowledge__empty processing-contribution__empty">Agent 判断本次没有需要写入的 Knowledge Statement。</div>}
      >
        <div class="sandbox-knowledge processing-contribution-knowledge">
          <aside class="sandbox-knowledge__list" aria-label="候选 Knowledge Statements">
            <div class="sandbox-knowledge__list-header">
              <span>候选 Statements</span>
              <strong>{props.result.contribution.statements.length}</strong>
            </div>
            <For each={props.result.contribution.statements}>{(statement) => (
              <button
                type="button"
                class="sandbox-statement"
                aria-selected={selectedStatement()?.title === statement.title}
                onClick={() => setSelectedTitle(statement.title)}
              >
                <strong>{statement.title}</strong>
                <span>知识名称</span>
              </button>
            )}</For>
          </aside>
          <Show when={selectedStatement()}>
            {(statement) => (
              <article class="sandbox-knowledge__detail">
                <h3>{statement().title}</h3>
                <div class="sandbox-knowledge__detail-meta"><span>按标题创建或更新</span></div>
                <div class="sandbox-knowledge__content">{statement().content}</div>
              </article>
            )}
          </Show>
        </div>
      </Show>
      <section class="processing-agent-todos" aria-label="Agent Todo List">
        <div class="processing-agent-todos__heading">
          <div>
            <h4>Agent Todos</h4>
            <p>包括 Host 绑定的证据段和 Agent 在调查中补充的工作项。</p>
          </div>
          <strong>{completedTodos()} / {props.result.todos.length}</strong>
        </div>
        <AgentTodoList todos={props.result.todos} emptyText="本次 Maintainer 运行没有 Todo。" />
      </section>
      <dl class="processing-run-details">
        <div><dt>Connection</dt><dd>{props.result.execution.connectionName}</dd></div>
        <div><dt>Backend</dt><dd>{backendLabel(props.result.execution.backendKind)}</dd></div>
        <div><dt>Provider</dt><dd>{providerLabel(props.result.execution.providerId)}</dd></div>
        <div><dt>Model</dt><dd>{props.result.execution.model}</dd></div>
        <div><dt>Runtime</dt><dd>{runtimeLabel(props.result.execution.runtime)}</dd></div>
        <div><dt>证据段</dt><dd>{props.result.evidenceSegmentCount} 个</dd></div>
        <div><dt>模型调用</dt><dd>{props.result.execution.modelCallCount} 次</dd></div>
        <div><dt>耗时</dt><dd>{formatDuration(props.result.durationMs)}</dd></div>
        <div><dt>完成时间</dt><dd>{formatTime(props.result.completedAt)}</dd></div>
      </dl>
    </section>
  )
}

export function KnowledgeProcessingPage(props: { knowledgeResetVersion: number }) {
  const controller = createKnowledgeProcessingController()
  const [view, setView] = createSignal<'full_chain' | 'history' | 'stage_debug'>('full_chain')
  const [selectedSessionId, setSelectedSessionId] = createSignal<string>()
  const [fullChainAttention, setFullChainAttention] = createSignal('')
  const [attention, setAttention] = createSignal('')
  const [instructions, setInstructions] = createSignal('')

  createEffect(() => {
    if (props.knowledgeResetVersion > 0) controller.resetFullChainResult()
  })

  const maintainer = createMemo(() => controller.snapshot().stages.find(
    (stage) => stage.id === 'knowledge_maintenance_agent'
  ))
  const defaultLlm = createMemo(() => controller.snapshot().defaultLlm)
  const selectedConnection = createMemo(() => controller.snapshot().connections.find(
    (connection) => connection.id === defaultLlm()?.connectionId
  ))
  const selectedSession = createMemo(() => controller.availableSessions().find(
    (session) => session.sourceRecordId === selectedSessionId()
  ))
  const maintenanceTrace = createMemo(() => controller.debugTrace('stage_debug'))
  const fullChainTrace = createMemo(() => {
    return controller.debugTrace('full_chain')
  })
  const currentMaintenanceResult = createMemo(() => {
    const result = controller.maintenanceResult()
    const trace = maintenanceTrace()
    if (!result || (trace && trace.run.id !== result.agentRunId)) return undefined
    return result
  })
  const anyRunning = createMemo(() => (
    controller.isFullChainRunning() || controller.isRunning('knowledge_maintenance_agent')
  ))
  const instructionsDirty = createMemo(() => {
    const stage = maintainer()
    return stage ? instructions() !== stage.effectiveInstructions : false
  })

  let previousInstructions: string | undefined
  createEffect(() => {
    const value = maintainer()?.effectiveInstructions
    if (value !== undefined && value !== previousInstructions) {
      previousInstructions = value
      setInstructions(value)
    }
  })

  function configurationIssue(stage?: ProcessingStageView): string | undefined {
    if (!stage) return '正在读取 Knowledge Maintenance Agent 配置…'
    const binding = defaultLlm()
    if (!binding) return '请先在 AI 后端页面配置默认 LLM。'
    const connection = selectedConnection()
    if (!connection) return `默认 LLM 的 Connection 当前不可用：${binding.connectionId}。`
    const model = selectedLlmModel(binding, connection)
    if (!model) return `默认 LLM 的 Model 当前不可用：${binding.modelId}。`
    if (binding.reasoningEffort && !model.reasoningEfforts.includes(binding.reasoningEffort)) {
      return '默认 LLM 的思考强度不受当前 Model 支持。'
    }
    if (!connectionCanAttemptRun(connection)) {
      return `Connection 状态为“${connectionStatusLabel(connection.status)}”，需要先完成认证或配置。`
    }
    return undefined
  }

  const disabledReason = createMemo(() => {
    const stage = maintainer()
    if (anyRunning()) return '已有知识加工任务正在运行。'
    if (stage && controller.isSaving(stage.id)) return '正在保存 Agent 配置…'
    const issue = configurationIssue(stage)
    if (issue) return issue
    if (instructionsDirty()) return '处理指令有未保存修改，请先保存。'
    if (controller.sessionsLoading()) return '正在读取可用 Session…'
    if (!controller.availableSessions().length) return '暂无可用 Session，请先在“数据来源”中完成扫描。'
    if (!selectedSession()) return '请先选择一个 Session。'
    return undefined
  })

  function updateSelectedSession(value: string): void {
    setSelectedSessionId(value || undefined)
    controller.invalidateInputResults()
  }

  return (
    <>
      <header class="page-header">
        <div>
          <h1>加工测试</h1>
          <div class="page-summary">
            <span>所有运行均为显式测试</span>
            <span class="page-summary__separator">·</span>
            <span>结果默认隔离，可手动导入知识库</span>
          </div>
        </div>
        <div class="processing-mode-nav" role="tablist" aria-label="加工测试工作面">
          <button type="button" role="tab" data-testid="processing-view-full-chain" aria-selected={view() === 'full_chain'} onClick={() => setView('full_chain')}>链路测试</button>
          <button type="button" role="tab" data-testid="processing-view-history" aria-selected={view() === 'history'} onClick={() => { setView('history'); void controller.loadFullChainRuns() }}>历史记录</button>
          <button type="button" role="tab" data-testid="processing-view-stage-debug" aria-selected={view() === 'stage_debug'} onClick={() => setView('stage_debug')}>高级调试</button>
        </div>
      </header>

      <Show when={controller.error()}>{(error) => <div class="page-error"><Icon name="warning" />{error()}</div>}</Show>
      <Show when={controller.snapshot().configurationError}>{(error) => <div class="page-error"><Icon name="warning" />{error()}</div>}</Show>

      <div class="processing-page-panel processing-tab-panel" role="tabpanel" hidden={view() !== 'full_chain'}>
        <FullChainWorkspace
          sessions={controller.availableSessions()}
          sessionsLoading={controller.sessionsLoading()}
          selectedSessionId={selectedSessionId()}
          attention={fullChainAttention()}
          maintainer={maintainer()}
          defaultLlm={defaultLlm()}
          maintainerConnection={selectedConnection()}
          running={controller.isFullChainRunning()}
          debugTrace={fullChainTrace()}
          locked={anyRunning()}
          importingResult={Boolean(controller.fullChainResult() && controller.isImportingFullChainRun(controller.fullChainResult()!.runId))}
          importResult={controller.fullChainResult() && controller.fullChainImportResult()?.runId === controller.fullChainResult()!.runId ? controller.fullChainImportResult()!.commit : undefined}
          result={controller.fullChainResult() ? fullChainResultView(controller.fullChainResult()!) : undefined}
          onSelectSession={updateSelectedSession}
          onAttentionInput={setFullChainAttention}
          onRun={() => {
            const session = selectedSession()
            if (!session) return
            void controller.runFullChain({
              sourceRecordId: session.sourceRecordId,
              expectedRevision: session.revision,
              attention: fullChainAttention().trim() || undefined
            })
          }}
          onCancel={() => void controller.cancelFullChain()}
          onImportResult={() => {
            const result = controller.fullChainResult()
            if (result) void controller.importFullChainRun(result.runId)
          }}
        />
      </div>

      <div class="processing-page-panel processing-tab-panel" role="tabpanel" hidden={view() !== 'history'}>
        <ProcessingRunHistoryWorkspace
          runs={controller.fullChainRuns()}
          loading={controller.fullChainRunsLoading()}
          selected={controller.selectedFullChainRun()}
          loadingRunId={controller.fullChainRuns().find((run) => controller.isLoadingFullChainRun(run.runId))?.runId}
          importingRunId={controller.fullChainRuns().find((run) => controller.isImportingFullChainRun(run.runId))?.runId}
          importResult={controller.fullChainImportResult()}
          onOpen={controller.readFullChainRun}
          onImport={controller.importFullChainRun}
        />
      </div>

      <div class="processing-page-panel processing-tab-panel" role="tabpanel" hidden={view() !== 'stage_debug'}>
        <div class="stage-debug-intro">
          <strong>高级调试</strong>
          <span>单独运行 Maintainer，检查证据读取、Todo、工具活动和候选贡献。</span>
        </div>
        <section class="processing-list" aria-label="知识加工阶段">
          <Show when={maintainer()}>
            {(stage) => {
              const connection = () => selectedConnection()
              const model = () => selectedLlmModel(defaultLlm(), connection())
              return (
                <article id="processing-stage-knowledge_maintenance_agent" class="processing-stage stage-debug-workspace" data-testid="processing-stage-knowledge_maintenance_agent">
                  <div class="processing-stage__header">
                    <span class="processing-stage__index">1</span>
                    <div><h2>{stage().displayName}</h2><p>{stage().description}</p></div>
                    <span class="processing-runtime">{runtimeLabel(stage().runtime)}</span>
                  </div>
                  <div class="processing-capabilities">
                    <For each={stage().capabilities}>{(capability) => <span>{capability}</span>}</For>
                  </div>

                  <div class="processing-workspace-panel stage-debug__configuration" aria-label="模型与提示词">
                    <div class="processing-connection">
                      <Show when={connection() && model()} fallback={<p class="processing-stage__run-status processing-stage__run-status--blocked">请先在 AI 后端页面配置可用的默认 LLM。</p>}>
                        <dl class="processing-connection__details" data-testid="processing-config-knowledge_maintenance_agent">
                          <div><dt>Connection</dt><dd>{connection()?.displayName}</dd></div>
                          <div><dt>Backend</dt><dd>{backendLabel(connection()!.backendKind)}</dd></div>
                          <div><dt>Provider</dt><dd>{providerLabel(connection()!.providerId)}</dd></div>
                          <div><dt>Model</dt><dd>{model()?.id}</dd></div>
                          <div><dt>Reasoning</dt><dd>{reasoningLabel(defaultLlm()?.reasoningEffort)}</dd></div>
                          <div><dt>Runtime</dt><dd>{runtimeLabel(stage().runtime)}</dd></div>
                          <div><dt>配置位置</dt><dd>AI 后端 · 默认 LLM</dd></div>
                        </dl>
                      </Show>
                    </div>
                    <section class="processing-prompt" aria-label="Knowledge Maintenance Agent 提示词">
                      <div class="processing-prompt__heading">
                        <div><h3>处理指令</h3><p>作为 Maintainer 的 System Prompt 使用。</p></div>
                        <span class={`processing-mode-badge${instructions() !== stage().defaultInstructions ? ' processing-mode-badge--custom' : ''}`} data-testid="processing-prompt-badge-knowledge_maintenance_agent">{instructions() !== stage().defaultInstructions ? 'Customized' : 'Default'}</span>
                      </div>
                      <textarea class="processing-prompt__editor" data-testid="processing-instructions-knowledge_maintenance_agent" value={instructions()} rows={12} spellcheck={false} disabled={anyRunning() || controller.isSaving(stage().id)} onInput={(event) => setInstructions(event.currentTarget.value)} />
                      <div class="processing-prompt__actions">
                        <Button variant="ghost" icon="refresh" data-testid="restore-processing-instructions-knowledge_maintenance_agent" disabled={anyRunning() || controller.isSaving(stage().id) || (!stage().isCustomized && instructions() === stage().defaultInstructions)} onClick={() => { setInstructions(stage().defaultInstructions); void controller.saveStage({ stageId: stage().id, instructionsOverride: null }) }}>恢复默认</Button>
                        <Button variant="secondary" icon="check" data-testid="save-processing-instructions-knowledge_maintenance_agent" disabled={anyRunning() || controller.isSaving(stage().id) || !instructionsDirty() || !instructions().trim()} onClick={() => void controller.saveStage({ stageId: stage().id, instructionsOverride: instructions() === stage().defaultInstructions ? null : instructions() })}>保存提示词</Button>
                      </div>
                    </section>
                  </div>

                  <div class="processing-workspace-panel stage-debug__input" aria-label="运行输入">
                    <section class="processing-input" aria-label="知识维护输入">
                      <div class="processing-input__heading"><h3>{stage().inputDescription}</h3><span>不会自动运行</span></div>
                      <label class="ai-field ai-field--wide">
                        <span>可用 Session</span>
                        <select data-testid="processing-maintainer-session" value={selectedSessionId() || ''} disabled={anyRunning() || controller.sessionsLoading() || controller.availableSessions().length === 0} onChange={(event) => updateSelectedSession(event.currentTarget.value)}>
                          <option value="">{controller.sessionsLoading() ? '正在读取可用 Session…' : controller.availableSessions().length ? '选择一个 Session' : '暂无可用 Session'}</option>
                          <For each={controller.availableSessions()}>{(session) => <option value={session.sourceRecordId}>{sessionOptionLabel(session)}</option>}</For>
                        </select>
                      </label>
                      <Show when={selectedSession()}>{(session) => <SessionMetadata session={session()} class="processing-session-summary" testId="maintainer-session-meta" />}</Show>
                      <label class="ai-field ai-field--wide">
                        <span>Attention（可选）</span>
                        <input data-testid="processing-attention-input" value={attention()} placeholder="例如：重点关注用户明确否定过的设计选择" disabled={anyRunning()} onInput={(event) => { setAttention(event.currentTarget.value); controller.invalidateInputResults() }} />
                      </label>
                      <p class={`processing-stage__run-status${disabledReason() ? ' processing-stage__run-status--blocked' : ''}`} data-testid="maintainer-disabled-reason">{disabledReason() || '配置和 Session 已准备，可以运行知识维护。'}</p>
                      <div class="processing-stage__actions">
                        <Show when={controller.isRunning(stage().id)} fallback={(
                          <Button variant="primary" icon="play" data-testid="run-maintainer" disabled={Boolean(disabledReason())} onClick={() => { const session = selectedSession(); if (session) void controller.runKnowledgeMaintenance({ sourceRecordId: session.sourceRecordId, expectedRevision: session.revision, attention: attention().trim() || undefined }) }}>运行知识维护</Button>
                        )}>
                          <Button variant="danger" icon="stop" data-testid="cancel-maintainer" onClick={() => void controller.cancelRun(stage().id)}>停止知识维护</Button>
                        </Show>
                      </div>
                    </section>
                  </div>

                  <div class="processing-workspace-panel stage-debug__process" aria-label="调用过程">
                    <Show when={maintenanceTrace()} fallback={<div class="processing-workspace-empty">运行知识维护后，这里会展示模型轮次和 Agent 工具活动。</div>}>
                      {(trace) => <ProcessingDebugTracePanel trace={trace()} title="知识维护 Agent 调试" />}
                    </Show>
                  </div>
                  <div class="processing-workspace-panel stage-debug__output" aria-label="输出结果">
                    <Show when={!controller.isRunning(stage().id) ? currentMaintenanceResult() : undefined} fallback={<div class="processing-workspace-empty">完成知识维护后，这里会展示候选 Knowledge Contribution。</div>}>
                      {(result) => <MaintenanceResult result={result()} />}
                    </Show>
                  </div>
                </article>
              )
            }}
          </Show>
        </section>
      </div>
    </>
  )
}

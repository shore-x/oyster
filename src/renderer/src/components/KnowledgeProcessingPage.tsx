import { For, Show, createEffect, createMemo, createSignal } from 'solid-js'
import type { SourceConversationSummary } from '../../../shared/discovery'
import type {
  KnowledgeMaintenanceResult,
  KnowledgeAgentDefinitionView
} from '../../../shared/knowledge-processing'
import { createKnowledgeProcessingController } from '../knowledge-processing-controller'
import {
  backendLabel,
  connectionCanInvokeAgent,
  connectionStatusLabel,
  providerLabel,
  reasoningLabel,
  runtimeLabel,
  selectedLlmModel
} from '../processing-configuration'
import { Button, Icon } from '../ui'
import { KnowledgeTaskWorkspace } from './KnowledgeTaskWorkspace'
import { knowledgeTaskResultView } from './KnowledgeTaskDetails'
import { AgentInvocationPanel } from './AgentInvocationPanel'
import { KnowledgeTaskHistoryWorkspace } from './KnowledgeTaskHistoryWorkspace'
import { SourceConversationMetadata } from './SourceConversationMetadata'
import { SourceConversationPicker } from './SourceConversationPicker'

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs} ms`
  return `${(durationMs / 1_000).toFixed(1)} s`
}

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN')
}

function MaintenanceResult(props: { result: KnowledgeMaintenanceResult }) {
  return (
    <section class="processing-result" data-testid="processing-result-knowledge_maintainer">
      <div class="processing-result__heading">
        <div><Icon name="check" /><h3>知识维护结果</h3></div>
        <span>已提交到处理分支 · 未合并到 {props.result.workspace.targetBranch}</span>
      </div>
      <dl class="knowledge-task-details">
        <div><dt>Repository</dt><dd>{props.result.workspace.repositoryPath}</dd></div>
        <div><dt>Task Workspace</dt><dd>{props.result.workspace.workspacePath}</dd></div>
        <div><dt>BRIEF.md</dt><dd>{props.result.workspace.briefPath}</dd></div>
        <div><dt>PROGRESS.md</dt><dd>{props.result.workspace.progressPath}</dd></div>
        <div><dt>Inputs</dt><dd>{props.result.workspace.inputPath}</dd></div>
        <div><dt>处理分支</dt><dd>{props.result.workspace.branchName}</dd></div>
        <div><dt>前一 revision</dt><dd>{props.result.previousRepositoryRevision}</dd></div>
        <div><dt>当前 revision</dt><dd>{props.result.candidateRepositoryRevision}</dd></div>
        <div><dt>变更文件</dt><dd>{props.result.changedPaths.join(', ')}</dd></div>
        <div><dt>Connection</dt><dd>{props.result.invocation.connectionName}</dd></div>
        <div><dt>Backend</dt><dd>{backendLabel(props.result.invocation.backendKind)}</dd></div>
        <div><dt>Provider</dt><dd>{providerLabel(props.result.invocation.providerId)}</dd></div>
        <div><dt>Model</dt><dd>{props.result.invocation.model}</dd></div>
        <div><dt>Runtime</dt><dd>{runtimeLabel(props.result.invocation.runtime)}</dd></div>
        <div><dt>活动段</dt><dd>{props.result.activitySegmentCount} 个</dd></div>
        <div><dt>模型调用</dt><dd>{props.result.invocation.modelCallCount} 次</dd></div>
        <div><dt>耗时</dt><dd>{formatDuration(props.result.durationMs)}</dd></div>
        <div><dt>完成时间</dt><dd>{formatTime(props.result.completedAt)}</dd></div>
      </dl>
    </section>
  )
}

export function KnowledgeProcessingPage(props: { knowledgeResetVersion: number }) {
  const controller = createKnowledgeProcessingController()
  const [view, setView] = createSignal<'knowledge_task' | 'history' | 'agent_preview'>('knowledge_task')
  const [selectedSnapshotRef, setSelectedSnapshotRef] = createSignal<{
    sourceConversationId: string
    sourceRevision: string
  }>()
  const [knowledgeTaskAttention, setKnowledgeTaskAttention] = createSignal('')
  const [attention, setAttention] = createSignal('')
  const [instructions, setInstructions] = createSignal('')

  createEffect(() => {
    if (props.knowledgeResetVersion > 0) controller.resetKnowledgeTaskResult()
  })

  const maintainer = createMemo(() => controller.state().agents.find(
    (agent) => agent.id === 'knowledge_maintainer'
  ))
  const reviewer = createMemo(() => controller.state().agents.find(
    (agent) => agent.id === 'knowledge_reviewer'
  ))
  const defaultLlm = createMemo(() => controller.state().defaultLlm)
  const selectedConnection = createMemo(() => controller.state().connections.find(
    (connection) => connection.id === defaultLlm()?.connectionId
  ))
  const selectedSourceConversation = createMemo(() => {
    const selected = selectedSnapshotRef()
    if (!selected) return undefined
    return controller.sourceConversations().find((conversation) => (
      conversation.sourceConversationId === selected.sourceConversationId
      && conversation.sourceRevision === selected.sourceRevision
    ))
  })
  const maintenanceInvocation = createMemo(() => controller.latestInvocation('agent_preview'))
  const knowledgeTaskInvocations = createMemo(() => {
    return controller.liveInvocations('knowledge_task')
  })
  const currentMaintenanceResult = createMemo(() => {
    const result = controller.maintenanceResult()
    const invocation = maintenanceInvocation()
    if (!result || (invocation && invocation.invocation.id !== result.agentInvocationId)) return undefined
    return result
  })
  const anyActivityInProgress = createMemo(() => (
    controller.isKnowledgeTaskActive()
    || controller.hasActiveInvocation('knowledge_maintainer')
    || controller.hasActiveInvocation('knowledge_reviewer')
  ))
  const instructionsDirty = createMemo(() => {
    const agent = maintainer()
    return agent ? instructions() !== agent.effectiveInstructions : false
  })

  let previousInstructions: string | undefined
  createEffect(() => {
    const value = maintainer()?.effectiveInstructions
    if (value !== undefined && value !== previousInstructions) {
      previousInstructions = value
      setInstructions(value)
    }
  })

  createEffect(() => {
    if (controller.sourceConversationsLoading()) return
    if (selectedSnapshotRef() && !selectedSourceConversation()) {
      setSelectedSnapshotRef(undefined)
      controller.invalidatePreviewResult()
      controller.resetKnowledgeTaskResult()
    }
  })

  function configurationIssue(agent?: KnowledgeAgentDefinitionView): string | undefined {
    if (!agent) return '正在读取 Knowledge Maintenance Agent 配置…'
    const binding = defaultLlm()
    if (!binding) return '请先在“设置 / AI 后端”中配置默认 LLM。'
    const connection = selectedConnection()
    if (!connection) return `默认 LLM 的 Connection 当前不可用：${binding.connectionId}。`
    const model = selectedLlmModel(binding, connection)
    if (!model) return `默认 LLM 的 Model 当前不可用：${binding.modelId}。`
    if (binding.reasoningEffort && !model.reasoningEfforts.includes(binding.reasoningEffort)) {
      return '默认 LLM 的思考强度不受当前 Model 支持。'
    }
    if (!connectionCanInvokeAgent(connection)) {
      return `Connection 状态为“${connectionStatusLabel(connection.status)}”，需要先完成认证或配置。`
    }
    return undefined
  }

  const disabledReason = createMemo(() => {
    const agent = maintainer()
    if (anyActivityInProgress()) return '已有 Knowledge Processing Task 或 Agent Preview 处于进行中。'
    if (agent && controller.isSaving(agent.id)) return '正在保存 Agent 配置…'
    const issue = configurationIssue(agent)
    if (issue) return issue
    if (instructionsDirty()) return '处理指令有未保存修改，请先保存。'
    if (controller.sourceConversationsLoading()) return '正在读取 Source Conversations…'
    if (!controller.sourceConversations().length) return '暂无可用 Source Conversation，请先在“数据来源”中完成扫描。'
    if (!selectedSourceConversation()) return '请先选择一个 Source Conversation。'
    return undefined
  })

  function updateSelectedSourceConversation(conversation?: SourceConversationSummary): void {
    setSelectedSnapshotRef(conversation
      ? {
          sourceConversationId: conversation.sourceConversationId,
          sourceRevision: conversation.sourceRevision
        }
      : undefined)
    controller.invalidatePreviewResult()
    controller.resetKnowledgeTaskResult()
  }

  return (
    <>
      <header class="page-header">
        <div>
          <h1>加工测试</h1>
          <div class="page-summary">
            <span>Task 与 Agent Preview 均由用户显式启动</span>
            <span class="page-summary__separator">·</span>
            <span>结果保留在未合并的 Git 协作分支</span>
          </div>
        </div>
        <div class="processing-mode-nav" role="tablist" aria-label="加工测试工作面">
          <button type="button" role="tab" data-testid="processing-view-knowledge-task" aria-selected={view() === 'knowledge_task'} onClick={() => setView('knowledge_task')}>链路测试</button>
          <button type="button" role="tab" data-testid="processing-view-history" aria-selected={view() === 'history'} onClick={() => { setView('history'); void controller.loadKnowledgeTasks() }}>历史记录</button>
          <button type="button" role="tab" data-testid="processing-view-agent-preview" aria-selected={view() === 'agent_preview'} onClick={() => setView('agent_preview')}>高级调试</button>
        </div>
      </header>

      <Show when={controller.error()}>{(error) => <div class="page-error"><Icon name="warning" />{error()}</div>}</Show>
      <Show when={controller.state().configurationError}>{(error) => <div class="page-error"><Icon name="warning" />{error()}</div>}</Show>

      <div class="processing-page-panel processing-tab-panel" role="tabpanel" hidden={view() !== 'knowledge_task'}>
        <KnowledgeTaskWorkspace
          sourceConversations={controller.sourceConversations()}
          sourceConversationsLoading={controller.sourceConversationsLoading()}
          sourceConversationCatalogError={controller.sourceConversationCatalogError()}
          selectedSourceConversation={selectedSourceConversation()}
          attention={knowledgeTaskAttention()}
          maintainer={maintainer()}
          reviewer={reviewer()}
          defaultLlm={defaultLlm()}
          maintainerConnection={selectedConnection()}
          reviewerConnection={selectedConnection()}
          active={controller.isKnowledgeTaskActive()}
          liveInvocations={knowledgeTaskInvocations()}
          locked={anyActivityInProgress()}
          result={controller.knowledgeTaskResult()
            ? knowledgeTaskResultView(controller.knowledgeTaskResult()!)
            : undefined}
          onSelectSourceConversation={updateSelectedSourceConversation}
          onRefreshSourceConversations={() => void controller.refreshSourceConversations()}
          onAttentionInput={setKnowledgeTaskAttention}
          onStart={() => {
            const conversation = selectedSourceConversation()
            if (!conversation) return
            void controller.startKnowledgeTask({
              sourceConversationId: conversation.sourceConversationId,
              sourceRevision: conversation.sourceRevision,
              attention: knowledgeTaskAttention().trim() || undefined
            })
          }}
          onCancel={() => void controller.cancelKnowledgeTask()}
        />
      </div>

      <div class="processing-page-panel processing-tab-panel" role="tabpanel" hidden={view() !== 'history'}>
        <KnowledgeTaskHistoryWorkspace
          tasks={controller.knowledgeTasks()}
          loading={controller.knowledgeTasksLoading()}
          selected={controller.selectedKnowledgeTask()}
          loadingTaskId={controller.knowledgeTasks().find(
            (task) => controller.isLoadingKnowledgeTask(task.taskId)
          )?.taskId}
          onOpen={controller.readKnowledgeTask}
        />
      </div>

      <div class="processing-page-panel processing-tab-panel" role="tabpanel" hidden={view() !== 'agent_preview'}>
        <div class="agent-preview-intro">
          <strong>高级调试</strong>
          <span>启动 Maintainer Agent Preview，检查 Activity/Evidence 读取、Git 文件修改与提交。</span>
        </div>
        <section class="processing-list" aria-label="Knowledge Agent Definitions">
          <Show when={maintainer()}>
            {(agent) => {
              const connection = () => selectedConnection()
              const model = () => selectedLlmModel(defaultLlm(), connection())
              return (
                <article id="knowledge-agent-knowledge_maintainer" class="knowledge-agent agent-preview-workspace" data-testid="knowledge-agent-knowledge_maintainer">
                  <div class="knowledge-agent__header">
                    <span class="knowledge-agent__index">1</span>
                    <div><h2>{agent().displayName}</h2><p>{agent().description}</p></div>
                    <span class="agent-runtime-label">{runtimeLabel(agent().runtime)}</span>
                  </div>
                  <div class="processing-capabilities">
                    <For each={agent().capabilities}>{(capability) => <span>{capability}</span>}</For>
                  </div>

                  <div class="processing-workspace-panel agent-preview__configuration" aria-label="模型与提示词">
                    <div class="processing-connection">
                      <Show when={connection() && model()} fallback={<p class="knowledge-agent__preview-status knowledge-agent__preview-status--blocked">请先在“设置 / AI 后端”中配置可用的默认 LLM。</p>}>
                        <dl class="processing-connection__details" data-testid="processing-config-knowledge_maintainer">
                          <div><dt>Connection</dt><dd>{connection()?.displayName}</dd></div>
                          <div><dt>Backend</dt><dd>{backendLabel(connection()!.backendKind)}</dd></div>
                          <div><dt>Provider</dt><dd>{providerLabel(connection()!.providerId)}</dd></div>
                          <div><dt>Model</dt><dd>{model()?.id}</dd></div>
                          <div><dt>Reasoning</dt><dd>{reasoningLabel(defaultLlm()?.reasoningEffort)}</dd></div>
                          <div><dt>Runtime</dt><dd>{runtimeLabel(agent().runtime)}</dd></div>
                          <div><dt>配置位置</dt><dd>AI 后端 · 默认 LLM</dd></div>
                        </dl>
                      </Show>
                    </div>
                    <section class="processing-prompt" aria-label="Knowledge Maintenance Agent 提示词">
                      <div class="processing-prompt__heading">
                        <div><h3>处理指令</h3><p>作为 Maintainer 的 System Prompt 使用。</p></div>
                        <span class={`processing-mode-badge${instructions() !== agent().defaultInstructions ? ' processing-mode-badge--custom' : ''}`} data-testid="processing-prompt-badge-knowledge_maintainer">{instructions() !== agent().defaultInstructions ? 'Customized' : 'Default'}</span>
                      </div>
                      <textarea class="processing-prompt__editor" data-testid="processing-instructions-knowledge_maintainer" value={instructions()} rows={12} spellcheck={false} disabled={anyActivityInProgress() || controller.isSaving(agent().id)} onInput={(event) => setInstructions(event.currentTarget.value)} />
                      <div class="processing-prompt__actions">
                        <Button variant="ghost" icon="refresh" data-testid="restore-processing-instructions-knowledge_maintainer" disabled={anyActivityInProgress() || controller.isSaving(agent().id) || (!agent().isCustomized && instructions() === agent().defaultInstructions)} onClick={() => { setInstructions(agent().defaultInstructions); void controller.saveAgent({ agentId: agent().id, instructionsOverride: null }) }}>恢复默认</Button>
                        <Button variant="secondary" icon="check" data-testid="save-processing-instructions-knowledge_maintainer" disabled={anyActivityInProgress() || controller.isSaving(agent().id) || !instructionsDirty() || !instructions().trim()} onClick={() => void controller.saveAgent({ agentId: agent().id, instructionsOverride: instructions() === agent().defaultInstructions ? null : instructions() })}>保存提示词</Button>
                      </div>
                    </section>
                  </div>

                  <div class="processing-workspace-panel agent-preview__input" aria-label="Agent Preview 输入">
                    <section class="processing-input" aria-label="知识维护输入">
                      <div class="processing-input__heading"><h3>{agent().inputDescription}</h3><span>不会自动调用</span></div>
                      <SourceConversationPicker
                        conversations={controller.sourceConversations()}
                        selected={selectedSourceConversation()}
                        loading={controller.sourceConversationsLoading()}
                        disabled={anyActivityInProgress()}
                        label="Source Conversation"
                        selectTestId="maintainer-source-conversation-select"
                        refreshTestId="refresh-maintainer-source-conversations"
                        error={controller.sourceConversationCatalogError()}
                        onSelect={updateSelectedSourceConversation}
                        onRefresh={() => void controller.refreshSourceConversations()}
                      />
                      <Show when={selectedSourceConversation()}>{(conversation) => <SourceConversationMetadata conversation={conversation()} class="source-conversation-summary" testId="maintainer-source-conversation-meta" />}</Show>
                      <label class="ai-field ai-field--wide">
                        <span>Attention（可选）</span>
                        <input data-testid="processing-attention-input" value={attention()} placeholder="例如：重点关注用户明确否定过的设计选择" disabled={anyActivityInProgress()} onInput={(event) => { setAttention(event.currentTarget.value); controller.invalidatePreviewResult() }} />
                      </label>
                      <p class={`knowledge-agent__preview-status${disabledReason() ? ' knowledge-agent__preview-status--blocked' : ''}`} data-testid="maintainer-disabled-reason">{disabledReason() || '配置和 Source Snapshot 已准备，可以启动 Agent Preview。'}</p>
                      <div class="knowledge-agent__actions">
                        <Show when={controller.hasActiveInvocation(agent().id)} fallback={(
                          <Button variant="primary" icon="play" data-testid="preview-maintainer" disabled={Boolean(disabledReason())} onClick={() => { const conversation = selectedSourceConversation(); if (conversation) void controller.previewKnowledgeMaintainer({ sourceConversationId: conversation.sourceConversationId, sourceRevision: conversation.sourceRevision, attention: attention().trim() || undefined }) }}>预览知识维护</Button>
                        )}>
                          <Button variant="danger" icon="stop" data-testid="cancel-maintainer" onClick={() => void controller.cancelAgentPreview(agent().id)}>停止预览</Button>
                        </Show>
                      </div>
                    </section>
                  </div>

                  <div class="processing-workspace-panel agent-preview__process" aria-label="调用过程">
                    <Show when={maintenanceInvocation()} fallback={<div class="processing-workspace-empty">启动 Agent Preview 后，这里会展示 Agent Turn、模型与工具调用。</div>}>
                      {(view) => <AgentInvocationPanel view={view()} title="知识维护 Agent Preview" />}
                    </Show>
                  </div>
                  <div class="processing-workspace-panel agent-preview__output" aria-label="输出结果">
                    <Show when={!controller.hasActiveInvocation(agent().id) ? currentMaintenanceResult() : undefined} fallback={<div class="processing-workspace-empty">完成预览后，这里会展示 Task Workspace 与提交结果。</div>}>
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

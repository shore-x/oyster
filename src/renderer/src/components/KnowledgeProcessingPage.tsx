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
import { Button, Icon, Tab, TabList } from '../ui'
import { KnowledgeTaskWorktree } from './KnowledgeTaskWorktree'
import { knowledgeTaskResultView } from './KnowledgeTaskDetails'
import { AgentInvocationPanel } from './AgentInvocationPanel'
import { KnowledgeTaskHistory } from './KnowledgeTaskHistory'
import { SourceConversationMetadata } from './SourceConversationMetadata'
import { SourceConversationPicker } from './SourceConversationPicker'
import { appLanguage, uiText } from '../i18n'

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs} ms`
  return `${(durationMs / 1_000).toFixed(1)} s`
}

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(appLanguage())
}

function maintainerCapability(value: string): string {
  const translations: Record<string, string> = {
    '读取 Task 文件工作面': 'Read the Task file workspace',
    '完整扫描 Canonical Activity': 'Scan all Canonical Activity',
    '按 locator 回查 Evidence page': 'Trace Evidence pages by locator',
    '检查图片附件': 'Inspect image attachments',
    '直接维护 Repository': 'Maintain the Repository directly'
  }
  return appLanguage() === 'en-US' ? translations[value] ?? value : value
}

function MaintenanceResult(props: { result: KnowledgeMaintenanceResult }) {
  return (
    <section class="processing-result" data-testid="processing-result-knowledge_maintainer">
      <div class="processing-result__heading">
        <div><Icon name="check" /><h3>{uiText('知识维护结果', 'Knowledge Maintenance Result')}</h3></div>
        <span>{uiText('已提交到 Task 分支 · 等待 Reviewer 处理', 'Committed to the Task branch · Awaiting Reviewer')}</span>
      </div>
      <dl class="knowledge-task-details">
        <div><dt>Repository</dt><dd>{props.result.worktree.repositoryPath}</dd></div>
        <div><dt>Task record</dt><dd>{props.result.worktree.taskPath}</dd></div>
        <div><dt>BRIEF.md</dt><dd>{props.result.worktree.briefPath}</dd></div>
        <div><dt>PROGRESS.md</dt><dd>{props.result.worktree.progressPath}</dd></div>
        <div><dt>Inputs</dt><dd>{props.result.worktree.inputPath}</dd></div>
        <div><dt>Task branch</dt><dd>{props.result.worktree.branchName}</dd></div>
        <div><dt>{uiText('前一 revision', 'Previous Revision')}</dt><dd>{props.result.previousRepositoryRevision}</dd></div>
        <div><dt>{uiText('当前 revision', 'Current Revision')}</dt><dd>{props.result.candidateRepositoryRevision}</dd></div>
        <div><dt>{uiText('变更文件', 'Changed Files')}</dt><dd>{props.result.changedPaths.join(', ')}</dd></div>
        <div><dt>Connection</dt><dd>{props.result.invocation.connectionName}</dd></div>
        <div><dt>Backend</dt><dd>{backendLabel(props.result.invocation.backendKind)}</dd></div>
        <div><dt>Provider</dt><dd>{providerLabel(props.result.invocation.providerId)}</dd></div>
        <div><dt>Model</dt><dd>{props.result.invocation.model}</dd></div>
        <div><dt>Runtime</dt><dd>{runtimeLabel(props.result.invocation.runtime)}</dd></div>
        <div><dt>{uiText('活动段', 'Activity Segments')}</dt><dd>{props.result.activitySegmentCount}</dd></div>
        <div><dt>{uiText('模型调用', 'Model Calls')}</dt><dd>{props.result.invocation.modelCallCount}</dd></div>
        <div><dt>{uiText('耗时', 'Duration')}</dt><dd>{formatDuration(props.result.durationMs)}</dd></div>
        <div><dt>{uiText('完成时间', 'Completed At')}</dt><dd>{formatTime(props.result.completedAt)}</dd></div>
      </dl>
    </section>
  )
}

export function KnowledgeProcessingPage() {
  const controller = createKnowledgeProcessingController()
  const [view, setView] = createSignal<'knowledge_task' | 'history' | 'agent_preview'>('knowledge_task')
  const [selectedSourceConversationId, setSelectedSourceConversationId] = createSignal<string>()
  const [knowledgeTaskAttention, setKnowledgeTaskAttention] = createSignal('')
  const [attention, setAttention] = createSignal('')
  const [instructions, setInstructions] = createSignal('')

  const maintainer = createMemo(() => controller.state().agents.find(
    (agent) => agent.agentId === 'knowledge_maintainer'
  ))
  const reviewer = createMemo(() => controller.state().agents.find(
    (agent) => agent.agentId === 'knowledge_reviewer'
  ))
  const defaultLlm = createMemo(() => controller.state().defaultLlm)
  const selectedConnection = createMemo(() => controller.state().connections.find(
    (connection) => connection.id === defaultLlm()?.connectionId
  ))
  const selectedSourceConversation = createMemo(() => {
    const selected = selectedSourceConversationId()
    if (!selected) return undefined
    return controller.sourceConversations().find((conversation) => (
      conversation.sourceConversationId === selected
    ))
  })
  const maintenanceInvocation = createMemo(() => controller.latestInvocation('agent_preview'))
  const knowledgeTaskInvocations = createMemo(() => {
    return controller.liveInvocations('knowledge_task')
  })
  const currentMaintenanceResult = createMemo(() => {
    const result = controller.maintenanceResult()
    const invocation = maintenanceInvocation()
    if (!result || (invocation && invocation.invocation.invocationId !== result.agentInvocationId)) return undefined
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
    if (selectedSourceConversationId() && !selectedSourceConversation()) {
      setSelectedSourceConversationId(undefined)
      controller.invalidatePreviewResult()
      controller.resetKnowledgeTaskResult()
    }
  })

  function configurationIssue(agent?: KnowledgeAgentDefinitionView): string | undefined {
    if (!agent) return uiText('正在读取 Knowledge Maintenance Agent 配置…', 'Reading Knowledge Maintenance Agent configuration…')
    const binding = defaultLlm()
    if (!binding) return uiText('请先在“设置 / AI 后端”中配置默认 LLM。', 'Configure a default LLM in Settings / AI Backends first.')
    const connection = selectedConnection()
    if (!connection) return `${uiText('默认 LLM 的 Connection 当前不可用：', 'The default LLM Connection is currently unavailable: ')}${binding.connectionId}.`
    const model = selectedLlmModel(binding, connection)
    if (!model) return `${uiText('默认 LLM 的 Model 当前不可用：', 'The default LLM Model is currently unavailable: ')}${binding.modelId}.`
    if (binding.reasoningEffort && !model.reasoningEfforts.includes(binding.reasoningEffort)) {
      return uiText('默认 LLM 的思考强度不受当前 Model 支持。', 'The default LLM reasoning effort is not supported by the current Model.')
    }
    if (!connectionCanInvokeAgent(connection)) {
      return `${uiText('Connection 状态为“', 'Connection status is “')}${connectionStatusLabel(connection.status)}${uiText('”，需要先完成认证或配置。', '”; complete authentication or configuration first.')}`
    }
    return undefined
  }

  const disabledReason = createMemo(() => {
    const agent = maintainer()
    if (anyActivityInProgress()) return uiText('已有 Knowledge Processing Task 或 Agent Preview 处于进行中。', 'A Knowledge Processing Task or Agent Preview is already in progress.')
    if (agent && controller.isSaving(agent.agentId)) return uiText('正在保存 Agent 配置…', 'Saving Agent configuration…')
    const issue = configurationIssue(agent)
    if (issue) return issue
    if (instructionsDirty()) return uiText('处理指令有未保存修改，请先保存。', 'Processing instructions have unsaved changes; save them first.')
    if (controller.sourceConversationsLoading()) return uiText('正在读取 Source Conversations…', 'Reading Source Conversations…')
    if (!controller.sourceConversations().length) return uiText('暂无可用 Source Conversation，请先在“数据来源”中完成扫描。', 'No Source Conversation is available. Complete a scan under Sources first.')
    if (!selectedSourceConversation()) return uiText('请先选择一个 Source Conversation。', 'Select a Source Conversation first.')
    return undefined
  })

  function updateSelectedSourceConversation(conversation?: SourceConversationSummary): void {
    setSelectedSourceConversationId(conversation?.sourceConversationId)
    controller.invalidatePreviewResult()
    controller.resetKnowledgeTaskResult()
  }

  return (
    <>
      <header class="page-header">
        <div>
          <h1>{uiText('加工测试', 'Processing')}</h1>
          <div class="page-summary">
            <span>{uiText('Task 与 Agent Preview 均由用户显式启动', 'Tasks and Agent Previews are started explicitly by the user')}</span>
            <span class="page-summary__separator">·</span>
            <span>{uiText('Reviewer 合并到 main 后 Task 才完成', 'Tasks complete after the Reviewer integrates them into main')}</span>
          </div>
        </div>
        <TabList class="processing-mode-nav" variant="segmented" size="compact" ariaLabel={uiText('加工测试工作面', 'Processing workspaces')}>
          <Tab data-testid="processing-view-knowledge-task" selected={view() === 'knowledge_task'} onClick={() => setView('knowledge_task')}>{uiText('链路测试', 'Workflow Test')}</Tab>
          <Tab data-testid="processing-view-history" selected={view() === 'history'} onClick={() => { setView('history'); void controller.loadKnowledgeTasks() }}>{uiText('历史记录', 'History')}</Tab>
          <Tab data-testid="processing-view-agent-preview" selected={view() === 'agent_preview'} onClick={() => setView('agent_preview')}>{uiText('高级调试', 'Advanced Debugging')}</Tab>
        </TabList>
      </header>

      <Show when={controller.error()}>{(error) => <div class="page-error"><Icon name="warning" />{error()}</div>}</Show>
      <Show when={controller.state().configurationError}>{(error) => <div class="page-error"><Icon name="warning" />{error()}</div>}</Show>

      <div class="processing-page-panel processing-tab-panel" role="tabpanel" hidden={view() !== 'knowledge_task'}>
        <KnowledgeTaskWorktree
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
              attention: knowledgeTaskAttention().trim() || undefined
            })
          }}
          onCancel={() => void controller.cancelKnowledgeTask()}
        />
      </div>

      <div class="processing-page-panel processing-tab-panel" role="tabpanel" hidden={view() !== 'history'}>
        <KnowledgeTaskHistory
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
          <strong>{uiText('高级调试', 'Advanced Debugging')}</strong>
          <span>{uiText(
            '启动 Maintainer Agent Preview，检查 Activity/Evidence 读取、Git 文件修改与提交。',
            'Start a Maintainer Agent Preview to inspect Activity/Evidence reads, Git file changes, and commits.'
          )}</span>
        </div>
        <section class="processing-list" aria-label="Knowledge Agent Definitions">
          <Show when={maintainer()}>
            {(agent) => {
              const connection = () => selectedConnection()
              const model = () => selectedLlmModel(defaultLlm(), connection())
              return (
                <article id="knowledge-agent-knowledge_maintainer" class="knowledge-agent agent-preview-worktree" data-testid="knowledge-agent-knowledge_maintainer">
                  <div class="knowledge-agent__header">
                    <span class="knowledge-agent__index">1</span>
                    <div>
                      <h2>{uiText('知识维护 Agent', 'Knowledge Maintainer')}</h2>
                      <p>{uiText(
                        '在统一 Repository 中按 Task 工作清单检查活动并直接维护 Knowledge 与 Artifact。',
                        'Checks activities from the Task checklist and directly maintains Knowledge and Artifacts in the unified Repository.'
                      )}</p>
                    </div>
                    <span class="agent-runtime-label">{runtimeLabel(agent().runtime)}</span>
                  </div>
                  <div class="processing-capabilities">
                    <For each={agent().capabilities}>{(capability) => <span>{maintainerCapability(capability)}</span>}</For>
                  </div>

                  <div class="processing-worktree-panel agent-preview__configuration" aria-label={uiText('模型与提示词', 'Model and Prompt')}>
                    <div class="processing-connection">
                      <Show when={connection() && model()} fallback={<p class="knowledge-agent__preview-status knowledge-agent__preview-status--blocked">{uiText('请先在“设置 / AI 后端”中配置可用的默认 LLM。', 'Configure an available default LLM in Settings / AI Backends first.')}</p>}>
                        <dl class="processing-connection__details" data-testid="processing-config-knowledge_maintainer">
                          <div><dt>Connection</dt><dd>{connection()?.displayName}</dd></div>
                          <div><dt>Backend</dt><dd>{backendLabel(connection()!.backendKind)}</dd></div>
                          <div><dt>Provider</dt><dd>{providerLabel(connection()!.providerId)}</dd></div>
                          <div><dt>Model</dt><dd>{model()?.id}</dd></div>
                          <div><dt>Reasoning</dt><dd>{reasoningLabel(defaultLlm()?.reasoningEffort)}</dd></div>
                          <div><dt>Runtime</dt><dd>{runtimeLabel(agent().runtime)}</dd></div>
                          <div><dt>{uiText('配置位置', 'Configuration')}</dt><dd>{uiText('AI 后端 · 默认 LLM', 'AI Backends · Default LLM')}</dd></div>
                        </dl>
                      </Show>
                    </div>
                    <section class="processing-prompt" aria-label={uiText('Knowledge Maintenance Agent 提示词', 'Knowledge Maintenance Agent Prompt')}>
                      <div class="processing-prompt__heading">
                        <div><h3>{uiText('处理指令', 'Processing Instructions')}</h3><p>{uiText('作为 Maintainer 的 System Prompt 使用。', 'Used as the Maintainer System Prompt.')}</p></div>
                        <span class={`processing-mode-badge${instructions() !== agent().defaultInstructions ? ' processing-mode-badge--custom' : ''}`} data-testid="processing-prompt-badge-knowledge_maintainer">{instructions() !== agent().defaultInstructions ? uiText('已自定义', 'Customized') : uiText('默认', 'Default')}</span>
                      </div>
                      <textarea class="processing-prompt__editor" data-testid="processing-instructions-knowledge_maintainer" value={instructions()} rows={12} spellcheck={false} disabled={anyActivityInProgress() || controller.isSaving(agent().agentId)} onInput={(event) => setInstructions(event.currentTarget.value)} />
                      <div class="processing-prompt__actions">
                        <Button variant="ghost" icon="refresh" data-testid="restore-processing-instructions-knowledge_maintainer" disabled={anyActivityInProgress() || controller.isSaving(agent().agentId) || (!agent().isCustomized && instructions() === agent().defaultInstructions)} onClick={() => { setInstructions(agent().defaultInstructions); void controller.saveAgent({ agentId: agent().agentId, instructionsOverride: null }) }}>{uiText('恢复默认', 'Restore Default')}</Button>
                        <Button variant="secondary" icon="check" data-testid="save-processing-instructions-knowledge_maintainer" disabled={anyActivityInProgress() || controller.isSaving(agent().agentId) || !instructionsDirty() || !instructions().trim()} onClick={() => void controller.saveAgent({ agentId: agent().agentId, instructionsOverride: instructions() === agent().defaultInstructions ? null : instructions() })}>{uiText('保存提示词', 'Save Prompt')}</Button>
                      </div>
                    </section>
                  </div>

                  <div class="processing-worktree-panel agent-preview__input" aria-label={uiText('Agent Preview 输入', 'Agent Preview input')}>
                    <section class="processing-input" aria-label={uiText('知识维护输入', 'Knowledge maintenance input')}>
                      <div class="processing-input__heading"><h3>{uiText(
                        '独立 Task worktree 中的 BRIEF.md、PROGRESS.md、文件化 Observation 与 Task branch',
                        'BRIEF.md, PROGRESS.md, file-based Observations, and the Task branch in an isolated Task worktree'
                      )}</h3><span>{uiText('不会自动调用', 'Never runs automatically')}</span></div>
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
                        <span>{uiText('补充关注内容（可选）', 'Additional Focus (Optional)')}</span>
                        <input data-testid="processing-attention-input" value={attention()} placeholder={uiText('例如：重点关注用户明确否定过的设计选择', 'For example: focus on design choices the user explicitly rejected')} disabled={anyActivityInProgress()} onInput={(event) => { setAttention(event.currentTarget.value); controller.invalidatePreviewResult() }} />
                      </label>
                      <p class={`knowledge-agent__preview-status${disabledReason() ? ' knowledge-agent__preview-status--blocked' : ''}`} data-testid="maintainer-disabled-reason">{disabledReason() || uiText('配置和来源对话已准备，可以启动 Agent Preview。', 'Configuration and the Source Conversation are ready; the Agent Preview can start.')}</p>
                      <div class="knowledge-agent__actions">
                        <Show when={controller.hasActiveInvocation(agent().agentId)} fallback={(
                          <Button variant="primary" icon="play" data-testid="preview-maintainer" disabled={Boolean(disabledReason())} onClick={() => { const conversation = selectedSourceConversation(); if (conversation) void controller.previewKnowledgeMaintainer({ sourceConversationId: conversation.sourceConversationId, attention: attention().trim() || undefined }) }}>{uiText('预览知识维护', 'Preview Knowledge Maintenance')}</Button>
                        )}>
                          <Button variant="danger" icon="stop" data-testid="cancel-maintainer" onClick={() => void controller.cancelAgentPreview(agent().agentId)}>{uiText('停止预览', 'Stop Preview')}</Button>
                        </Show>
                      </div>
                    </section>
                  </div>

                  <div class="processing-worktree-panel agent-preview__process" aria-label={uiText('调用过程', 'Invocation process')}>
                    <Show when={maintenanceInvocation()} fallback={<div class="processing-worktree-empty">{uiText('启动 Agent Preview 后，这里会展示 Agent Turn、模型与工具调用。', 'Agent Turns, model calls, and tool calls appear here after the Agent Preview starts.')}</div>}>
                      {(view) => <AgentInvocationPanel view={view()} title={uiText('知识维护 Agent Preview', 'Knowledge Maintenance Agent Preview')} />}
                    </Show>
                  </div>
                  <div class="processing-worktree-panel agent-preview__output" aria-label={uiText('输出结果', 'Output result')}>
                    <Show when={!controller.hasActiveInvocation(agent().agentId) ? currentMaintenanceResult() : undefined} fallback={<div class="processing-worktree-empty">{uiText('完成预览后，这里会展示 Task worktree 与提交结果。', 'The Task worktree and commit result appear here after the preview completes.')}</div>}>
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

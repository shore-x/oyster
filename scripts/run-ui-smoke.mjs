import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import electron from 'electron'

const root = resolve(import.meta.dirname, '..')
const capturePath = join(root, 'artifacts', 'ui', 'agent-sources.png')
const userDataPath = join(root, 'artifacts', 'ui', 'electron-user-data')
await mkdir(dirname(capturePath), { recursive: true })
await rm(userDataPath, { recursive: true, force: true })

const child = spawn(electron, ['.', `--user-data-dir=${userDataPath}`], {
  cwd: root,
  env: {
    ...process.env,
    OYSTER_FIXTURE_MODE: '1',
    OYSTER_UI_CAPTURE_PATH: capturePath
  },
  stdio: 'inherit'
})

const exitCode = await new Promise((resolveExit) => child.once('exit', resolveExit))
if (exitCode !== 0) throw new Error(`Electron UI smoke test exited with code ${exitCode}`)

const semantics = JSON.parse(await readFile(`${capturePath}.json`, 'utf8'))
if (semantics.title !== 'Agent 数据来源') throw new Error('Expected page title was not rendered')
if (semantics.sourceCards !== 3) throw new Error(`Expected 3 source cards, got ${semantics.sourceCards}`)
if (semantics.dragRegion !== 'drag') throw new Error('Right-side window drag region is missing')
if (!semantics.primaryButtonColor.includes('82, 121, 165')) throw new Error('Primary action does not use the muted blue token')
if (!semantics.secondaryButtonColor.includes('63, 63, 70')) throw new Error('Secondary action is not neutral gray')
if (semantics.buttonLabelCenterDelta > 1) throw new Error('Button label is not geometrically centered')
if (semantics.buttonCount !== semantics.sharedButtonCount) throw new Error('A button bypasses the shared UI component')
if (semantics.buttonIconCount < semantics.sharedButtonCount) throw new Error('A shared button icon was not rendered')
if (semantics.overflowX) throw new Error('Page has unexpected horizontal overflow')
if (!semantics.primaryActions.includes('探测本机 Agent')) throw new Error('Discovery action is missing')
if (!semantics.bodyText.includes('内容将在使用时从原始位置读取')) throw new Error('On-demand source reading is not explained')
for (const removedCopy of ['打开导入目录', '正在导入原始记录', '已全部导入']) {
  if (semantics.bodyText.includes(removedCopy)) throw new Error(`Removed import copy is still rendered: ${removedCopy}`)
}
for (const removedCopy of ['KNOWLEDGE SOURCES', '数据仅保存在本机', 'LOCAL KNOWLEDGE HUB']) {
  if (semantics.bodyText.includes(removedCopy)) throw new Error(`Redundant copy is still rendered: ${removedCopy}`)
}

const knowledge = semantics.knowledge
if (knowledge.browse.title !== '知识库') throw new Error('Knowledge browser page was not rendered')
if (knowledge.browse.statementCount !== 2) {
  throw new Error(`Expected 2 fixture knowledge Statements, got ${knowledge.browse.statementCount}`)
}
if (!knowledge.browse.selectedTitle || knowledge.browse.detailTitle !== knowledge.browse.selectedTitle) {
  throw new Error('Knowledge browser did not load the selected Statement detail')
}
if (!knowledge.browse.detailContent?.includes('Knowledge Maintenance Agent')) {
  throw new Error('Knowledge browser did not render the current Statement body')
}
if (
  knowledge.browse.linkLabel !== '知识维护 Agent'
  || knowledge.browse.linkPreviewTitle !== 'Knowledge Maintenance Agent'
  || !knowledge.browse.linkPreview?.includes('读取候选清单')
) {
  throw new Error('Knowledge browser did not render the wikilink alias and hover preview')
}
if (
  knowledge.browse.linkedTitle !== 'Knowledge Maintenance Agent'
  || !knowledge.browse.backAvailable
  || knowledge.browse.titleAfterBack !== 'Oyster 知识加工链路'
  || knowledge.browse.overflowAfterBack
  || !knowledge.browse.forwardAvailable
  || knowledge.browse.titleAfterForward !== 'Knowledge Maintenance Agent'
) {
  throw new Error('Knowledge browser wikilink history cannot navigate backward and forward')
}
if (knowledge.browse.searchPlaceholder !== '搜索标题或正文') {
  throw new Error('Knowledge browser search is missing')
}
if (knowledge.browse.clearButtonDisabled !== false) {
  throw new Error('Knowledge clear action is unavailable for a non-empty Store')
}
if (knowledge.browse.overflowX) throw new Error('Knowledge browser has unexpected horizontal overflow')
if (
  !knowledge.clear?.exists
  || knowledge.clear.role !== 'alertdialog'
  || knowledge.clear.modal !== 'true'
) {
  throw new Error('Clearing knowledge does not use an in-app modal confirmation dialog')
}
if (knowledge.clear.title !== '清空知识？') {
  throw new Error('The clear-knowledge confirmation title is missing')
}
if (!knowledge.clear.description?.includes('无法撤销')) {
  throw new Error('The irreversible clear-knowledge impact is not explained')
}
if (knowledge.clear.actions?.join(',') !== '取消,清空知识') {
  throw new Error('Clear-knowledge confirmation actions are not ordered cancel then confirm')
}
if (!knowledge.clear.cancelled) {
  throw new Error('The clear-knowledge confirmation cannot be cancelled')
}
if (!knowledge.clear.completed || !knowledge.clear.closedAfterCompletion || knowledge.clear.statementCountAfterClear !== 0) {
  throw new Error(`Knowledge was not cleared through the confirmed action: ${knowledge.clear.error || 'unknown error'}`)
}
if (!knowledge.clear.result?.includes('已清空 2 条知识')) {
  throw new Error('The knowledge browser does not report the completed reset')
}

if (semantics.ai.agent.title !== 'AI 后端') throw new Error('AI backend page was not rendered')
if (semantics.ai.agent.backendKind !== 'coding_plan') throw new Error('Coding Plan is not the default backend')
if (semantics.ai.agent.provider !== 'openai_codex') throw new Error('OpenAI Codex is not selected for the Coding Plan backend')
if (semantics.ai.agent.codexCards !== 1) throw new Error('Codex runtime card is missing')
if (semantics.ai.agent.codingPlanModel !== 'fixture-codex-small') throw new Error('Coding Plan test model is not explicit')
if (semantics.ai.agent.codingPlanReasoning !== '') throw new Error('Coding Plan fixture should use the model-default reasoning effort')
if (!semantics.ai.agent.codingPlanConfiguration?.includes('Fixture Codex Small')) throw new Error('Coding Plan test configuration is not visible')
if (!semantics.ai.agent.bodyText.includes('Coding Plan')) throw new Error('Coding Plan choice is missing')
for (const requiredCopy of ['Oyster 独立 OAuth', '本机 Codex 账号（仅发现）', '本机 Plan（仅发现）']) {
  if (!semantics.ai.agent.bodyText.includes(requiredCopy)) {
    throw new Error(`Coding Plan authentication boundary is missing: ${requiredCopy}`)
  }
}
if (semantics.ai.agent.overflowX) throw new Error('AI backend page has unexpected horizontal overflow')
if (!semantics.ai.directTest?.completed) {
  throw new Error(`AI connection test did not complete without a native confirmation dialog: ${semantics.ai.directTest?.error || 'unknown error'}`)
}
if (semantics.ai.model.backendKind !== 'api') throw new Error('API backend choice did not update the form')
if (semantics.ai.model.provider !== 'openai') throw new Error('OpenAI is not the default Model provider')
if (semantics.ai.model.passwordFields !== 1) throw new Error('API Key password field is missing')
if (semantics.ai.model.passwordValues.some(Boolean)) throw new Error('The fixture exposed a stored API Key to the renderer')
if (semantics.ai.model.configuredModel !== 'fixture-model') throw new Error('API Connection test model is not explicit')
if (semantics.ai.model.configuredReasoning !== '') throw new Error('API fixture should use the model-default reasoning effort')
if (!semantics.ai.model.configuredSummary?.includes('fixture-model')) throw new Error('API Connection test configuration is not visible')
if (!semantics.ai.model.bodyText.includes('OpenAI-compatible')) throw new Error('Custom compatible provider choice is missing')

const agentConfiguration = semantics.agentConfiguration
if (agentConfiguration?.title !== 'Agent 配置' || agentConfiguration.roleCount !== 3) {
  throw new Error('Agent configuration page does not list the registered AI runtime roles')
}
if (!agentConfiguration.preprocessorRoleText?.includes('Direct Model')) {
  throw new Error('The Observation Preprocessor is not identified as a direct model call')
}
if (
  agentConfiguration.preprocessorToolCount !== 0
  || !agentConfiguration.preprocessorToolsEmpty?.includes('不向模型提供工具')
) {
  throw new Error('The direct preprocessing call incorrectly exposes Agent tools')
}
if (
  agentConfiguration.maintenanceToolNames?.length !== 11
  || !agentConfiguration.maintenanceToolNames.includes('search_knowledge')
  || !agentConfiguration.maintenanceToolNames.includes('read_evidence')
  || !agentConfiguration.maintenanceToolNames.includes('submit_knowledge_contribution')
) {
  throw new Error('The Agent tool catalog does not match the Knowledge Maintenance runtime')
}
if (!agentConfiguration.toolsReadOnlyCopy?.includes('只读展示')) {
  throw new Error('The Agent configuration page does not explain that tools are code-owned')
}
if (agentConfiguration.schemaPanelCount !== 11 || agentConfiguration.expandedSchemaCount !== 2) {
  throw new Error('The Agent tool parameter schemas are not available through expandable panels')
}
const searchToolSchema = agentConfiguration.searchToolSchema
if (
  searchToolSchema?.type !== 'object'
  || searchToolSchema.additionalProperties !== false
  || !searchToolSchema.required?.includes('query')
  || searchToolSchema.properties?.query?.maxLength !== 1024
  || searchToolSchema.properties?.limit?.maximum !== 20
) {
  throw new Error('The search_knowledge developer schema lost required fields or constraints')
}
const candidateItemSchema = agentConfiguration.candidateToolSchema?.properties?.candidates?.items
const candidateLocationSchema = candidateItemSchema?.properties?.locations?.items
if (
  !agentConfiguration.candidateToolSchema?.required?.includes('candidates')
  || !candidateItemSchema?.required?.includes('expression')
  || !candidateItemSchema?.required?.includes('question')
  || candidateItemSchema?.properties?.expression?.maxLength !== 512
  || !candidateLocationSchema?.required?.includes('line')
  || !candidateLocationSchema?.required?.includes('offset')
) {
  throw new Error('The nested Statement candidate developer schema is incomplete')
}
if (
  !agentConfiguration.builtInPrompt?.includes('Knowledge Maintenance Agent')
  || agentConfiguration.configuredBadge !== 'Configured default'
  || !agentConfiguration.saveNotice?.includes('已保存')
  || !agentConfiguration.processingPromptUsesConfiguredDefault
) {
  throw new Error('A configured default System Prompt does not flow into knowledge processing')
}
if (agentConfiguration.restoredBadge !== 'Built-in default' || !agentConfiguration.restoredMatchesBuiltIn) {
  throw new Error('The configured default System Prompt cannot be restored to the code default')
}
if (!agentConfiguration.chatRoleText?.includes('对话 Agent')) {
  throw new Error('The conversational Agent is missing from Agent configuration')
}
if (
  agentConfiguration.chatToolNames?.join(',')
    !== 'search_knowledge,read_knowledge_statement,upsert_knowledge_statements'
  || agentConfiguration.chatSchemaPanelCount !== 3
) {
  throw new Error('The conversational Agent tool catalog is incomplete')
}
const chatStatementItem = agentConfiguration.chatUpsertSchema?.properties?.statements?.items
if (
  agentConfiguration.chatUpsertSchema?.type !== 'object'
  || !agentConfiguration.chatUpsertSchema?.required?.includes('statements')
  || !chatStatementItem?.required?.includes('title')
  || !chatStatementItem?.required?.includes('content')
) {
  throw new Error('The conversational Agent write-tool schema is not available to developers')
}
if (
  agentConfiguration.chatConfiguredBadge !== 'Configured default'
  || !agentConfiguration.chatRestoredMatchesBuiltIn
) {
  throw new Error('The conversational Agent default System Prompt cannot be configured and restored')
}
if (agentConfiguration.overflowX) throw new Error('Agent configuration page has unexpected horizontal overflow')

const chat = semantics.chat
if (chat?.title !== '对话' || chat.sessionCount !== 1) {
  throw new Error('The conversational Agent page did not create a persistent Session')
}
if (!chat.selectedModel || !chat.binding?.includes(chat.selectedModel)) {
  throw new Error('The conversational Agent did not expose its frozen model binding')
}
if (!chat.userText?.includes('使用知识库') || !chat.assistantText?.includes('Fixture 对话 Agent')) {
  throw new Error(`The conversational Agent did not complete a real fixture turn: ${chat.pageError || 'no response'}`)
}
if (!chat.composerVisible || !chat.workspaceWithinViewport || chat.overflowX) {
  throw new Error('The conversational workspace does not remain within the viewport')
}

const processing = semantics.processing
if (processing.title !== '加工测试') throw new Error('Knowledge processing page was not rendered')
if (processing.fullChain.fullChainSelected !== 'true' || !processing.fullChain.workspaceExists) {
  throw new Error('Full-chain Sandbox workspace is not the default knowledge processing view')
}
if (processing.fullChain.sessionOptionCount !== 2) {
  throw new Error(`Expected one available fixture Session, got ${processing.fullChain.sessionOptionCount - 1}`)
}
if (!processing.fullChain.fullChainButtonExists || processing.fullChain.fullChainButtonDisabled !== true) {
  throw new Error('Full-chain action must wait for an explicit Session selection')
}
if (!processing.fullChain.initialDisabledReason?.includes('选择一个 Session')) {
  throw new Error('Full-chain view does not explain why the action is initially disabled')
}
if (!processing.fullChain.selectedSession || processing.fullChain.fullChainButtonEnabledAfterSelection !== true) {
  throw new Error('A complete stage configuration must become runnable after selecting a Session')
}
const selectedSessionDetails = processing.fullChain.selectedSessionDetails
if (selectedSessionDetails?.title !== '知识加工 Sandbox 设计讨论') {
  throw new Error('The selected Session title is not visible in the full-chain details')
}
if (!selectedSessionDetails?.timeRange?.includes('→')) {
  throw new Error('The selected Session time range is not visible in the full-chain details')
}
if (!selectedSessionDetails?.size?.match(/\d+(\.\d+)? (B|KB|MB|GB)/)) {
  throw new Error(`Expected readable fixture Session size, got ${selectedSessionDetails?.size || 'no value'}`)
}
if (selectedSessionDetails?.project !== '/Users/demo/projects/oyster') {
  throw new Error('The selected Session project is not visible in the full-chain details')
}
if (!processing.fullChain.readyReason?.includes('准备完成')) {
  throw new Error('Full-chain view does not report that the selected configuration is runnable')
}
for (const requiredCopy of ['预处理', '知识维护', 'API', 'OpenAI-compatible', 'Fixture Model', '模型默认']) {
  if (!processing.fullChain.modelSummary?.includes(requiredCopy)) {
    throw new Error(`Full-chain stage configuration is missing: ${requiredCopy}`)
  }
}
if (!processing.fullChain.bodyText.includes('Sandbox 链路测试')) {
  throw new Error('Knowledge Sandbox boundary is not visible in the full-chain view')
}
if (
  !processing.fullChain.bodyText.includes('不会自动写回')
  || !processing.fullChain.bodyText.includes('手动导入')
) {
  throw new Error('Full-chain view does not explain its isolated write boundary')
}
if (!processing.fullChainRun?.runningStateVisible || !processing.fullChainRun?.completed) {
  throw new Error(`Full-chain run did not complete without a native confirmation dialog: ${processing.fullChainRun?.error || 'unknown error'}`)
}
if (processing.fullChainRun.overviewHasTraceExplorer) {
  throw new Error('The full-chain overview still renders the unbounded detailed trace')
}
if (processing.fullChainRun.summaryStatementCount !== '2' || processing.fullChainRun.summaryCandidateCount !== '1') {
  throw new Error('The full-chain overview does not expose compact result counts')
}
if (!processing.fullChainRun.traceExplorerExists || processing.fullChainRun.traceEventCount < 4) {
  throw new Error('The secondary run-detail page does not expose the complete event list')
}
if (!processing.fullChainRun.modelOutput?.includes('Tool call · read_evidence')) {
  throw new Error('The run-detail page does not expose each model call output')
}
if (!processing.fullChainRun.toolInput?.includes('"line":1') || !processing.fullChainRun.toolOutput?.includes('Fixture raw evidence')) {
  throw new Error('The run-detail page does not expose tool arguments and results')
}
if (!processing.fullChainRun.resultDetailExists || !processing.fullChainRun.returnedToOverview) {
  throw new Error('The full-chain result detail is not a navigable secondary page')
}
if (processing.fullChainRun.candidateCount !== 1 || processing.fullChainRun.resolutionCount !== 1) {
  throw new Error('Full-chain result does not expose the adjudicated Statement Candidate Agenda')
}
if (processing.fullChainRun.statementCount !== 2) {
  throw new Error('Full-chain result does not expose the committed Knowledge Statement')
}
if (
  processing.fullChainRun.sandboxLinkLabel !== '知识维护 Agent'
  || !processing.fullChainRun.sandboxLinkPreview?.includes('Knowledge Maintenance Agent')
  || processing.fullChainRun.sandboxLinkedTitle !== 'Knowledge Maintenance Agent'
) {
  throw new Error('Sandbox result does not use the shared wikilink reader with hover previews')
}
if (
  !processing.fullChainRun.sandboxBackAvailable
  || processing.fullChainRun.sandboxTitleAfterBack !== '知识加工链路'
  || processing.fullChainRun.sandboxOverflowAfterBack
  || !processing.fullChainRun.sandboxForwardAvailable
  || processing.fullChainRun.sandboxTitleAfterForward !== 'Knowledge Maintenance Agent'
) {
  throw new Error('Sandbox Statement reader cannot navigate backward and forward')
}
if (/来源范围\s+L\d|Raw source|sourceRef|revision|Run ID|扫描版本/.test(processing.fullChainRun.bodyText || '')) {
  throw new Error('The full-chain result exposes internal source coordinates or implementation identifiers')
}
if (processing.history?.runCount !== 1 || !processing.history.listText?.includes('知识加工 Sandbox 设计讨论')) {
  throw new Error('The completed full-chain run was not added to persistent history')
}
if (/Fixture raw evidence|Tool call ·|sourceRef|L\d{6}/.test(processing.history.listText || '')) {
  throw new Error('The compact history list eagerly exposes trace or evidence payloads')
}
if (!processing.history.resultDetailExists || !processing.history.sharedBrowserExists) {
  throw new Error('Historical results do not reuse the shared Statement browser')
}
if (
  !processing.history.importButtonExists
  || !processing.history.importNotice?.includes('已导入 2 条知识')
  || processing.history.productionTitles?.join(',') !== 'Knowledge Maintenance Agent,知识加工链路'
) {
  throw new Error('A persisted test result cannot be imported into production by title')
}
if (processing.history.overflowAfterStatementBack) {
  throw new Error('Historical Statement navigation introduces horizontal overflow after going back')
}
if (
  !processing.history.activityDetailExists
  || processing.history.traceEventCount < 4
  || !processing.history.traceText?.includes('Fixture raw evidence')
) {
  throw new Error('Historical run details do not expose the persisted model and tool trace')
}
if (!processing.history.returnedToHistory) {
  throw new Error('Historical secondary pages do not return to the history list')
}
if (processing.fullChain.bodyText.includes('已导入 Session')) {
  throw new Error('Full-chain view still exposes the removed import model')
}
if (processing.fullChain.overflowX) throw new Error('Full-chain view has unexpected horizontal overflow')
if (processing.stageCount !== 2) throw new Error(`Expected 2 fixed processing stages, got ${processing.stageCount}`)
if (processing.promptCount !== 2) throw new Error(`Expected 2 processing prompt editors, got ${processing.promptCount}`)
if (processing.promptValues.some((prompt) => typeof prompt !== 'string' || !prompt.trim())) {
  throw new Error('A processing default prompt is empty')
}
const [preprocessorPrompt, maintainerPrompt] = processing.promptValues
for (const requiredCopy of ['open investigation agenda', 'not draft Knowledge Statements', 'not a generated topic heading', 'primary language of the original material']) {
  if (!preprocessorPrompt.includes(requiredCopy)) {
    throw new Error(`Observation Preprocessor prompt is missing its responsibility: ${requiredCopy}`)
  }
}
for (const requiredCopy of ['Knowledge Maintenance Agent', 'canonical title names that subject', 'Make the body, not an overloaded title, self-explaining', '[[canonical title]]', 'primary language of the original observation', 'submit_knowledge_contribution']) {
  if (!maintainerPrompt.includes(requiredCopy)) {
    throw new Error(`Knowledge Maintenance Agent prompt is missing its responsibility: ${requiredCopy}`)
  }
}
if (processing.promptValues.some((prompt) => prompt.includes('Oyster'))) {
  throw new Error('A default processing prompt assumes product-specific context')
}
if (processing.badgeValues.length !== 2 || processing.badgeValues.some((badge) => badge !== 'Default')) {
  throw new Error('Both processing stages must show the Default prompt badge in fixture mode')
}
if (processing.connectionValues.length !== 2 || processing.connectionValues.some((value) => value !== 'model:fixture')) {
  throw new Error('Both processing stages must select the fixture Model Connection')
}
if (processing.modelValues.length !== 2 || processing.modelValues.some((value) => value !== 'fixture-model')) {
  throw new Error('Both processing stages must select an explicit fixture model')
}
if (processing.reasoningValues.length !== 2 || processing.reasoningValues.some((value) => value !== '')) {
  throw new Error('Both processing stages must expose their effective model-default reasoning')
}
const stageConfiguration = processing.configurationText.join('\n')
for (const requiredCopy of ['API', 'OpenAI-compatible', 'fixture-model', '模型默认', 'Direct Model', 'Pi Agent Core']) {
  if (!stageConfiguration.includes(requiredCopy)) {
    throw new Error(`Stage debugging configuration is missing: ${requiredCopy}`)
  }
}
if (processing.preprocessorSessionSourceSelected !== 'true' || processing.manualObservationVisible) {
  throw new Error('Stage debugging must default to an available Session instead of manual paste')
}
if (!processing.bodyText.includes('点击运行后会直接调用所选 Connection')) {
  throw new Error('Stage debugging does not explain direct model execution in the page')
}
if (processing.preprocessorSessionOptionCount !== 2) {
  throw new Error(`Expected one available fixture Session in stage debugging, got ${processing.preprocessorSessionOptionCount - 1}`)
}
if (processing.bodyText.includes('已导入 Session')) {
  throw new Error('Stage debugging still exposes the removed import model')
}
if (processing.preprocessorSessionValue !== processing.fullChain.selectedSession) {
  throw new Error('Stage debugging did not preserve the Session selected in the full-chain view')
}
if (!processing.preprocessorButtonExists || processing.preprocessorDisabled !== false) {
  throw new Error('Preprocessor action must be runnable with the preserved Session and ready configuration')
}
if (!processing.preprocessorReadyReason?.includes('可以运行预处理')) {
  throw new Error('Stage debugging does not report that preprocessing is ready to run')
}
if (!processing.maintainerButtonExists || processing.maintainerDisabled !== true) {
  throw new Error('Knowledge maintenance action must remain disabled before preprocessing succeeds')
}
if (processing.resultCount !== 0) throw new Error('Knowledge processing produced a candidate without an explicit run')
if (processing.overflowX) throw new Error('Knowledge processing page has unexpected horizontal overflow')
if (processing.buttonCount !== processing.sharedButtonCount + processing.tabButtonCount + processing.sourceSwitchButtonCount + processing.statementButtonCount + processing.chainStatementButtonCount) {
  throw new Error('A knowledge processing action button bypasses the shared UI component')
}
if (processing.buttonIconCount !== processing.sharedButtonCount) {
  throw new Error('A knowledge processing shared button icon was not rendered')
}
if (processing.promptRestore.customizedBeforeRestore !== 'Customized') {
  throw new Error('An unsaved prompt draft was not shown as Customized')
}
if (!processing.promptRestore.matchesOriginal || processing.promptRestore.defaultAfterRestore !== 'Default') {
  throw new Error('Restore default did not reset an unsaved prompt draft after a successful save')
}
if (processing.trace.panelCount !== 2) throw new Error('Both processing debug trace panels must be rendered')
if (processing.trace.preprocessingCallCount !== 1) throw new Error('The fixture preprocessing call is missing')
if (
  !processing.trace.preprocessingOutput?.includes('"candidates"')
  || !processing.trace.preprocessingOutput?.includes('知识加工链路')
) {
  throw new Error('The preprocessing model output is not visible in the debug trace')
}
if (processing.trace.preprocessingOutput.includes('"locations"') || /L\d{6}/.test(processing.trace.preprocessingOutput)) {
  throw new Error('The preprocessing trace exposes internal evidence coordinates')
}
if (processing.trace.maintenanceEventCount !== 3) {
  throw new Error(`Expected 3 safe maintenance trace events, got ${processing.trace.maintenanceEventCount}`)
}
for (const requiredCopy of ['模型输出可能复述原始材料', '模型轮次 1', '读取原始观察证据', '提交 Knowledge Contribution']) {
  if (!processing.trace.bodyText.includes(requiredCopy)) {
    throw new Error(`Knowledge processing trace is missing: ${requiredCopy}`)
  }
}
if (processing.trace.workspaceValues.join(',') !== '0,1,1,2') {
  throw new Error(`Knowledge maintenance workspace status is incorrect: ${processing.trace.workspaceValues.join(',')}`)
}
if (processing.trace.overflowX) throw new Error('Debug trace view has unexpected horizontal overflow')
if (processing.stateAfterNavigation.selectedSession !== processing.fullChain.selectedSession) {
  throw new Error('Knowledge processing Session selection was lost after navigating away and back')
}
if (processing.stateAfterNavigation.stageDebugSelected !== 'true') {
  throw new Error('Knowledge processing workspace state was lost after navigating away and back')
}
const processingImage = await readFile(join(dirname(capturePath), 'knowledge-processing.png'))
if (processingImage.length === 0) throw new Error('Knowledge processing screenshot is empty')
const stageDebugImage = await readFile(join(dirname(capturePath), 'knowledge-processing-stage-debug.png'))
if (stageDebugImage.length === 0) throw new Error('Knowledge processing stage-debug screenshot is empty')
const preprocessingTraceImage = await readFile(join(dirname(capturePath), 'knowledge-processing-trace-preprocessing.png'))
if (preprocessingTraceImage.length === 0) throw new Error('Preprocessing trace screenshot is empty')
const maintenanceTraceImage = await readFile(join(dirname(capturePath), 'knowledge-processing-trace-maintenance.png'))
if (maintenanceTraceImage.length === 0) throw new Error('Maintenance trace screenshot is empty')
const knowledgeImage = await readFile(join(dirname(capturePath), 'knowledge.png'))
if (knowledgeImage.length === 0) throw new Error('Knowledge browser screenshot is empty')
const clearKnowledgeImage = await readFile(join(dirname(capturePath), 'knowledge-clear-confirmation.png'))
if (clearKnowledgeImage.length === 0) throw new Error('Clear-knowledge confirmation screenshot is empty')

console.log(`UI smoke test passed: ${capturePath}`)

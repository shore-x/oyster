import { mkdir, readFile, rm, stat } from 'node:fs/promises'
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
if (semantics.defaultPage !== 'chat') throw new Error('Chat is not the default product page')
if (semantics.title !== 'Agent 数据来源') throw new Error('Expected page title was not rendered')
if (semantics.documentScrollY !== 0 || semantics.bodyOverflow !== 'hidden') {
  throw new Error('The document still owns business scrolling instead of the App Shell')
}
if (semantics.sourceCards !== 3) throw new Error(`Expected 3 source cards, got ${semantics.sourceCards}`)
if (semantics.dragRegion !== 'drag') throw new Error('Right-side window drag region is missing')
if (
  semantics.headerDragRegion !== 'drag'
  || semantics.headerPosition !== 'sticky'
  || semantics.headerTop !== '0px'
  || semantics.headerActionRegion !== 'no-drag'
) {
  throw new Error('Page Header does not provide a sticky drag surface with interactive controls')
}
if (!semantics.primaryButtonColor.includes('82, 121, 165')) throw new Error('Primary action does not use the muted blue token')
if (!semantics.secondaryButtonColor.includes('39, 39, 42')) throw new Error('Secondary action is not high-contrast neutral gray')
if (semantics.headingFontSize !== '27px' || semantics.headingFontWeight !== '500') {
  throw new Error('Page heading does not use the restrained typography scale')
}
if (semantics.bodyFontSize !== '13px' || semantics.bodyFontWeight !== '400') {
  throw new Error('Desktop UI body typography is not compact and regular-weight')
}
if (!semantics.mutedTextColor.includes('82, 82, 91')) {
  throw new Error('Muted readable text does not use the high-contrast neutral token')
}
if (semantics.buttonLabelCenterDelta > 1) throw new Error('Button label is not geometrically centered')
if (semantics.buttonCount !== semantics.sharedButtonCount) throw new Error('A button bypasses the shared UI component')
if (semantics.buttonIconCount < semantics.sharedButtonCount) throw new Error('A shared button icon was not rendered')
if (semantics.overflowX) throw new Error('Page has unexpected horizontal overflow')
if (!semantics.primaryActions.includes('探测本机 Agent')) throw new Error('Discovery action is missing')
if (semantics.collapsedSourceDetails !== semantics.sourceDetailCount) throw new Error('Source details are not collapsed by default')
if (!semantics.sourceSummary?.includes('个对话')) throw new Error('Source summary does not expose the essential scan information')
if (semantics.defaultBodyText.includes('内容将在使用时从原始位置读取')) throw new Error('Source detail is visible before disclosure')
if (!semantics.bodyText.includes('内容将在使用时从原始位置读取')) throw new Error('On-demand source reading is not explained after disclosure')
for (const removedCopy of ['打开导入目录', '正在导入原始记录', '已全部导入']) {
  if (semantics.bodyText.includes(removedCopy)) throw new Error(`Removed import copy is still rendered: ${removedCopy}`)
}
for (const removedCopy of ['KNOWLEDGE SOURCES', '数据仅保存在本机', 'LOCAL KNOWLEDGE HUB']) {
  if (semantics.bodyText.includes(removedCopy)) throw new Error(`Redundant copy is still rendered: ${removedCopy}`)
}

const skills = semantics.skills
const expectedSkillProjectPath = join(userDataPath, 'skill-fixture-home', 'projects', 'oyster')
if (skills?.title !== 'Skills' || skills.skillCount !== 6) {
  throw new Error(`Skill discovery page did not render all fixture registrations: ${skills?.skillCount ?? 'missing'}`)
}
if (
  skills.skillNames.filter((name) => name === 'project-shared').length !== 2
  || !['全局', '项目', '管理', '系统'].every((scope) => skills.scopeLabels.includes(scope))
) {
  throw new Error('Skill Agent registrations or scope labels are incomplete')
}
if (
  JSON.stringify(skills.agentGroups) !== JSON.stringify([
    { agentType: 'claude', name: 'Claude Code', count: 1 },
    { agentType: 'pi', name: 'Pi', count: 2 },
    { agentType: 'codex', name: 'Codex', count: 3 }
  ])
) {
  throw new Error('Skill registrations are not grouped by Agent')
}
if (
  skills.listOverflowY !== 'auto'
  || !skills.listScrollable
  || skills.detailOverflowY !== 'auto'
  || !skills.browserWithinViewport
) {
  throw new Error('Skill master-detail panes do not scroll independently within the viewport')
}
if (skills.projectPath !== expectedSkillProjectPath || !skills.directoryPath?.startsWith(expectedSkillProjectPath)) {
  throw new Error('Project Skill paths are not shown from the isolated fixture project')
}
if (
  skills.reviewPreviewHeading !== 'Review'
  || !skills.disabledImageText?.includes('remote preview')
  || skills.previewImageCount !== 0
) {
  throw new Error('Skill Markdown preview is missing or loaded an external image')
}
if (skills.openFolderDisabled !== false || skills.pageError || skills.overflowX) {
  throw new Error(`Skill browser is unavailable or visually invalid: ${skills.pageError || 'layout error'}`)
}

const artifacts = semantics.artifacts
const expectedRepositoryPath = join(userDataPath, 'repository')
const expectedArtifactPath = join(expectedRepositoryPath, 'artifacts')
if (artifacts?.title !== '产物') throw new Error('Artifact page was not rendered')
if (
  artifacts.hasIndependentDesignDocumentsNavigation
  || !artifacts.designDocumentsCard
  || artifacts.designDocumentsTitle !== 'Oyster 设计文档'
  || artifacts.designDocumentsBuiltIn !== '内置'
  || artifacts.designDocumentsBrowseDisabled !== false
  || artifacts.designDocumentsOpenDisabled !== false
) {
  throw new Error('Bundled design documents are not presented as an accessible built-in folder card')
}
if (artifacts.repositoryPath !== expectedRepositoryPath) {
  throw new Error(`Oyster Repository is not fixed under userData: ${artifacts.repositoryPath}`)
}
if (
  artifacts.cardCountAfterCreate !== 1
  || artifacts.cardCountAfterRefresh !== 1
  || artifacts.directoryName !== 'attention-tracking'
) {
  throw new Error('Artifact creation or filesystem refresh did not preserve the Artifact')
}
if (artifacts.attentionHeading !== 'Attention' || artifacts.attentionStrong !== 'Attention 测试') {
  throw new Error('Artifact AGENTS.md Markdown was not rendered')
}
if (
  artifacts.repositoryOpenDisabled !== false
  || artifacts.artifactBrowseDisabled !== false
  || artifacts.artifactOpenDisabled !== false
) {
  throw new Error('Artifact browse or folder open actions are unavailable')
}
if (!artifacts.createWasCollapsed || !artifacts.cardDetailsCollapsed) {
  throw new Error('Artifact creation or Attention details are not progressively disclosed')
}
if (artifacts.pageError) throw new Error(`Artifact page reported an error: ${artifacts.pageError}`)
if (artifacts.overflowX) throw new Error(`Artifact page has unexpected horizontal overflow at 900px: ${JSON.stringify(artifacts.overflowElements)}`)
if (!(await stat(join(expectedRepositoryPath, '.git'))).isDirectory()) {
  throw new Error('Oyster Repository was not initialized as Git')
}
if (
  await readFile(join(expectedArtifactPath, 'attention-tracking', 'AGENTS.md'), 'utf8')
  !== '# Attention\n\n持续维护 **Attention 测试**。\n'
) {
  throw new Error('Artifact AGENTS.md was not persisted with the expected content')
}

const artifactBrowser = semantics.folderBrowser?.artifact
if (
  artifactBrowser?.title !== 'attention-tracking'
  || artifactBrowser.path !== join(expectedArtifactPath, 'attention-tracking')
  || !artifactBrowser.selectedPath?.endsWith(join('attention-tracking', 'AGENTS.md'))
  || !artifactBrowser.fileNames?.includes('AGENTS.md')
  || artifactBrowser.markdownHeading !== 'Attention'
  || artifactBrowser.fileTabSelected !== 'true'
  || !artifactBrowser.nestedInArtifacts
  || artifactBrowser.pageError
  || artifactBrowser.overflowX
) {
  throw new Error(`Artifact generic folder browser is unavailable: ${JSON.stringify(artifactBrowser)}`)
}

const designDocumentsBrowser = semantics.folderBrowser?.designDocuments
if (
  designDocumentsBrowser?.title !== 'Oyster 设计文档'
  || designDocumentsBrowser.path !== join(root, 'docs')
  || !designDocumentsBrowser.selectedPath?.startsWith(join(root, 'docs'))
  || !designDocumentsBrowser.fileNames?.includes('folder-browser-mvp.md')
  || !designDocumentsBrowser.markdownRendered
  || designDocumentsBrowser.pageError
  || designDocumentsBrowser.overflowX
) {
  throw new Error(`Bundled design document browser is unavailable: ${JSON.stringify(designDocumentsBrowser)}`)
}

const knowledge = semantics.knowledge
if (knowledge.browse.title !== '知识库') throw new Error('Knowledge browser page was not rendered')
if (knowledge.browse.statementCount !== 4) {
  throw new Error(`Expected 4 fixture knowledge Statements, got ${knowledge.browse.statementCount}`)
}
if (!knowledge.browse.selectedTitle || knowledge.browse.detailTitle !== knowledge.browse.selectedTitle) {
  throw new Error('Knowledge browser did not load the selected Statement detail')
}
if (
  !knowledge.browse.detailContent?.includes('知识维护 Agent')
  || !knowledge.browse.detailContent?.includes('统一 Repository')
) {
  throw new Error('Knowledge browser did not render the current Statement body')
}
if (
  knowledge.browse.linkLabel !== '知识维护 Agent'
  || knowledge.browse.linkPreviewTitle !== 'Knowledge Maintenance Agent'
  || !knowledge.browse.linkPreview?.includes('BRIEF.md、PROGRESS.md')
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
if (
  !knowledge.browse.referenceExplorerExists
  || knowledge.browse.referenceHasCanvas
  || knowledge.browse.referenceHasArrow
  || knowledge.browse.referenceDefaultNodeCount < 2
  || knowledge.browse.referenceNodeCount !== 4
  || knowledge.browse.referenceDefaultNodeCount >= knowledge.browse.referenceNodeCount
  || knowledge.browse.referenceEdgeCount < 3
  || knowledge.browse.referenceFirstHopEdgeCount < 1
  || knowledge.browse.referenceContextualEdgeCount < 1
  || !knowledge.browse.referenceDefaultFirstHopEdgesVisible
  || !knowledge.browse.referenceDefaultContextualEdgesHidden
  || !knowledge.browse.referenceFirstHopEdgesStronger
  || knowledge.browse.referenceClusterCount !== 1
  || !knowledge.browse.referenceHasTwoHopNode
  || !knowledge.browse.referenceTwoHopTitle
  || !knowledge.browse.referenceSecondHopHiddenByDefault
  || !knowledge.browse.referenceSecondHopDisclosedFromFirstHop
  || !knowledge.browse.referenceDisclosureKeepsHeight
  || knowledge.browse.referenceNodeNavigationTitle !== knowledge.browse.referenceTwoHopTitle
  || !knowledge.browse.referenceNodesTransparent
) {
  throw new Error('Knowledge references are not rendered as a directionless, clustered two-hop local graph')
}
if (
  !knowledge.browse.referenceMarkerFree
  || !knowledge.browse.referenceLabelsCentered
  || !knowledge.browse.referenceNodesDoNotOverlap
  || !knowledge.browse.referenceEndpointsClipped
  || !knowledge.browse.referenceEdgesAvoidText
  || !knowledge.browse.referenceEdgesUsePaths
  || knowledge.browse.referenceHasLineElement
  || !knowledge.browse.referenceNodesAreTextButtons
) {
  throw new Error('Knowledge graph paths do not preserve collision-free text nodes and obstacle-free boundary routing')
}
if (
  knowledge.browse.referenceHasIntroCopy
  || knowledge.browse.referenceViewportHeight > 280
  || knowledge.browse.referenceSceneHeight > 280
  || knowledge.browse.referenceTwoHopFontSize !== '11px'
  || knowledge.browse.referenceHoverPreviewTitle !== knowledge.browse.referenceTwoHopTitle
  || !knowledge.browse.referenceHoverPreviewText
  || ['它引用', '引用它', '距中心', '个相邻'].some((copy) => knowledge.browse.referenceHoverPreviewText.includes(copy))
  || !knowledge.browse.referenceHoverPreviewInsideGraph
  || !knowledge.browse.referenceHoverKeepsHeight
  || !knowledge.browse.referenceHoverActive
  || !knowledge.browse.referenceFirstHopEdgesRemainVisibleOnHover
  || !knowledge.browse.referenceHoveredContextualEdgesVisible
  || !knowledge.browse.referenceUnrelatedContextualEdgesHidden
  || knowledge.browse.referenceFocusPreviewTitle !== knowledge.browse.referenceTwoHopTitle
  || !knowledge.browse.referenceFocusActive
  || !knowledge.browse.referenceKeyboardDisclosure
  || !knowledge.browse.referenceViewportScrollbarGutter?.includes('stable')
  || !knowledge.browse.referenceLayoutStableAcrossOverflow
) {
  throw new Error('Knowledge graph hierarchy, stability, or in-graph excerpt preview is visually invalid')
}
if (
  knowledge.browse.listOverflowY !== 'auto'
  || knowledge.browse.detailOverflowY !== 'auto'
  || knowledge.browse.listOverscrollY !== 'contain'
  || knowledge.browse.detailOverscrollY !== 'contain'
  || !knowledge.browse.listScrollable
  || !knowledge.browse.detailScrollable
  || !knowledge.browse.listScrollIsolated
  || !knowledge.browse.detailScrollIsolated
  || !knowledge.browse.browserWithinViewport
) {
  throw new Error('Knowledge Statement list and detail do not scroll independently within the viewport')
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
if (!knowledge.clear.result?.includes('已清空 4 条知识')) {
  throw new Error('The knowledge browser does not report the completed reset')
}

if (semantics.ai.agent.title !== 'AI 后端') throw new Error('AI backend page was not rendered')
if (!semantics.ai.agent.nestedInSettings) throw new Error('AI backend is not contained by the Settings page')
if (semantics.ai.agent.backendKind !== 'coding_plan') throw new Error('Coding Plan is not the default backend')
if (semantics.ai.agent.provider !== 'openai_codex') throw new Error('OpenAI Codex is not selected for the Coding Plan backend')
if (semantics.ai.agent.codexCards !== 1) throw new Error('Codex runtime card is missing')
if (semantics.ai.agent.codingPlanModel !== 'fixture-codex-small') throw new Error('Coding Plan test model is not explicit')
if (semantics.ai.agent.codingPlanReasoning !== '') throw new Error('Coding Plan fixture should use the model-default reasoning effort')
if (!semantics.ai.agent.codingPlanConfiguration?.includes('Fixture Codex Small')) throw new Error('Coding Plan test configuration is not visible')
if (
  semantics.ai.agent.defaultLlmConnection !== 'model:fixture'
  || semantics.ai.agent.defaultLlmModel !== 'fixture-model'
  || !semantics.ai.agent.defaultLlmSummary?.includes('Fixture Model')
) {
  throw new Error('The AI backend page does not expose the application default LLM')
}
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
if (!semantics.ai.directTest.builderWasCollapsed) {
  throw new Error('AI backend configuration is not collapsed by default')
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
  throw new Error('Agent configuration page does not list the registered Agents')
}
if (!agentConfiguration.nestedInSettings) throw new Error('Agent configuration is not contained by the Settings page')
if (
  agentConfiguration.maintenanceToolNames?.join(',')
    !== 'read,bash,edit,write'
) {
  throw new Error('The Agent tool catalog does not match the Knowledge Maintenance runtime')
}
if (!agentConfiguration.toolsReadOnlyCopy?.includes('只读展示')) {
  throw new Error('The Agent configuration page does not explain that tools are code-owned')
}
if (agentConfiguration.schemaPanelCount !== 4 || agentConfiguration.expandedSchemaCount !== 1) {
  throw new Error('The Agent tool parameter schemas are not available through expandable panels')
}
const readToolSchema = agentConfiguration.readToolSchema
if (
  readToolSchema?.type !== 'object'
  || !readToolSchema.required?.includes('path')
  || readToolSchema.properties?.path?.type !== 'string'
) {
  throw new Error('The ordinary read developer schema lost required fields or constraints')
}
if (
  agentConfiguration.reviewerToolNames?.join(',') !== 'read,bash,edit,write'
  || agentConfiguration.reviewerSchemaPanelCount !== 4
  || agentConfiguration.reviewerToolNames.some((name) => name.includes('todo') || name.includes('evidence'))
) {
  throw new Error('The Reviewer tool catalog is not restricted to coding tools')
}
if (
  !agentConfiguration.builtInPrompt?.includes('Knowledge Maintainer')
  || agentConfiguration.configuredBadge !== 'Configured default'
  || !agentConfiguration.saveNotice?.includes('已保存')
  || !agentConfiguration.processingPromptUsesConfiguredDefault
) {
  throw new Error('A configured default System Prompt does not flow into knowledge processing')
}
if (agentConfiguration.restoredBadge !== 'Built-in default' || !agentConfiguration.restoredMatchesBuiltIn) {
  throw new Error('The configured default System Prompt cannot be restored to the code default')
}
if (!agentConfiguration.chatRoleText?.includes('通用 Agent')) {
  throw new Error('The general Agent is missing from Agent configuration')
}
if (
  agentConfiguration.chatToolNames?.join(',')
    !== 'read,bash,edit,write,spawn_agent,add_todos,complete_todos,list_todos'
  || agentConfiguration.chatSchemaPanelCount !== 8
) {
  throw new Error('The conversational Agent tool catalog is incomplete')
}
if (
  agentConfiguration.chatSpawnSchema?.type !== 'object'
  || !agentConfiguration.chatSpawnSchema?.required?.includes('instruction')
) {
  throw new Error('The conversational Agent delegation schema is not available to developers')
}
if (
  agentConfiguration.chatConfiguredBadge !== 'Configured default'
  || !agentConfiguration.chatRestoredMatchesBuiltIn
) {
  throw new Error('The conversational Agent default System Prompt cannot be configured and restored')
}
if (agentConfiguration.overflowX) throw new Error('Agent configuration page has unexpected horizontal overflow')

const chat = semantics.chat
if (chat?.title !== '对话' || chat.conversationCount !== 1) {
  throw new Error('The conversational Agent page did not create a persistent Chat Conversation')
}
if (!chat.selectedModel || !chat.binding?.includes(chat.selectedModel)) {
  throw new Error('The conversational Agent did not expose its frozen model binding')
}
if (!chat.userText?.includes('使用知识库') || !chat.assistantText?.includes('Fixture 对话 Agent')) {
  throw new Error(`The conversational Agent did not complete a real fixture turn: ${chat.pageError || 'no response'}`)
}
if (!chat.assistantStrongText?.includes('Fixture 对话 Agent') || chat.assistantListItems !== 2) {
  throw new Error('The conversational Agent response was not rendered as Markdown')
}
if (!chat.composerVisible || !chat.workspaceWithinViewport || chat.overflowX) {
  throw new Error('The conversational workspace does not remain within the viewport')
}
if (
  chat.documentScrollY !== 0
  || chat.conversationOverflowY !== 'auto'
  || chat.messagesOverflowY !== 'auto'
) {
  throw new Error('Chat panes do not own their independent scrolling')
}
if (
  chat.invocationViewCount !== 1
  || !chat.modelCallAction
  || !chat.modelCallInspector
  || !chat.modelCallContext?.includes('请简要介绍你能如何使用知识库')
) {
  throw new Error('The conversational page does not use the shared Agent Invocation visualization')
}
if (chat.overflowWithInspector) {
  throw new Error('The conversational Model Call inspector causes horizontal overflow')
}
if (chat.inspectorRole !== 'complementary' || chat.inspectorModal) {
  throw new Error('Model Call details must use a non-modal contextual inspector')
}
if (
  chat.inspectorPosition !== 'fixed'
  || !chat.inspectorWithinViewport
  || !chat.messageHeightStable
) {
  throw new Error('The conversational Model Call inspector is not a viewport-contained overlay')
}
if (
  Number.parseFloat(chat.timelineGap) > 7
  || chat.messageFontSize !== '13px'
  || Number.parseFloat(chat.messageLineHeight) > 21
  || Number.parseFloat(chat.messagePaddingTop) > 16
) {
  throw new Error('The conversational timeline does not use the compact information density')
}

const processing = semantics.processing
if (processing.title !== '加工测试') throw new Error('Knowledge processing page was not rendered')
if (processing.knowledgeTask.knowledgeTaskSelected !== 'true' || !processing.knowledgeTask.worktreeExists) {
  throw new Error('Knowledge Processing Task is not the default knowledge processing view')
}
if (processing.knowledgeTask.sourceConversationOptionCount !== 2) {
  throw new Error(`Expected one available fixture Source Conversation, got ${processing.knowledgeTask.sourceConversationOptionCount - 1}`)
}
if (!processing.knowledgeTask.refreshSourceConversationsButtonExists) {
  throw new Error('The Source Conversation selector does not expose local catalog refresh')
}
if (!processing.knowledgeTask.knowledgeTaskButtonExists || processing.knowledgeTask.knowledgeTaskButtonDisabled !== true) {
  throw new Error('Knowledge Task action must wait for an explicit Source Conversation selection')
}
if (!processing.knowledgeTask.initialDisabledReason?.includes('选择一个 Source Conversation')) {
  throw new Error('Knowledge Task view does not explain why the action is initially disabled')
}
if (!processing.knowledgeTask.selectedSourceConversation || processing.knowledgeTask.knowledgeTaskButtonEnabledAfterSelection !== true) {
  throw new Error('A complete Knowledge Agent configuration must become usable after selecting a Source Conversation')
}
const selectedSourceConversationDetails = processing.knowledgeTask.selectedSourceConversationDetails
if (selectedSourceConversationDetails?.title !== '知识加工 Git 协作设计讨论') {
  throw new Error('The selected Source Conversation title is not visible in the Knowledge Task details')
}
if (!selectedSourceConversationDetails?.timeRange?.includes('→')) {
  throw new Error('The selected Source Conversation time range is not visible in the Knowledge Task details')
}
if (!selectedSourceConversationDetails?.size?.match(/\d+(\.\d+)? (B|KB|MB|GB)/)) {
  throw new Error(`Expected readable Source Conversation size, got ${selectedSourceConversationDetails?.size || 'no value'}`)
}
if (selectedSourceConversationDetails?.project !== '/Users/demo/projects/oyster') {
  throw new Error('The selected Source Conversation project is not visible in the Knowledge Task details')
}
if (!processing.knowledgeTask.readyReason?.includes('准备完成')) {
  throw new Error('Knowledge Task view does not report that the selected configuration is runnable')
}
for (const requiredCopy of ['Maintainer', 'Reviewer', 'API', 'OpenAI-compatible', 'Fixture Model', '模型默认']) {
  if (!processing.knowledgeTask.modelSummary?.includes(requiredCopy)) {
    throw new Error(`Knowledge Agent configuration is missing: ${requiredCopy}`)
  }
}
if (!processing.knowledgeTask.bodyText.includes('Git 协作测试')) {
  throw new Error('Git collaboration boundary is not visible in the knowledge-task view')
}
if (
  !processing.knowledgeTask.bodyText.includes('统一 Repository 中创建 Knowledge Processing Task')
  || !processing.knowledgeTask.bodyText.includes('不会合并到目标分支')
) {
  throw new Error('Knowledge Task view does not explain its unmerged Git boundary')
}
if (!processing.knowledgeTaskActivity?.inProgressStateVisible || !processing.knowledgeTaskActivity?.completed) {
  throw new Error(`Knowledge Processing Task did not complete without a native confirmation dialog: ${processing.knowledgeTaskActivity?.error || 'unknown error'}`)
}
if (
  !processing.knowledgeTaskActivity.liveUpdatePreservesTool
  || !processing.knowledgeTaskActivity.liveUpdateKeepsScroll
  || !processing.knowledgeTaskActivity.liveToolPayloadVisible
) {
  throw new Error('A live Agent Invocation update replaced the expanded Tool Call or moved its viewport')
}
if (processing.knowledgeTaskActivity.overviewHasActivityExplorer) {
  throw new Error('The Knowledge Task overview still renders unbounded Agent activity details')
}
if (processing.knowledgeTaskActivity.summaryStatementCount !== '6') {
  throw new Error('The knowledge-task overview does not expose compact result counts')
}
if (!processing.knowledgeTaskActivity.activityExplorerExists || processing.knowledgeTaskActivity.activityEventCount !== 2) {
  throw new Error('The activity inspector does not expose the shared Agent Invocation timeline')
}
if (
  !processing.knowledgeTaskActivity.invocationSelectorText?.includes('Maintainer')
  || !processing.knowledgeTaskActivity.invocationSelectorText?.includes('Reviewer')
  || processing.knowledgeTaskActivity.invocationSelectorText?.includes('knowledge_maintainer')
  || processing.knowledgeTaskActivity.invocationSelectorText?.includes('knowledge_reviewer')
  || processing.knowledgeTaskActivity.selectedAgentName !== 'Reviewer'
) {
  throw new Error('The live activity page does not distinguish Maintainer and Reviewer Invocations')
}
if (!processing.knowledgeTaskActivity.toolText?.includes('read') || !processing.knowledgeTaskActivity.toolOutput?.includes('Fixture read completed')) {
  throw new Error('The activity page does not expose Reviewer Tool Calls')
}
if (!processing.knowledgeTaskActivity.resultDetailExists || !processing.knowledgeTaskActivity.returnedToOverview) {
  throw new Error('The knowledge-task result detail is not a navigable secondary page')
}
if (processing.knowledgeTaskActivity.statementCount !== 6) {
  throw new Error('Knowledge Task result does not expose the complete candidate Knowledge tree')
}
if (
  !processing.knowledgeTaskActivity.collaborationLinkLabel
  || !processing.knowledgeTaskActivity.collaborationLinkPreview
  || processing.knowledgeTaskActivity.collaborationLinkedTitle === processing.knowledgeTaskActivity.collaborationInitialTitle
) {
  throw new Error('Collaboration result does not use the shared wikilink reader with hover previews')
}
if (
  !processing.knowledgeTaskActivity.collaborationBackAvailable
  || processing.knowledgeTaskActivity.collaborationTitleAfterBack !== processing.knowledgeTaskActivity.collaborationInitialTitle
  || processing.knowledgeTaskActivity.collaborationOverflowAfterBack
  || !processing.knowledgeTaskActivity.collaborationForwardAvailable
  || processing.knowledgeTaskActivity.collaborationTitleAfterForward !== processing.knowledgeTaskActivity.collaborationLinkedTitle
) {
  throw new Error('Collaboration Statement reader cannot navigate backward and forward')
}
if (
  !processing.knowledgeTaskActivity.gitResultText?.includes('Repository')
  || !processing.knowledgeTaskActivity.gitResultText?.includes('PROGRESS.md')
  || !processing.knowledgeTaskActivity.gitResultText?.includes('Task branch')
  || !processing.knowledgeTaskActivity.gitResultText?.includes('目标分支main（未合并）')
  || !processing.knowledgeTaskActivity.gitResultText?.includes('批准 revision')
  || processing.knowledgeTaskActivity.changedPathCount !== 10
) {
  throw new Error('The Knowledge Task result does not expose its Repository, Task worktree, revisions, and changed files')
}
if (/来源范围\s+L\d|Raw source|sourceRef|扫描版本/.test(processing.knowledgeTaskActivity.bodyText || '')) {
  throw new Error('The knowledge-task result exposes internal observation coordinates')
}
if (processing.history?.taskCount !== 1 || !processing.history.listText?.includes('知识加工 Git 协作设计讨论')) {
  throw new Error('The completed Knowledge Task was not added to persistent history')
}
if (/Fixture (?:raw evidence|Canonical Activity)|Tool call ·|sourceRef|L\d{6}/.test(processing.history.listText || '')) {
  throw new Error('The compact history list eagerly exposes Agent activity or evidence payloads')
}
if (!processing.history.resultDetailExists || !processing.history.sharedBrowserExists) {
  throw new Error('Historical results do not reuse the shared Statement browser')
}
if (
  processing.history.importButtonExists
  || processing.history.productionTitles?.length !== 0
) {
  throw new Error('The unmerged Task branch leaked candidate Knowledge into the user main checkout')
}
if (
  !processing.history.historyInitialTitle
  || processing.history.historyLinkedTitle === processing.history.historyInitialTitle
  || processing.history.historyTitleAfterBack !== processing.history.historyInitialTitle
) throw new Error('Historical Statement navigation does not preserve browser history')
if (processing.history.overflowAfterStatementBack) {
  throw new Error('Historical Statement navigation introduces horizontal overflow after going back')
}
if (
  !processing.history.activityDetailExists
  || processing.history.activityEventCount !== 4
  || !processing.history.activityText?.includes('Fixture read completed')
  || !processing.history.invocationSelectorText?.includes('Maintainer')
  || !processing.history.invocationSelectorText?.includes('Reviewer')
  || processing.history.invocationSelectorText?.includes('knowledge_maintainer')
  || processing.history.invocationSelectorText?.includes('knowledge_reviewer')
) {
  throw new Error('Historical Task details do not expose the persisted Agent Invocation')
}
if (
  !processing.history.toolExpansionKeepsScroll
  || !processing.history.toolPayloadVisible
  || !processing.history.toolIsUnboxed
) {
  throw new Error('Tool Call disclosure moves the history viewport or still uses a boxed card')
}
if (!processing.history.returnedToHistory) {
  throw new Error('Historical secondary pages do not return to the history list')
}
if (processing.knowledgeTask.bodyText.includes('已导入会话')) {
  throw new Error('Knowledge Task view still exposes the removed import model')
}
if (processing.knowledgeTask.overflowX) throw new Error('Knowledge Task view has unexpected horizontal overflow')
if (processing.agentDefinitionCount !== 1) throw new Error(`Expected 1 fixed Knowledge Agent, got ${processing.agentDefinitionCount}`)
if (processing.promptCount !== 1) throw new Error(`Expected 1 processing prompt editor, got ${processing.promptCount}`)
if (processing.promptValues.some((prompt) => typeof prompt !== 'string' || !prompt.trim())) {
  throw new Error('A processing default prompt is empty')
}
const [maintainerPrompt] = processing.promptValues
for (const requiredCopy of ['Knowledge Maintainer', 'BRIEF.md', 'inputs/README.md', 'Canonical Activity', 'ordinary evidence file', '[[canonical title]]', 'the Host owns branch creation', 'Do not delete PROGRESS.md']) {
  if (!maintainerPrompt.includes(requiredCopy)) {
    throw new Error(`Knowledge Maintenance Agent prompt is missing its responsibility: ${requiredCopy}`)
  }
}
if (processing.promptValues.some((prompt) => prompt.includes('Oyster'))) {
  throw new Error('A default processing prompt assumes product-specific context')
}
if (processing.badgeValues.length !== 1 || processing.badgeValues.some((badge) => badge !== 'Default')) {
  throw new Error('The Knowledge Agent must show the Default prompt badge in fixture mode')
}
const agentPreviewConfiguration = processing.configurationText.join('\n')
for (const requiredCopy of ['API', 'OpenAI-compatible', 'fixture-model', '模型默认', 'Pi Coding Agent SDK', 'AI 后端 · 默认 LLM']) {
  if (!agentPreviewConfiguration.includes(requiredCopy)) {
    throw new Error(`Agent Preview configuration is missing: ${requiredCopy}`)
  }
}
if (processing.maintainerSourceConversationOptionCount !== 2) {
  throw new Error(`Expected one available Source Conversation in Agent Preview, got ${processing.maintainerSourceConversationOptionCount - 1}`)
}
if (processing.bodyText.includes('已导入会话')) {
  throw new Error('Agent Preview still exposes the removed import model')
}
if (processing.maintainerSourceConversationValue !== processing.knowledgeTask.selectedSourceConversation) {
  throw new Error('Agent Preview did not preserve the Source Conversation selected in the Knowledge Task view')
}
if (!processing.maintainerButtonExists || processing.maintainerDisabled !== false) {
  throw new Error('Knowledge maintenance preview must be available with the preserved Source Conversation and configuration')
}
if (!processing.maintainerReadyReason?.includes('可以启动 Agent Preview')) {
  throw new Error('Agent Preview does not report that knowledge maintenance is ready')
}
if (processing.resultCount !== 0) throw new Error('Knowledge processing produced a candidate without an explicit Agent Preview')
if (processing.overflowX) throw new Error('Knowledge processing page has unexpected horizontal overflow')
if (processing.buttonCount !== processing.sharedButtonCount + processing.tabButtonCount + processing.taskStatementButtonCount) {
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
if (processing.agentPreviewActivity.panelCount !== 1) throw new Error('The Agent Preview Invocation panel must be rendered')
if (processing.agentPreviewActivity.agentName !== 'Maintainer') {
  throw new Error('The Agent Preview activity still uses the application name instead of Maintainer')
}
if (processing.agentPreviewActivity.maintenanceEventCount !== 4) {
  throw new Error(`Expected 4 Agent timeline items, got ${processing.agentPreviewActivity.maintenanceEventCount}`)
}
if (processing.agentPreviewActivity.modelCallAction) {
  throw new Error('The deterministic fixture unexpectedly fabricated a Model Call')
}
for (const requiredCopy of ['read', 'write', 'bash']) {
  if (!processing.agentPreviewActivity.bodyText.includes(requiredCopy)) {
    throw new Error(`Agent Preview activity is missing: ${requiredCopy}`)
  }
}
if (
  !processing.agentPreviewActivity.resultText?.includes('Repository')
  || !processing.agentPreviewActivity.resultText?.includes('Task record')
  || !processing.agentPreviewActivity.resultText?.includes('Task branch')
  || !processing.agentPreviewActivity.resultText?.includes('当前 revision')
  || !processing.agentPreviewActivity.resultText?.includes('未合并到 main')
) {
  throw new Error('Knowledge maintenance result does not expose the Git handoff state')
}
if (processing.agentPreviewActivity.overflowX) throw new Error('Agent Preview activity has unexpected horizontal overflow')
if (processing.stateAfterNavigation.selectedSourceConversation !== processing.knowledgeTask.selectedSourceConversation) {
  throw new Error('Knowledge processing Source Conversation selection was lost after navigating away and back')
}
if (processing.stateAfterNavigation.agentPreviewSelected !== 'true') {
  throw new Error('Knowledge processing workspace state was lost after navigating away and back')
}
const processingImage = await readFile(join(dirname(capturePath), 'knowledge-processing.png'))
if (processingImage.length === 0) throw new Error('Knowledge processing screenshot is empty')
const agentPreviewImage = await readFile(join(dirname(capturePath), 'knowledge-agent-preview.png'))
if (agentPreviewImage.length === 0) throw new Error('Knowledge processing agent-preview screenshot is empty')
const maintainerInvocationImage = await readFile(join(dirname(capturePath), 'knowledge-processing-maintainer-invocation.png'))
if (maintainerInvocationImage.length === 0) throw new Error('Maintainer Invocation screenshot is empty')
const knowledgeImage = await readFile(join(dirname(capturePath), 'knowledge.png'))
if (knowledgeImage.length === 0) throw new Error('Knowledge browser screenshot is empty')
const clearKnowledgeImage = await readFile(join(dirname(capturePath), 'knowledge-clear-confirmation.png'))
if (clearKnowledgeImage.length === 0) throw new Error('Clear-knowledge confirmation screenshot is empty')

console.log(`UI smoke test passed: ${capturePath}`)

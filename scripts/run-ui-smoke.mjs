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
if (semantics.ai.model.backendKind !== 'api') throw new Error('API backend choice did not update the form')
if (semantics.ai.model.provider !== 'openai') throw new Error('OpenAI is not the default Model provider')
if (semantics.ai.model.passwordFields !== 1) throw new Error('API Key password field is missing')
if (semantics.ai.model.passwordValues.some(Boolean)) throw new Error('The fixture exposed a stored API Key to the renderer')
if (semantics.ai.model.configuredModel !== 'fixture-model') throw new Error('API Connection test model is not explicit')
if (semantics.ai.model.configuredReasoning !== '') throw new Error('API fixture should use the model-default reasoning effort')
if (!semantics.ai.model.configuredSummary?.includes('fixture-model')) throw new Error('API Connection test configuration is not visible')
if (!semantics.ai.model.bodyText.includes('OpenAI-compatible')) throw new Error('Custom compatible provider choice is missing')

const processing = semantics.processing
if (processing.title !== '知识加工') throw new Error('Knowledge processing page was not rendered')
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
if (selectedSessionDetails?.messageCount !== '3 条') {
  throw new Error(`Expected 3 fixture messages, got ${selectedSessionDetails?.messageCount || 'no value'}`)
}
if (selectedSessionDetails?.project !== '/Users/demo/projects/oyster') {
  throw new Error('The selected Session project is not visible in the full-chain details')
}
if (!processing.fullChain.readyReason?.includes('配置完整')) {
  throw new Error('Full-chain view does not report that the selected configuration is runnable')
}
if (processing.fullChain.stageConfigurations.length !== 2) {
  throw new Error('Full-chain view must show the exact configuration of both stages')
}
const fullChainConfiguration = processing.fullChain.stageConfigurations.join('\n')
for (const requiredCopy of ['API', 'OpenAI-compatible', 'fixture-model', '模型默认', '可用']) {
  if (!fullChainConfiguration.includes(requiredCopy)) {
    throw new Error(`Full-chain stage configuration is missing: ${requiredCopy}`)
  }
}
if (!processing.fullChain.bodyText.includes('Knowledge Sandbox')) {
  throw new Error('Knowledge Sandbox boundary is not visible in the full-chain view')
}
if (!processing.fullChain.bodyText.includes('运行时从 Agent 的原始位置读取内容')) {
  throw new Error('Full-chain view does not explain on-demand Session reading')
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
for (const requiredCopy of ['Observation Preprocessor', 'Evidence Map', 'primary language of the original material']) {
  if (!preprocessorPrompt.includes(requiredCopy)) {
    throw new Error(`Observation Preprocessor prompt is missing its responsibility: ${requiredCopy}`)
  }
}
for (const requiredCopy of ['Knowledge Maintenance Agent', 'Knowledge Statements are immutable', 'primary language of the original observation', 'submit_knowledge_contribution']) {
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
if (processing.buttonCount !== processing.sharedButtonCount + processing.tabButtonCount + processing.sourceSwitchButtonCount) {
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
if (!processing.trace.preprocessingOutput?.includes('# Evidence Map')) {
  throw new Error('The preprocessing model output is not visible in the debug trace')
}
if (processing.trace.maintenanceEventCount !== 3) {
  throw new Error(`Expected 3 safe maintenance trace events, got ${processing.trace.maintenanceEventCount}`)
}
for (const requiredCopy of ['模型输出可能复述原始材料', '模型轮次 1', '读取原始观察证据', '提交 Knowledge Contribution']) {
  if (!processing.trace.bodyText.includes(requiredCopy)) {
    throw new Error(`Knowledge processing trace is missing: ${requiredCopy}`)
  }
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

console.log(`UI smoke test passed: ${capturePath}`)

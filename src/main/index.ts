import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { discoveryChannels } from '../shared/channels'
import type { DiscoverySnapshot } from '../shared/discovery'
import { AiBackendService } from './ai-backends/ai-backend-service'
import { CodexAgentAdapter } from './ai-backends/codex-adapter'
import { KeychainCredentialStore } from './ai-backends/credential-store'
import { createFixtureAiBackendService } from './ai-backends/fixture'
import { registerAiBackendIpc } from './ai-backends/ipc'
import { OpenAiCompatibleAdapter } from './ai-backends/openai-compatible-adapter'
import { PiCodingPlanAdapter } from './ai-backends/pi-coding-plan-adapter'
import { PiKeychainCredentialStore } from './ai-backends/pi-credential-store'
import { JsonAiBackendRepository } from './ai-backends/repository'
import { createDefaultAdapters, createDetectionContext } from './discovery/adapters'
import { DiscoveryService } from './discovery/discovery-service'
import { nearestExistingDirectory } from './discovery/path-utils'
import {
  FileSourceEvidenceReader,
  MemorySourceEvidenceReader
} from './discovery/source-evidence-reader'
import { InMemoryDiscoveryRepository, JsonDiscoveryRepository } from './discovery/repository'
import {
  createFixtureState,
  FIXTURE_SESSION_ARTIFACT_ID,
  FIXTURE_SESSION_CONTENT
} from './fixture-state'
import {
  createFixtureKnowledgeProcessingService,
  FixtureKnowledgeAgentRuntime
} from './knowledge-processing/fixture'
import {
  KnowledgeFullChainService
} from './knowledge-processing/full-chain-service'
import { registerKnowledgeProcessingIpc } from './knowledge-processing/ipc'
import { SessionPreprocessor } from './knowledge-processing/session-preprocessor'
import { KnowledgeProcessingService } from './knowledge-processing/knowledge-processing-service'
import { PiKnowledgeMaintenanceAgent } from './knowledge-processing/pi-knowledge-agent'
import { JsonKnowledgeProcessingRepository } from './knowledge-processing/repository'
import { SqliteKnowledgeStoreManager } from './knowledge-store/knowledge-store-manager'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
let mainWindow: BrowserWindow | undefined
let aiBackendService: AiBackendService | undefined
let knowledgeProcessingService: KnowledgeProcessingService | undefined
let knowledgeFullChainService: KnowledgeFullChainService | undefined
let knowledgeStoreManager: SqliteKnowledgeStoreManager | undefined

function fixtureMode(): boolean {
  return process.env.OYSTER_FIXTURE_MODE === '1'
}

if (fixtureMode()) app.disableHardwareAcceleration()

function createService(): DiscoveryService {
  const useFixtures = fixtureMode()
  const fixtureState = useFixtures ? createFixtureState() : undefined
  const repository = useFixtures
    ? new InMemoryDiscoveryRepository(fixtureState!)
    : new JsonDiscoveryRepository(join(app.getPath('userData'), 'discovery-state.json'))
  const evidenceReader = useFixtures
    ? new MemorySourceEvidenceReader([{
        artifactId: FIXTURE_SESSION_ARTIFACT_ID,
        content: FIXTURE_SESSION_CONTENT
      }])
    : new FileSourceEvidenceReader()
  return new DiscoveryService(
    repository,
    evidenceReader,
    createDefaultAdapters(),
    createDetectionContext(app.getPath('home')),
    { recoverInterruptedRuns: !useFixtures }
  )
}

function createBackendService(): AiBackendService {
  if (fixtureMode()) return createFixtureAiBackendService()
  const credentials = new KeychainCredentialStore()
  return new AiBackendService(
    new JsonAiBackendRepository(join(app.getPath('userData'), 'ai-connections.json')),
    credentials,
    new CodexAgentAdapter(app.getPath('home')),
    new OpenAiCompatibleAdapter(),
    new PiCodingPlanAdapter({
      credentials: new PiKeychainCredentialStore(credentials),
      openExternal: async (url) => { await shell.openExternal(url) }
    })
  )
}

function createKnowledgeProcessingService(
  aiBackend: AiBackendService,
  stores: SqliteKnowledgeStoreManager
): KnowledgeProcessingService {
  if (fixtureMode()) return createFixtureKnowledgeProcessingService(aiBackend)
  return new KnowledgeProcessingService(
    new JsonKnowledgeProcessingRepository(join(app.getPath('userData'), 'knowledge-processing.json')),
    aiBackend,
    new PiKnowledgeMaintenanceAgent(stores.production)
  )
}

function registerIpc(service: DiscoveryService): void {
  ipcMain.handle(discoveryChannels.getSnapshot, () => service.snapshot())
  ipcMain.handle(discoveryChannels.listAvailableSessions, () => service.listAvailableSessions())
  ipcMain.handle(discoveryChannels.detectAgents, () => service.detectAgents())
  ipcMain.handle(discoveryChannels.scanSource, (_event, sourceId: string) => service.scanSource(sourceId))
  ipcMain.handle(discoveryChannels.cancelRun, (_event, runId: string) => service.cancelRun(runId))
  ipcMain.handle(discoveryChannels.chooseSourceRoot, async (_event, sourceId: string) => {
    const owner = BrowserWindow.getFocusedWindow() || mainWindow
    const source = service.snapshot().sources.find((candidate) => candidate.id === sourceId)
    const defaultPath = await nearestExistingDirectory(source?.rootPath || app.getPath('home'), app.getPath('home'))
    const result = await dialog.showOpenDialog(owner!, {
      title: '选择历史记录目录',
      defaultPath,
      properties: ['openDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return service.snapshot()
    return service.setSourceRoot(sourceId, result.filePaths[0])
  })

  service.subscribe((snapshot: DiscoverySnapshot) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(discoveryChannels.snapshot, snapshot)
    }
  })
}

async function captureFixture(window: BrowserWindow, capturePath: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 700))
  const image = await window.webContents.capturePage()
  await mkdir(dirname(capturePath), { recursive: true })
  await writeFile(capturePath, image.toPNG())
  const semantics = await window.webContents.executeJavaScript(`(() => {
    const page = document.querySelector('[data-testid="page-sources"]')
    const primaryButton = page.querySelector('.ui-button--primary')
    const primaryLabel = primaryButton.querySelector('.ui-button__label')
    const primaryBounds = primaryButton.getBoundingClientRect()
    const labelBounds = primaryLabel.getBoundingClientRect()
    return {
      title: page.querySelector('h1')?.textContent,
      sourceCards: page.querySelectorAll('[data-testid="source-card"]').length,
      dragRegion: getComputedStyle(document.querySelector('[data-testid="window-drag-region"]')).getPropertyValue('-webkit-app-region'),
      primaryButtonColor: getComputedStyle(primaryButton).backgroundColor,
      secondaryButtonColor: getComputedStyle(page.querySelector('.ui-button--secondary')).color,
      buttonLabelCenterDelta: Math.abs((primaryBounds.left + primaryBounds.width / 2) - (labelBounds.left + labelBounds.width / 2)),
      buttonCount: page.querySelectorAll('button').length,
      sharedButtonCount: page.querySelectorAll('.ui-button').length,
      buttonIconCount: Array.from(page.querySelectorAll('.ui-button')).filter((button) => button.querySelector('.ui-button__icon .ui-icon')?.childElementCount > 0).length,
      primaryActions: Array.from(page.querySelectorAll('button')).map((button) => button.textContent?.trim()),
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      bodyText: page.innerText
    }
  })()`)
  await window.webContents.executeJavaScript(`document.querySelector('[data-testid="nav-knowledge-processing"]').click()`)
  await new Promise((resolve) => setTimeout(resolve, 200))
  const processingImage = await window.webContents.capturePage()
  await writeFile(join(dirname(capturePath), 'knowledge-processing.png'), processingImage.toPNG())
  const fullChainSemantics = await window.webContents.executeJavaScript(`(() => {
    const page = document.querySelector('[data-testid="page-knowledge-processing"]')
    const select = page.querySelector('[data-testid="full-chain-session-select"]')
    const initialButton = page.querySelector('[data-testid="run-full-chain"]')
    const result = {
      fullChainSelected: page.querySelector('[data-testid="processing-view-full-chain"]')?.getAttribute('aria-selected'),
      workspaceExists: Boolean(page.querySelector('[data-testid="full-chain-workspace"]')),
      sessionOptionCount: select?.options.length,
      fullChainButtonExists: Boolean(initialButton),
      fullChainButtonDisabled: initialButton?.disabled,
      initialDisabledReason: page.querySelector('[data-testid="full-chain-disabled-reason"]')?.textContent?.trim(),
      stageConfigurations: Array.from(page.querySelectorAll('[data-testid^="full-chain-config-"]')).map((node) => node.textContent?.trim()),
      bodyText: page.innerText,
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth
    }
    if (select?.options[1]) {
      select.value = select.options[1].value
      select.dispatchEvent(new Event('change', { bubbles: true }))
    }
    return new Promise((resolve) => requestAnimationFrame(() => resolve({
      ...result,
      selectedSession: select?.value,
      selectedSessionDetails: {
        title: page.querySelector('[data-testid="full-chain-session-meta-title"]')?.textContent?.trim(),
        timeRange: page.querySelector('[data-testid="full-chain-session-meta-time-range"]')?.textContent?.trim(),
        size: page.querySelector('[data-testid="full-chain-session-meta-size"]')?.textContent?.trim(),
        project: page.querySelector('[data-testid="full-chain-session-meta-project"]')?.textContent?.trim()
      },
      fullChainButtonEnabledAfterSelection: page.querySelector('[data-testid="run-full-chain"]')?.disabled === false,
      readyReason: page.querySelector('[data-testid="full-chain-disabled-reason"]')?.textContent?.trim()
    })))
  })()`)
  const fullChainRunSemantics = await window.webContents.executeJavaScript(`(async () => {
    const page = document.querySelector('[data-testid="page-knowledge-processing"]')
    page.querySelector('[data-testid="run-full-chain"]')?.click()
    const deadline = Date.now() + 5_000
    let impactVisible = false
    while (Date.now() < deadline) {
      impactVisible ||= Boolean(page.querySelector('[data-testid="full-chain-running-impact"]'))
      const completed = Boolean(page.querySelector('[data-testid="full-chain-run-result"]'))
      const error = page.querySelector('.page-error')?.textContent?.trim()
      if (completed || error) return {
        completed,
        impactVisible,
        error,
        candidateCount: page.querySelectorAll('#full-chain-panel-result .statement-candidate').length,
        resolutionCount: page.querySelectorAll('#full-chain-panel-result .statement-candidate__resolution').length,
        statementCount: page.querySelectorAll('#full-chain-panel-result .sandbox-statement').length
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return { completed: false, impactVisible, error: 'Timed out waiting for full-chain result' }
  })()`)
  await window.webContents.executeJavaScript(`document.querySelector('[data-testid="processing-view-stage-debug"]').click()`)
  await new Promise((resolve) => setTimeout(resolve, 120))
  await window.webContents.executeJavaScript(`document.querySelector('[data-testid="processing-preprocessor-session"]')?.scrollIntoView({ block: 'center' })`)
  await new Promise((resolve) => setTimeout(resolve, 80))
  const stageDebugImage = await window.webContents.capturePage()
  await writeFile(join(dirname(capturePath), 'knowledge-processing-stage-debug.png'), stageDebugImage.toPNG())
  const processingSemantics = await window.webContents.executeJavaScript(`(() => {
    const page = document.querySelector('[data-testid="page-knowledge-processing"]')
    const prompts = Array.from(page.querySelectorAll('[data-testid^="processing-instructions-"]'))
    const badges = Array.from(page.querySelectorAll('[data-testid^="processing-prompt-badge-"]'))
    const connections = Array.from(page.querySelectorAll('[data-testid^="processing-connection-"]'))
    const models = Array.from(page.querySelectorAll('[data-testid^="processing-model-"]'))
    const reasoning = Array.from(page.querySelectorAll('[data-testid^="processing-reasoning-"]'))
    const buttons = Array.from(page.querySelectorAll('button'))
    return {
      title: page.querySelector('h1')?.textContent,
      stageCount: page.querySelectorAll('[data-testid="processing-stage-observation_preprocessor"], [data-testid="processing-stage-knowledge_maintenance_agent"]').length,
      promptCount: prompts.length,
      promptValues: prompts.map((prompt) => prompt.value),
      badgeValues: badges.map((badge) => badge.textContent?.trim()),
      connectionValues: connections.map((connection) => connection.value),
      modelValues: models.map((model) => model.value),
      reasoningValues: reasoning.map((effort) => effort.value),
      configurationText: Array.from(page.querySelectorAll('[data-testid^="processing-config-"]')).map((node) => node.textContent?.trim()),
      preprocessorSessionSourceSelected: page.querySelector('[data-testid="preprocessor-source-session"]')?.getAttribute('aria-pressed'),
      preprocessorSessionOptionCount: page.querySelector('[data-testid="processing-preprocessor-session"]')?.options.length,
      preprocessorSessionValue: page.querySelector('[data-testid="processing-preprocessor-session"]')?.value,
      preprocessorReadyReason: page.querySelector('[data-testid="preprocessor-disabled-reason"]')?.textContent?.trim(),
      manualObservationVisible: Boolean(page.querySelector('[data-testid="processing-observation-input"]')),
      preprocessorButtonExists: Boolean(page.querySelector('[data-testid="run-preprocessor"]')),
      preprocessorDisabled: page.querySelector('[data-testid="run-preprocessor"]')?.disabled,
      maintainerButtonExists: Boolean(page.querySelector('[data-testid="run-maintainer"]')),
      maintainerDisabled: page.querySelector('[data-testid="run-maintainer"]')?.disabled,
      resultCount: page.querySelectorAll('[data-testid^="processing-result-"]').length,
      buttonCount: buttons.length,
      sharedButtonCount: page.querySelectorAll('.ui-button').length,
      tabButtonCount: page.querySelectorAll('button[role="tab"]').length,
      sourceSwitchButtonCount: page.querySelectorAll('.processing-input-source button').length,
      statementButtonCount: page.querySelectorAll('.sandbox-statement').length,
      buttonIconCount: buttons.filter((button) => button.querySelector('.ui-button__icon .ui-icon')?.childElementCount > 0).length,
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      bodyText: page.innerText
    }
  })()`)
  const promptRestoreSemantics = await window.webContents.executeJavaScript(`(() => {
    const page = document.querySelector('[data-testid="page-knowledge-processing"]')
    const editor = page.querySelector('[data-testid="processing-instructions-observation_preprocessor"]')
    const badge = page.querySelector('[data-testid="processing-prompt-badge-observation_preprocessor"]')
    const restore = page.querySelector('[data-testid="restore-processing-instructions-observation_preprocessor"]')
    const original = editor.value
    editor.value = original + '\\n未保存的测试草稿'
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    return new Promise((resolve) => requestAnimationFrame(() => {
      const customizedBeforeRestore = badge.textContent?.trim()
      restore.click()
      setTimeout(() => resolve({
        customizedBeforeRestore,
        restoredValue: editor.value,
        defaultAfterRestore: badge.textContent?.trim(),
        matchesOriginal: editor.value === original
      }), 120)
    }))
  })()`)
  const fixturePreprocessing = await knowledgeProcessingService!.runObservationPreprocessor({
    observation: FIXTURE_SESSION_CONTENT,
    attention: '验证调试轨迹'
  })
  await knowledgeProcessingService!.runKnowledgeMaintenance({
    preprocessingRunId: fixturePreprocessing.runId
  })
  await new Promise((resolve) => setTimeout(resolve, 120))
  const traceSemantics = await window.webContents.executeJavaScript(`(() => {
    const page = document.querySelector('[data-testid="page-knowledge-processing"]')
    const stageTraces = Array.from(page.querySelectorAll('.processing-stage [data-testid="processing-debug-trace"]'))
    const calls = Array.from(page.querySelectorAll('.processing-stage [data-testid^="preprocessing-call-"]'))
    const workspace = page.querySelector('.processing-stage [data-testid="maintenance-workspace-status"]')
    if (calls[0]) calls[0].open = true
    calls[0]?.scrollIntoView({ block: 'center' })
    return {
      panelCount: stageTraces.length,
      preprocessingCallCount: calls.length,
      preprocessingOutput: calls[0]?.querySelector('pre')?.textContent,
      maintenanceEventCount: page.querySelectorAll('.processing-stage [data-testid^="maintenance-event-"]').length,
      workspaceValues: Array.from(workspace?.querySelectorAll('strong') ?? []).map((node) => node.textContent?.trim()),
      bodyText: page.innerText,
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth
    }
  })()`)
  await new Promise((resolve) => setTimeout(resolve, 80))
  const preprocessingTraceImage = await window.webContents.capturePage()
  await writeFile(
    join(dirname(capturePath), 'knowledge-processing-trace-preprocessing.png'),
    preprocessingTraceImage.toPNG()
  )
  await window.webContents.executeJavaScript(`document.querySelectorAll('.processing-stage [data-testid="processing-debug-trace"]')[1]?.scrollIntoView({ block: 'center' })`)
  await new Promise((resolve) => setTimeout(resolve, 80))
  const maintenanceTraceImage = await window.webContents.capturePage()
  await writeFile(
    join(dirname(capturePath), 'knowledge-processing-trace-maintenance.png'),
    maintenanceTraceImage.toPNG()
  )
  await window.webContents.executeJavaScript(`document.querySelector('[data-testid="nav-ai-backends"]').click()`)
  await new Promise((resolve) => setTimeout(resolve, 120))
  const aiImage = await window.webContents.capturePage()
  await writeFile(join(dirname(capturePath), 'ai-backends.png'), aiImage.toPNG())
  const aiDirectTestSemantics = await window.webContents.executeJavaScript(`(async () => {
    const page = document.querySelector('[data-testid="page-ai-backends"]')
    page.querySelector('[data-testid="coding-plan-test-button"]')?.click()
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const completed = Boolean(page.querySelector('[data-testid="connection-test-result"]'))
      const error = page.querySelector('.page-error')?.textContent?.trim()
      if (completed || error) return { completed, error }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return { completed: false, error: 'Timed out waiting for connection test result' }
  })()`)
  const aiSemantics = await window.webContents.executeJavaScript(`(() => {
    const page = document.querySelector('[data-testid="page-ai-backends"]')
    const agent = {
      title: page.querySelector('h1')?.textContent,
      backendKind: page.querySelector('[data-testid="backend-kind-select"]')?.value,
      provider: page.querySelector('[data-testid="provider-select"]')?.value,
      codexCards: page.querySelectorAll('[data-testid="codex-runtime-card"]').length,
      modelCards: page.querySelectorAll('[data-testid="model-connection-card"]').length,
      codingPlanModel: page.querySelector('[data-testid="coding-plan-model-select"]')?.value,
      codingPlanReasoning: page.querySelector('[data-testid="coding-plan-reasoning-select"]')?.value,
      codingPlanConfiguration: page.querySelector('[data-testid="coding-plan-test-configuration"]')?.textContent,
      bodyText: page.innerText,
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth
    }
    const backend = page.querySelector('[data-testid="backend-kind-select"]')
    backend.value = 'api'
    backend.dispatchEvent(new Event('change', { bubbles: true }))
    return new Promise((resolve) => requestAnimationFrame(() => resolve({
      agent,
      model: {
        backendKind: page.querySelector('[data-testid="backend-kind-select"]')?.value,
        provider: page.querySelector('[data-testid="provider-select"]')?.value,
        passwordFields: page.querySelectorAll('input[type="password"]').length,
        passwordValues: Array.from(page.querySelectorAll('input[type="password"]')).map((input) => input.value),
        configuredModel: page.querySelector('[data-testid="api-connection-model-select"]')?.value,
        configuredReasoning: page.querySelector('[data-testid="api-connection-reasoning-select"]')?.value,
        configuredSummary: page.querySelector('[data-testid="api-connection-test-configuration"]')?.textContent,
        bodyText: page.innerText
      }
    })))
  })()`)
  await window.webContents.executeJavaScript(`document.querySelector('[data-testid="nav-knowledge-processing"]').click()`)
  await new Promise((resolve) => setTimeout(resolve, 120))
  const processingStateAfterNavigation = await window.webContents.executeJavaScript(`(() => {
    const page = document.querySelector('[data-testid="page-knowledge-processing"]')
    return {
      selectedSession: page.querySelector('[data-testid="full-chain-session-select"]')?.value,
      stageDebugSelected: page.querySelector('[data-testid="processing-view-stage-debug"]')?.getAttribute('aria-selected')
    }
  })()`)
  await writeFile(
    `${capturePath}.json`,
    `${JSON.stringify({
      ...semantics,
      ai: { ...aiSemantics, directTest: aiDirectTestSemantics },
      processing: {
        fullChain: fullChainSemantics,
        fullChainRun: fullChainRunSemantics,
        ...processingSemantics,
        promptRestore: promptRestoreSemantics,
        trace: traceSemantics,
        stateAfterNavigation: processingStateAfterNavigation
      }
    }, null, 2)}\n`,
    'utf8'
  )
  app.quit()
}

async function createMainWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1160,
    height: 780,
    minWidth: 880,
    minHeight: 620,
    show: false,
    backgroundColor: '#fafafa',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: join(currentDirectory, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  mainWindow.once('ready-to-show', () => mainWindow?.show())

  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    await mainWindow.loadFile(join(currentDirectory, '../renderer/index.html'))
  }

  const capturePath = process.env.OYSTER_UI_CAPTURE_PATH
  if (capturePath) {
    // A hidden macOS window can leave Electron's capturePage promise pending forever.
    mainWindow.show()
    await captureFixture(mainWindow, capturePath)
  }
}

app.whenReady().then(async () => {
  const service = createService()
  aiBackendService = createBackendService()
  knowledgeStoreManager = await SqliteKnowledgeStoreManager.open(
    join(app.getPath('userData'), 'knowledge-store')
  )
  for (const sandbox of await knowledgeStoreManager.listSandboxes()) {
    await knowledgeStoreManager.discardSandbox(sandbox.id)
  }
  knowledgeProcessingService = createKnowledgeProcessingService(aiBackendService, knowledgeStoreManager)
  knowledgeFullChainService = new KnowledgeFullChainService(
    service,
    knowledgeProcessingService,
    knowledgeStoreManager,
    (reader) => fixtureMode()
      ? new FixtureKnowledgeAgentRuntime()
      : new PiKnowledgeMaintenanceAgent(reader)
  )
  await Promise.all([
    service.initialize(),
    aiBackendService.initialize(),
    knowledgeProcessingService.initialize()
  ])
  registerIpc(service)
  registerAiBackendIpc(aiBackendService, () => mainWindow)
  registerKnowledgeProcessingIpc(
    knowledgeProcessingService,
    new SessionPreprocessor(service, knowledgeProcessingService),
    knowledgeFullChainService,
    () => mainWindow
  )
  await createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createMainWindow()
  })
})

app.on('before-quit', () => {
  knowledgeFullChainService?.dispose()
  knowledgeProcessingService?.dispose()
  knowledgeStoreManager?.close()
  aiBackendService?.dispose()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { discoveryChannels } from '../shared/channels'
import { AGENT_TYPES, type DiscoverySnapshot } from '../shared/discovery'
import { createDefaultAdapters, createDetectionContext } from './discovery/adapters'
import { DiscoveryService } from './discovery/discovery-service'
import { nearestExistingDirectory } from './discovery/path-utils'
import {
  ensureRawEvidenceDirectories,
  FileRawEvidenceStore,
  MemoryRawEvidenceStore
} from './discovery/raw-evidence-store'
import { InMemoryDiscoveryRepository, JsonDiscoveryRepository } from './discovery/repository'
import { createFixtureState } from './fixture-state'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
let mainWindow: BrowserWindow | undefined

function rawEvidenceRootPath(): string {
  return join(app.getPath('userData'), 'raw-evidence')
}

function fixtureMode(): boolean {
  return process.env.OYSTER_FIXTURE_MODE === '1'
}

function createService(): DiscoveryService {
  const useFixtures = fixtureMode()
  const repository = useFixtures
    ? new InMemoryDiscoveryRepository(createFixtureState())
    : new JsonDiscoveryRepository(join(app.getPath('userData'), 'discovery-state.json'))
  const evidenceStore = useFixtures
    ? new MemoryRawEvidenceStore()
    : new FileRawEvidenceStore(rawEvidenceRootPath())
  return new DiscoveryService(
    repository,
    evidenceStore,
    createDefaultAdapters(),
    createDetectionContext(app.getPath('home')),
    { recoverInterruptedRuns: !useFixtures }
  )
}

function registerIpc(service: DiscoveryService): void {
  ipcMain.handle(discoveryChannels.getSnapshot, () => service.snapshot())
  ipcMain.handle(discoveryChannels.detectAgents, () => service.detectAgents())
  ipcMain.handle(discoveryChannels.scanSource, (_event, sourceId: string) => service.scanSource(sourceId))
  ipcMain.handle(discoveryChannels.importSource, (_event, sourceId: string) => service.importSource(sourceId))
  ipcMain.handle(discoveryChannels.cancelRun, (_event, runId: string) => service.cancelRun(runId))
  ipcMain.handle(discoveryChannels.openRawEvidenceDirectory, async () => {
    const rootPath = rawEvidenceRootPath()
    await ensureRawEvidenceDirectories(rootPath, AGENT_TYPES.map((agentType) => `source:${agentType}`))
    const error = await shell.openPath(rootPath)
    if (error) throw new Error(`无法打开导入目录：${error}`)
  })
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
    const primaryButton = document.querySelector('.ui-button--primary')
    const primaryLabel = primaryButton.querySelector('.ui-button__label')
    const primaryBounds = primaryButton.getBoundingClientRect()
    const labelBounds = primaryLabel.getBoundingClientRect()
    return {
      title: document.querySelector('h1')?.textContent,
      sourceCards: document.querySelectorAll('[data-testid="source-card"]').length,
      dragRegion: getComputedStyle(document.querySelector('[data-testid="window-drag-region"]')).getPropertyValue('-webkit-app-region'),
      primaryButtonColor: getComputedStyle(primaryButton).backgroundColor,
      secondaryButtonColor: getComputedStyle(document.querySelector('.ui-button--secondary')).color,
      buttonLabelCenterDelta: Math.abs((primaryBounds.left + primaryBounds.width / 2) - (labelBounds.left + labelBounds.width / 2)),
      buttonCount: document.querySelectorAll('button').length,
      sharedButtonCount: document.querySelectorAll('.ui-button').length,
      buttonIconCount: Array.from(document.querySelectorAll('.ui-button')).filter((button) => button.querySelector('.ui-button__icon .ui-icon')?.childElementCount > 0).length,
      primaryActions: Array.from(document.querySelectorAll('button')).map((button) => button.textContent?.trim()),
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      bodyText: document.body.innerText
    }
  })()`)
  await writeFile(`${capturePath}.json`, `${JSON.stringify(semantics, null, 2)}\n`, 'utf8')
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
  mainWindow.once('ready-to-show', () => mainWindow?.show())

  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    await mainWindow.loadFile(join(currentDirectory, '../renderer/index.html'))
  }

  const capturePath = process.env.OYSTER_UI_CAPTURE_PATH
  if (capturePath) await captureFixture(mainWindow, capturePath)
}

app.whenReady().then(async () => {
  if (!fixtureMode()) {
    await ensureRawEvidenceDirectories(
      rawEvidenceRootPath(),
      AGENT_TYPES.map((agentType) => `source:${agentType}`)
    )
  }
  const service = createService()
  await service.initialize()
  registerIpc(service)
  await createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { discoveryChannels } from '../shared/channels'
import type { DiscoverySnapshot } from '../shared/discovery'
import { createDefaultAdapters, createDetectionContext } from './discovery/adapters'
import { DiscoveryService } from './discovery/discovery-service'
import { nearestExistingDirectory } from './discovery/path-utils'
import { FileRawEvidenceStore, MemoryRawEvidenceStore } from './discovery/raw-evidence-store'
import { InMemoryDiscoveryRepository, JsonDiscoveryRepository } from './discovery/repository'
import { createFixtureState } from './fixture-state'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
let mainWindow: BrowserWindow | undefined

function createService(): DiscoveryService {
  const fixtureMode = process.env.OYSTER_FIXTURE_MODE === '1'
  const repository = fixtureMode
    ? new InMemoryDiscoveryRepository(createFixtureState())
    : new JsonDiscoveryRepository(join(app.getPath('userData'), 'discovery-state.json'))
  const evidenceStore = fixtureMode
    ? new MemoryRawEvidenceStore()
    : new FileRawEvidenceStore(join(app.getPath('userData'), 'raw-evidence'))
  return new DiscoveryService(
    repository,
    evidenceStore,
    createDefaultAdapters(),
    createDetectionContext(app.getPath('home')),
    { recoverInterruptedRuns: !fixtureMode }
  )
}

function registerIpc(service: DiscoveryService): void {
  ipcMain.handle(discoveryChannels.getSnapshot, () => service.snapshot())
  ipcMain.handle(discoveryChannels.detectAgents, () => service.detectAgents())
  ipcMain.handle(discoveryChannels.scanSource, (_event, sourceId: string) => service.scanSource(sourceId))
  ipcMain.handle(discoveryChannels.importSource, (_event, sourceId: string) => service.importSource(sourceId))
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
  const semantics = await window.webContents.executeJavaScript(`(() => ({
    title: document.querySelector('h1')?.textContent,
    sourceCards: document.querySelectorAll('[data-testid="source-card"]').length,
    dragRegion: getComputedStyle(document.querySelector('[data-testid="window-drag-region"]')).getPropertyValue('-webkit-app-region'),
    primaryButtonColor: getComputedStyle(document.querySelector('.button--primary')).backgroundColor,
    buttonAlignment: getComputedStyle(document.querySelector('.button')).justifyContent,
    primaryActions: Array.from(document.querySelectorAll('button')).map((button) => button.textContent?.trim()),
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    bodyText: document.body.innerText
  }))()`)
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

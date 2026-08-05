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
  FIXTURE_SESSION_SOURCE_RECORD_ID,
  FIXTURE_SESSION_CONTENT
} from './fixture-state'
import {
  createFixtureKnowledgeProcessingService,
  FixtureKnowledgeAgentRuntime
} from './knowledge-processing/fixture'
import {
  KnowledgeFullChainService
} from './knowledge-processing/full-chain-service'
import { SqliteKnowledgeFullChainRunRepository } from './knowledge-processing/full-chain-run-repository'
import { registerKnowledgeProcessingIpc } from './knowledge-processing/ipc'
import { SessionPreprocessor } from './knowledge-processing/session-preprocessor'
import { KnowledgeProcessingService } from './knowledge-processing/knowledge-processing-service'
import { PiKnowledgeMaintenanceAgent } from './knowledge-processing/pi-knowledge-agent'
import { JsonKnowledgeProcessingRepository } from './knowledge-processing/repository'
import { SqliteKnowledgeStoreManager } from './knowledge-store/knowledge-store-manager'
import { registerKnowledgeIpc } from './knowledge-store/ipc'
import { ChatAgentService } from './chat/chat-agent-service'
import { JsonChatConfigurationRepository } from './chat/chat-configuration-repository'
import { registerChatIpc } from './chat/ipc'
import { PiChatSessionRepository } from './chat/pi-chat-session-repository'
import { ArtifactRepository } from './artifacts/artifact-repository'
import { registerArtifactIpc } from './artifacts/ipc'
import { registerSkillIpc } from './skills/ipc'
import { ManagedSkillService } from './skills/managed-skill-service'
import { SkillDiscoveryService } from './skills/skill-discovery-service'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
let mainWindow: BrowserWindow | undefined
let aiBackendService: AiBackendService | undefined
let knowledgeProcessingService: KnowledgeProcessingService | undefined
let knowledgeFullChainService: KnowledgeFullChainService | undefined
let knowledgeFullChainRunRepository: SqliteKnowledgeFullChainRunRepository | undefined
let knowledgeStoreManager: SqliteKnowledgeStoreManager | undefined
let chatAgentService: ChatAgentService | undefined
let chatSessionRepository: PiChatSessionRepository | undefined

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
        sourceRecordId: FIXTURE_SESSION_SOURCE_RECORD_ID,
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

function skillDiscoveryHomeDirectory(): string {
  return fixtureMode()
    ? join(app.getPath('userData'), 'skill-fixture-home')
    : app.getPath('home')
}

async function initializeFixtureSkills(homeDirectory: string): Promise<void> {
  const projectPath = join(homeDirectory, 'projects', 'oyster')
  const entries = [
    {
      path: join(homeDirectory, '.claude', 'skills', 'review', 'SKILL.md'),
      content: [
        '---',
        'name: review',
        'description: Review changes before delivery.',
        '---',
        '',
        '# Review',
        '',
        'Keep the change focused and verify the result.',
        '',
        '![remote preview](https://example.com/tracking.png)',
        ''
      ].join('\n')
    },
    {
      path: join(homeDirectory, '.pi', 'agent', 'skills', 'pi-helper', 'SKILL.md'),
      content: '---\nname: pi-helper\ndescription: Pi user Skill.\n---\n\n# Pi helper\n'
    },
    {
      path: join(projectPath, '.agents', 'skills', 'project-shared', 'SKILL.md'),
      content: '---\nname: project-shared\ndescription: Shared project Skill.\n---\n\n# Project shared\n'
    },
    {
      path: join(homeDirectory, '.codex', 'skills', '.system', 'system-helper', 'SKILL.md'),
      content: '---\nname: system-helper\ndescription: Codex system Skill.\n---\n\n# System helper\n'
    },
    {
      path: join(homeDirectory, 'etc', 'codex', 'skills', 'admin-policy', 'SKILL.md'),
      content: '---\nname: admin-policy\ndescription: Administrator Skill.\n---\n\n# Admin policy\n'
    }
  ]

  await mkdir(join(projectPath, '.git'), { recursive: true })
  await Promise.all(entries.map(async (entry) => {
    await mkdir(dirname(entry.path), { recursive: true })
    await writeFile(entry.path, entry.content, 'utf8')
  }))
}

function createSkillDiscoveryService(discovery: DiscoveryService): SkillDiscoveryService {
  const useFixtures = fixtureMode()
  const homeDirectory = skillDiscoveryHomeDirectory()
  const context = createDetectionContext(homeDirectory, useFixtures ? {} : process.env)
  const projectPaths = () => useFixtures
    ? [join(homeDirectory, 'projects', 'oyster')]
    : discovery.listAvailableSessions().flatMap((session) => (
        session.projectPath ? [session.projectPath] : []
      ))
  const adminRoot = useFixtures
    ? join(homeDirectory, 'etc', 'codex', 'skills')
    : undefined

  return new SkillDiscoveryService(context, projectPaths, adminRoot)
}

function createManagedSkillService(repository: ArtifactRepository): ManagedSkillService {
  const useFixtures = fixtureMode()
  const homeDirectory = skillDiscoveryHomeDirectory()
  const context = createDetectionContext(homeDirectory, useFixtures ? {} : process.env)
  return new ManagedSkillService(repository, context)
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
    const headingStyle = getComputedStyle(page.querySelector('h1'))
    const bodyStyle = getComputedStyle(document.body)
    const mutedTextStyle = getComputedStyle(page.querySelector('.source-card .path'))
    const sourceDetails = Array.from(page.querySelectorAll('.source-card__details'))
    const collapsedSourceDetails = sourceDetails.filter((details) => !details.open).length
    const sourceSummary = sourceDetails[0]?.querySelector('summary')?.textContent?.trim()
    const defaultBodyText = page.innerText
    if (sourceDetails[0]) sourceDetails[0].open = true
    return {
      title: page.querySelector('h1')?.textContent,
      sourceCards: page.querySelectorAll('[data-testid="source-card"]').length,
      dragRegion: getComputedStyle(document.querySelector('[data-testid="window-drag-region"]')).getPropertyValue('-webkit-app-region'),
      primaryButtonColor: getComputedStyle(primaryButton).backgroundColor,
      secondaryButtonColor: getComputedStyle(page.querySelector('.ui-button--secondary')).color,
      headingFontSize: headingStyle.fontSize,
      headingFontWeight: headingStyle.fontWeight,
      bodyFontSize: bodyStyle.fontSize,
      bodyFontWeight: bodyStyle.fontWeight,
      mutedTextColor: mutedTextStyle.color,
      buttonLabelCenterDelta: Math.abs((primaryBounds.left + primaryBounds.width / 2) - (labelBounds.left + labelBounds.width / 2)),
      buttonCount: page.querySelectorAll('button').length,
      sharedButtonCount: page.querySelectorAll('.ui-button').length,
      buttonIconCount: Array.from(page.querySelectorAll('.ui-button')).filter((button) => button.querySelector('.ui-button__icon .ui-icon')?.childElementCount > 0).length,
      primaryActions: Array.from(page.querySelectorAll('button')).map((button) => button.textContent?.trim()),
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      collapsedSourceDetails,
      sourceDetailCount: sourceDetails.length,
      sourceSummary,
      defaultBodyText,
      bodyText: page.innerText
    }
  })()`)

  window.setSize(1160, 680)
  await new Promise((resolve) => setTimeout(resolve, 80))
  await window.webContents.executeJavaScript(`document.querySelector('[data-testid="nav-skills"]').click()`)
  const skillSemantics = await window.webContents.executeJavaScript(`(async () => {
    const page = document.querySelector('[data-testid="page-skills"]')
    page.querySelector('[data-testid="skills-view-external"]')?.click()
    await new Promise((resolve) => requestAnimationFrame(resolve))
    const discover = page.querySelector('[data-testid="discover-skills"]')
    discover?.click()
    let deadline = Date.now() + 2_000
    while (
      (discover?.textContent?.includes('正在发现') || !page.querySelector('[data-testid="skill-document-preview"]'))
      && !page.querySelector('.page-error')
      && Date.now() < deadline
    ) await new Promise((resolve) => setTimeout(resolve, 25))

    const reviewPreviewHeading = page
      .querySelector('[data-testid="skill-document-preview"] h1')
      ?.textContent?.trim()
    const disabledImageText = page.querySelector('.markdown-image--disabled')?.textContent?.trim()
    const previewImageCount = page.querySelectorAll('[data-testid="skill-document-preview"] img').length
    const items = Array.from(page.querySelectorAll('[data-testid="skill-list-item"]'))
    const projectItem = items.find((item) => item.querySelector('.skill-scope--project'))
    projectItem?.click()
    deadline = Date.now() + 2_000
    while (
      (!page.querySelector('[data-testid="skill-project-path"]')
        || page.querySelector('[data-testid="open-skill-folder"]')?.disabled)
      && !page.querySelector('.page-error')
      && Date.now() < deadline
    ) await new Promise((resolve) => setTimeout(resolve, 25))

    const listScroll = page.querySelector('[data-testid="skill-list-scroll"]')
    const detailScroll = page.querySelector('[data-testid="skill-detail-scroll"]')
    const browser = page.querySelector('.skills-browser')?.getBoundingClientRect()

    return {
      title: page.querySelector('.page-header h1')?.textContent?.trim(),
      skillCount: items.length,
      skillNames: items.map((item) => item.querySelector('strong')?.textContent?.trim()),
      scopeLabels: items.map((item) => item.querySelector('.skill-scope')?.textContent?.trim()),
      reviewPreviewHeading,
      disabledImageText,
      previewImageCount,
      projectPath: page.querySelector('[data-testid="skill-project-path"]')?.textContent?.trim(),
      directoryPath: page.querySelector('[data-testid="skill-directory-path"]')?.textContent?.trim(),
      openFolderDisabled: page.querySelector('[data-testid="open-skill-folder"]')?.disabled,
      agentGroups: Array.from(page.querySelectorAll('[data-testid="skill-agent-group"]')).map((group) => ({
        agentType: group.getAttribute('data-agent-type'),
        name: group.querySelector('.skill-agent-group__header h3')?.textContent?.trim(),
        count: Number(group.querySelector('.skill-agent-group__header span')?.textContent)
      })),
      listOverflowY: listScroll ? getComputedStyle(listScroll).overflowY : undefined,
      listScrollable: Boolean(listScroll && listScroll.scrollHeight > listScroll.clientHeight),
      detailOverflowY: detailScroll ? getComputedStyle(detailScroll).overflowY : undefined,
      browserWithinViewport: Boolean(browser && browser.bottom <= window.innerHeight + 1),
      pageError: page.querySelector('.page-error')?.textContent?.trim(),
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth
    }
  })()`)
  await new Promise((resolve) => setTimeout(resolve, 80))
  const skillImage = await window.webContents.capturePage()
  await writeFile(join(dirname(capturePath), 'skills.png'), skillImage.toPNG())

  window.setSize(900, 780)
  await new Promise((resolve) => setTimeout(resolve, 80))
  await window.webContents.executeJavaScript(`document.querySelector('[data-testid="nav-knowledge"]').click()`)
  await window.webContents.executeJavaScript(`(async () => {
    const deadline = Date.now() + 2_000
    while (
      !document.querySelector('[data-testid="page-knowledge"] .knowledge-browser__item')
      && Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })()`)
  const knowledgeImage = await window.webContents.capturePage()
  await writeFile(join(dirname(capturePath), 'knowledge.png'), knowledgeImage.toPNG())
  const knowledgeBrowseSemantics = await window.webContents.executeJavaScript(`(async () => {
    const page = document.querySelector('[data-testid="page-knowledge"]')
    const oysterItem = Array.from(page.querySelectorAll('.knowledge-browser__item')).find(
      (item) => item.querySelector('strong')?.textContent?.trim() === 'Oyster 知识加工链路'
    )
    oysterItem?.click()
    let deadline = Date.now() + 2_000
    while (
      (page.querySelector('[data-testid="knowledge-statement-detail"] h2')?.textContent?.trim() !== 'Oyster 知识加工链路'
        || !page.querySelector('.knowledge-reference-explorer'))
      && Date.now() < deadline
    ) await new Promise((resolve) => setTimeout(resolve, 25))
    const referenceExplorer = page.querySelector('.knowledge-reference-explorer')
    const referenceViewport = referenceExplorer?.querySelector('.knowledge-local-graph__viewport')
    const referenceGraph = referenceExplorer?.querySelector('.knowledge-local-graph')
    const referenceDefaultNodes = Array.from(referenceGraph?.querySelectorAll('.knowledge-local-graph__node') ?? [])
    const referenceEdges = Array.from(referenceGraph?.querySelectorAll('.knowledge-local-graph__edge') ?? [])
    const referenceFirstHopEdges = referenceEdges.filter((edge) => edge.dataset.edgeTier === 'first-hop')
    const referenceContextualEdges = referenceEdges.filter((edge) => edge.dataset.edgeTier === 'contextual')
    const edgeOpacity = (edge) => Number.parseFloat(getComputedStyle(edge).opacity)
    const edgeStrokeWidth = (edge) => Number.parseFloat(getComputedStyle(edge).strokeWidth)
    const referenceDefaultFirstHopEdgesVisible = referenceFirstHopEdges.length > 0
      && referenceFirstHopEdges.every((edge) => edgeOpacity(edge) >= 0.6)
    const referenceDefaultContextualEdgesHidden = referenceContextualEdges.length > 0
      && referenceContextualEdges.every((edge) => edgeOpacity(edge) <= 0.01)
    const referenceFirstHopEdgesStronger = referenceFirstHopEdges.length > 0
      && referenceContextualEdges.length > 0
      && Math.min(...referenceFirstHopEdges.map(edgeStrokeWidth))
        > Math.max(...referenceContextualEdges.map(edgeStrokeWidth))
    const referenceSecondHopHiddenByDefault = referenceDefaultNodes.every(
      (node) => Number(node.dataset.distance) < 2
    )
    const referenceDisclosureNode = referenceDefaultNodes.find(
      (node) => Number(node.dataset.distance) === 1
    )
    const referenceExplorerHeightBeforeDisclosure = referenceExplorer?.getBoundingClientRect().height ?? 0
    referenceDisclosureNode?.dispatchEvent(new MouseEvent('mouseenter'))
    await new Promise((resolve) => setTimeout(resolve, 160))
    const referenceDisclosedNodes = Array.from(referenceGraph?.querySelectorAll('.knowledge-local-graph__node') ?? [])
    const referenceDisclosedTwoHopNode = referenceDisclosedNodes.find(
      (node) => node.getAttribute('aria-label')?.includes('距中心 2 跳')
    )
    const referenceTwoHopTitle = referenceDisclosedTwoHopNode?.dataset.title
    const referenceHasTwoHopNode = Boolean(referenceDisclosedTwoHopNode)
    const referenceSecondHopDisclosedFromFirstHop = referenceSecondHopHiddenByDefault
      && Boolean(referenceDisclosureNode && referenceDisclosedTwoHopNode)
    const referenceDisclosureKeepsHeight = Math.abs(
      (referenceExplorer?.getBoundingClientRect().height ?? 0) - referenceExplorerHeightBeforeDisclosure
    ) <= 1
    referenceDisclosedTwoHopNode?.dispatchEvent(new MouseEvent('mouseenter'))
    await new Promise((resolve) => setTimeout(resolve, 160))
    const referenceNodes = Array.from(referenceGraph?.querySelectorAll('.knowledge-local-graph__node') ?? [])
    const referenceTwoHopNode = referenceNodes.find((node) => node.dataset.title === referenceTwoHopTitle)
    const referenceNodeBackgrounds = referenceNodes.map((node) => getComputedStyle(node).backgroundColor)
    const referenceMarkerFree = !referenceGraph?.querySelector('.knowledge-local-graph__marker, circle, ellipse, marker')
      && referenceNodes.every((node) => [node, node.querySelector('.knowledge-local-graph__label')]
        .filter(Boolean)
        .every((element) => ['none', 'normal'].includes(getComputedStyle(element, '::before').content)
          && ['none', 'normal'].includes(getComputedStyle(element, '::after').content)))
      && referenceEdges.every((edge) => {
        const style = getComputedStyle(edge)
        return style.markerStart === 'none' && style.markerMid === 'none' && style.markerEnd === 'none'
      })
    const graphBounds = referenceGraph?.getBoundingClientRect()
    const referenceAnchors = referenceNodes.map((node) => ({
      x: Number.parseFloat(node.style.left),
      y: Number.parseFloat(node.style.top),
      width: node.getBoundingClientRect().width,
      height: node.getBoundingClientRect().height,
      title: node.dataset.title,
      distance: Number(node.dataset.distance)
    }))
    const referenceCenterAnchor = referenceAnchors.find((anchor) => anchor.distance === 0)
    const referenceRadius = (anchor) => referenceCenterAnchor
      ? Math.hypot(anchor.x - referenceCenterAnchor.x, anchor.y - referenceCenterAnchor.y)
      : 0
    const referenceFirstHopRadii = referenceAnchors
      .filter((anchor) => anchor.distance === 1)
      .map(referenceRadius)
    const referenceSecondHopRadii = referenceAnchors
      .filter((anchor) => anchor.distance >= 2)
      .map(referenceRadius)
    const referenceSecondHopPeripheral = referenceFirstHopRadii.length > 0
      && referenceSecondHopRadii.length > 0
      && Math.min(...referenceSecondHopRadii) > Math.max(...referenceFirstHopRadii)
    const referenceLabelsCentered = Boolean(graphBounds) && referenceNodes.every((node) => {
      const labelBounds = node.querySelector('.knowledge-local-graph__label')?.getBoundingClientRect()
      if (!labelBounds) return false
      const anchorX = graphBounds.left + Number.parseFloat(node.style.left)
      const anchorY = graphBounds.top + Number.parseFloat(node.style.top)
      return Math.hypot(
        labelBounds.left + labelBounds.width / 2 - anchorX,
        labelBounds.top + labelBounds.height / 2 - anchorY
      ) <= 1.5
    })
    const referenceNodesDoNotOverlap = referenceNodes.every((node, index) => {
      const bounds = node.getBoundingClientRect()
      return referenceNodes.slice(index + 1).every((other) => {
        const otherBounds = other.getBoundingClientRect()
        return bounds.right <= otherBounds.left
          || otherBounds.right <= bounds.left
          || bounds.bottom <= otherBounds.top
          || otherBounds.bottom <= bounds.top
      })
    })
    const distanceFromNodeBounds = (point, anchor) => {
      const deltaX = Math.max(0, Math.abs(point.x - anchor.x) - anchor.width / 2)
      const deltaY = Math.max(0, Math.abs(point.y - anchor.y) - anchor.height / 2)
      return Math.hypot(deltaX, deltaY)
    }
    const referenceEndpointsClipped = referenceEdges.every((edge) => {
      const source = referenceAnchors.find((anchor) => anchor.title === edge.dataset.sourceTitle)
      const target = referenceAnchors.find((anchor) => anchor.title === edge.dataset.targetTitle)
      const totalLength = edge.getTotalLength?.() ?? 0
      if (!source || !target || totalLength <= 0) return false
      const start = edge.getPointAtLength(0)
      const end = edge.getPointAtLength(totalLength)
      return distanceFromNodeBounds(start, source) <= 4
        && distanceFromNodeBounds(end, target) <= 4
        && Math.hypot(start.x - source.x, start.y - source.y) > 1
        && Math.hypot(end.x - target.x, end.y - target.y) > 1
    })
    const referenceEdgesAvoidText = referenceEdges.every((edge) => {
      const totalLength = edge.getTotalLength?.() ?? 0
      if (totalLength <= 0) return false
      const obstacles = referenceAnchors.filter((anchor) => (
        anchor.title !== edge.dataset.sourceTitle && anchor.title !== edge.dataset.targetTitle
      ))
      for (let index = 1; index < 48; index += 1) {
        const point = edge.getPointAtLength(totalLength * index / 48)
        if (obstacles.some((anchor) => (
          Math.abs(point.x - anchor.x) < anchor.width / 2 + 1
          && Math.abs(point.y - anchor.y) < anchor.height / 2 + 1
        ))) return false
      }
      return true
    })
    const referenceEdgesUsePaths = referenceEdges.every((edge) => (
      edge.tagName === 'path'
      && edge.getAttribute('d')?.startsWith('M ')
      && getComputedStyle(edge).fill === 'none'
    ))
    const referenceCurvedEdgeCount = referenceEdges.filter((edge) => edge.dataset.curved === 'true').length
    const referenceHasLineElement = Boolean(referenceGraph?.querySelector('line'))
    const referenceTwoHopFontSize = referenceTwoHopNode ? getComputedStyle(referenceTwoHopNode).fontSize : ''
    const referenceNodesAreTextButtons = referenceNodes.every((node) => (
      node.tagName === 'BUTTON'
      && node.tabIndex === 0
      && Boolean(node.querySelector('.knowledge-local-graph__label'))
    ))
    const referenceExplorerHeightBeforeHover = referenceExplorer?.getBoundingClientRect().height ?? 0
    referenceTwoHopNode?.dispatchEvent(new MouseEvent('mouseenter'))
    await new Promise((resolve) => setTimeout(resolve, 160))
    const referenceHoverPreview = referenceExplorer?.querySelector('.knowledge-local-graph__preview')
    const referenceHoverPreviewTitle = referenceHoverPreview?.querySelector('strong')?.textContent?.trim()
    const referenceHoverPreviewText = referenceHoverPreview?.querySelector('p')?.textContent?.trim()
    const referenceHoverActive = referenceTwoHopNode?.classList.contains('knowledge-local-graph__node--active')
    const referenceFirstHopEdgesRemainVisibleOnHover = referenceFirstHopEdges.every(
      (edge) => edgeOpacity(edge) >= 0.6
    )
    const hoveredContextualEdges = referenceContextualEdges.filter((edge) => (
      edge.dataset.sourceTitle === referenceTwoHopTitle || edge.dataset.targetTitle === referenceTwoHopTitle
    ))
    const unrelatedContextualEdges = referenceContextualEdges.filter((edge) => (
      edge.dataset.sourceTitle !== referenceTwoHopTitle && edge.dataset.targetTitle !== referenceTwoHopTitle
    ))
    const referenceHoveredContextualEdgesVisible = hoveredContextualEdges.length > 0
      && hoveredContextualEdges.every((edge) => edgeOpacity(edge) >= 0.5)
    const referenceUnrelatedContextualEdgesHidden = unrelatedContextualEdges.every(
      (edge) => edgeOpacity(edge) <= 0.01
    )
    const referenceHoverPreviewInsideGraph = Boolean(referenceHoverPreview && referenceGraph?.contains(referenceHoverPreview))
    const referenceHoverKeepsHeight = Math.abs(
      (referenceExplorer?.getBoundingClientRect().height ?? 0) - referenceExplorerHeightBeforeHover
    ) <= 1
    referenceViewport?.dispatchEvent(new MouseEvent('mouseleave'))
    referenceDisclosureNode?.focus()
    referenceDisclosureNode?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    await new Promise((resolve) => requestAnimationFrame(resolve))
    const referenceFocusedTwoHopNode = Array.from(
      referenceGraph?.querySelectorAll('.knowledge-local-graph__node') ?? []
    ).find((node) => node.dataset.title === referenceTwoHopTitle)
    referenceFocusedTwoHopNode?.focus()
    referenceFocusedTwoHopNode?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    await new Promise((resolve) => requestAnimationFrame(resolve))
    const referenceFocusPreviewTitle = referenceExplorer?.querySelector('.knowledge-local-graph__preview strong')?.textContent?.trim()
    const referenceFocusActive = document.activeElement === referenceFocusedTwoHopNode
    const referenceKeyboardDisclosure = Boolean(referenceDisclosureNode && referenceFocusedTwoHopNode)
    const referenceLayoutSignature = () => JSON.stringify({
      width: referenceViewport?.getAttribute('data-layout-width'),
      height: referenceViewport?.getAttribute('data-scene-height'),
      nodes: Array.from(referenceGraph?.querySelectorAll('.knowledge-local-graph__node') ?? []).map((node) => (
        [node.dataset.title, node.style.left, node.style.top]
      ))
    })
    const referenceLayoutBeforeOverflow = referenceLayoutSignature()
    const referenceViewportWidthBeforeOverflow = referenceViewport?.clientWidth ?? 0
    const referenceViewportScrollbarGutter = referenceViewport
      ? getComputedStyle(referenceViewport).scrollbarGutter
      : ''
    const referenceGraphOriginalHeight = referenceGraph?.style.height ?? ''
    if (referenceGraph) referenceGraph.style.height = '360px'
    await new Promise((resolve) => setTimeout(resolve, 100))
    const referenceLayoutDuringOverflow = referenceLayoutSignature()
    const referenceViewportWidthDuringOverflow = referenceViewport?.clientWidth ?? 0
    if (referenceGraph) referenceGraph.style.height = referenceGraphOriginalHeight
    await new Promise((resolve) => setTimeout(resolve, 100))
    const referenceLayoutAfterOverflow = referenceLayoutSignature()
    const referenceViewportWidthAfterOverflow = referenceViewport?.clientWidth ?? 0
    const referenceLayoutStableAcrossOverflow = referenceLayoutBeforeOverflow === referenceLayoutDuringOverflow
      && referenceLayoutBeforeOverflow === referenceLayoutAfterOverflow
      && Math.abs(referenceViewportWidthBeforeOverflow - referenceViewportWidthDuringOverflow) <= 1
      && Math.abs(referenceViewportWidthBeforeOverflow - referenceViewportWidthAfterOverflow) <= 1

    const listScroll = page.querySelector('[data-testid="knowledge-statement-list-scroll"]')
    const detailScroll = page.querySelector('[data-testid="knowledge-statement-detail-scroll"]')
    const listProbe = document.createElement('div')
    const detailProbe = document.createElement('div')
    listProbe.style.height = '1200px'
    detailProbe.style.height = '1200px'
    listProbe.setAttribute('aria-hidden', 'true')
    detailProbe.setAttribute('aria-hidden', 'true')
    listScroll?.append(listProbe)
    detailScroll?.append(detailProbe)
    if (listScroll) listScroll.scrollTop = 0
    if (detailScroll) detailScroll.scrollTop = 0
    const documentScrollStart = window.scrollY
    if (listScroll) listScroll.scrollTop = 240
    await new Promise((resolve) => requestAnimationFrame(resolve))
    const listScrollIsolated = (listScroll?.scrollTop ?? 0) > 0
      && (detailScroll?.scrollTop ?? 0) === 0
      && window.scrollY === documentScrollStart
    if (listScroll) listScroll.scrollTop = 0
    if (detailScroll) detailScroll.scrollTop = 240
    await new Promise((resolve) => requestAnimationFrame(resolve))
    const detailScrollIsolated = (detailScroll?.scrollTop ?? 0) > 0
      && (listScroll?.scrollTop ?? 0) === 0
      && window.scrollY === documentScrollStart
    const listScrollable = (listScroll?.scrollHeight ?? 0) > (listScroll?.clientHeight ?? 0)
    const detailScrollable = (detailScroll?.scrollHeight ?? 0) > (detailScroll?.clientHeight ?? 0)
    const listOverflowY = listScroll ? getComputedStyle(listScroll).overflowY : ''
    const detailOverflowY = detailScroll ? getComputedStyle(detailScroll).overflowY : ''
    const listOverscrollY = listScroll ? getComputedStyle(listScroll).overscrollBehaviorY : ''
    const detailOverscrollY = detailScroll ? getComputedStyle(detailScroll).overscrollBehaviorY : ''
    listProbe.remove()
    detailProbe.remove()
    if (listScroll) listScroll.scrollTop = 0
    if (detailScroll) detailScroll.scrollTop = 0
    const browserBounds = page.querySelector('.knowledge-browser')?.getBoundingClientRect()
    const browserWithinViewport = Boolean(browserBounds)
      && browserBounds.top >= 0
      && browserBounds.bottom <= window.innerHeight + 1
    referenceFocusedTwoHopNode?.click()
    deadline = Date.now() + 2_000
    while (
      page.querySelector('[data-testid="knowledge-statement-detail"] h2')?.textContent?.trim() !== referenceTwoHopTitle
      && Date.now() < deadline
    ) await new Promise((resolve) => setTimeout(resolve, 25))
    const referenceNodeNavigationTitle = page.querySelector('[data-testid="knowledge-statement-detail"] h2')?.textContent?.trim()
    page.querySelector('[data-testid="statement-nav-back"]')?.click()
    deadline = Date.now() + 2_000
    while (
      page.querySelector('[data-testid="knowledge-statement-detail"] h2')?.textContent?.trim() !== 'Oyster 知识加工链路'
      && Date.now() < deadline
    ) await new Promise((resolve) => setTimeout(resolve, 25))
    const link = page.querySelector('.knowledge-statement-link > a')
    link?.dispatchEvent(new MouseEvent('mouseenter'))
    deadline = Date.now() + 2_000
    while (
      document.querySelector('.knowledge-statement-preview > span')?.textContent?.includes('正在读取')
      && Date.now() < deadline
    ) await new Promise((resolve) => setTimeout(resolve, 25))
    const linkLabel = link?.textContent?.trim()
    const linkPreviewTitle = document.querySelector('.knowledge-statement-preview > strong')?.textContent?.trim()
    const linkPreview = document.querySelector('.knowledge-statement-preview > span')?.textContent?.trim()
    link?.click()
    deadline = Date.now() + 2_000
    while (
      page.querySelector('[data-testid="knowledge-statement-detail"] h2')?.textContent?.trim() !== 'Knowledge Maintenance Agent'
      && Date.now() < deadline
    ) await new Promise((resolve) => setTimeout(resolve, 25))
    const linkedTitle = page.querySelector('[data-testid="knowledge-statement-detail"] h2')?.textContent?.trim()
    const backButton = page.querySelector('[data-testid="statement-nav-back"]')
    const backAvailable = backButton?.disabled === false
    backButton?.click()
    deadline = Date.now() + 2_000
    while (
      page.querySelector('[data-testid="knowledge-statement-detail"] h2')?.textContent?.trim() !== 'Oyster 知识加工链路'
      && Date.now() < deadline
    ) await new Promise((resolve) => setTimeout(resolve, 25))
    const titleAfterBack = page.querySelector('[data-testid="knowledge-statement-detail"] h2')?.textContent?.trim()
    const overflowAfterBack = document.documentElement.scrollWidth > document.documentElement.clientWidth
    const forwardButton = page.querySelector('[data-testid="statement-nav-forward"]')
    const forwardAvailable = forwardButton?.disabled === false
    forwardButton?.click()
    deadline = Date.now() + 2_000
    while (
      page.querySelector('[data-testid="knowledge-statement-detail"] h2')?.textContent?.trim() !== 'Knowledge Maintenance Agent'
      && Date.now() < deadline
    ) await new Promise((resolve) => setTimeout(resolve, 25))
    const titleAfterForward = page.querySelector('[data-testid="knowledge-statement-detail"] h2')?.textContent?.trim()
    return {
      title: page.querySelector('h1')?.textContent?.trim(),
      statementCount: page.querySelectorAll('.knowledge-browser__item').length,
      selectedTitle: page.querySelector('.knowledge-browser__item[aria-selected="true"] strong')?.textContent?.trim(),
      detailTitle: page.querySelector('[data-testid="knowledge-statement-detail"] h2')?.textContent?.trim(),
      detailContent: page.querySelector('[data-testid="knowledge-statement-detail"]')?.textContent?.trim(),
      linkLabel,
      linkPreviewTitle,
      linkPreview,
      referenceExplorerExists: Boolean(referenceExplorer),
      referenceHasCanvas: Boolean(referenceExplorer?.querySelector('canvas')),
      referenceHasArrow: Boolean(referenceExplorer?.querySelector('marker')),
      referenceDefaultNodeCount: referenceDefaultNodes.length,
      referenceNodeCount: referenceNodes.length,
      referenceEdgeCount: referenceEdges.length,
      referenceFirstHopEdgeCount: referenceFirstHopEdges.length,
      referenceContextualEdgeCount: referenceContextualEdges.length,
      referenceDefaultFirstHopEdgesVisible,
      referenceDefaultContextualEdgesHidden,
      referenceFirstHopEdgesStronger,
      referenceClusterCount: Number(referenceGraph?.getAttribute('data-cluster-count')),
      referenceHasTwoHopNode,
      referenceTwoHopTitle,
      referenceSecondHopHiddenByDefault,
      referenceSecondHopDisclosedFromFirstHop,
      referenceDisclosureKeepsHeight,
      referenceNodeNavigationTitle,
      referenceNodesTransparent: referenceNodeBackgrounds.every((color) => color === 'rgba(0, 0, 0, 0)'),
      referenceSecondHopPeripheral,
      referenceMarkerFree,
      referenceLabelsCentered,
      referenceNodesDoNotOverlap,
      referenceEndpointsClipped,
      referenceEdgesAvoidText,
      referenceEdgesUsePaths,
      referenceCurvedEdgeCount,
      referenceHasLineElement,
      referenceNodesAreTextButtons,
      referenceHasIntroCopy: Boolean(referenceExplorer?.querySelector('.knowledge-reference-explorer__header'))
        || referenceExplorer?.textContent?.includes('局部引用图 ·')
        || referenceExplorer?.textContent?.includes('连线不区分方向'),
      referenceViewportHeight: referenceViewport?.getBoundingClientRect().height,
      referenceSceneHeight: Number(referenceViewport?.getAttribute('data-scene-height')),
      referenceTwoHopFontSize,
      referenceHoverPreviewTitle,
      referenceHoverPreviewText,
      referenceHoverPreviewInsideGraph,
      referenceHoverKeepsHeight,
      referenceHoverActive,
      referenceFirstHopEdgesRemainVisibleOnHover,
      referenceHoveredContextualEdgesVisible,
      referenceUnrelatedContextualEdgesHidden,
      referenceFocusPreviewTitle,
      referenceFocusActive,
      referenceKeyboardDisclosure,
      referenceViewportScrollbarGutter,
      referenceLayoutStableAcrossOverflow,
      listOverflowY,
      detailOverflowY,
      listOverscrollY,
      detailOverscrollY,
      listScrollable,
      detailScrollable,
      listScrollIsolated,
      detailScrollIsolated,
      browserWithinViewport,
      linkedTitle,
      backAvailable,
      titleAfterBack,
      overflowAfterBack,
      forwardAvailable,
      titleAfterForward,
      searchPlaceholder: page.querySelector('[data-testid="knowledge-search"]')?.getAttribute('placeholder'),
      clearButtonDisabled: page.querySelector('[data-testid="clear-knowledge"]')?.disabled,
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      bodyText: page.innerText
    }
  })()`)
  await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('[data-testid="page-knowledge"] [data-testid="clear-knowledge"]')?.click()
    const deadline = Date.now() + 2_000
    while (
      !document.querySelector('[data-testid="page-knowledge"] [data-testid="clear-knowledge-dialog"]')
      && Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  })()`)
  await new Promise((resolve) => setTimeout(resolve, 80))
  const clearKnowledgeImage = await window.webContents.capturePage()
  await writeFile(join(dirname(capturePath), 'knowledge-clear-confirmation.png'), clearKnowledgeImage.toPNG())
  const clearKnowledgeSemantics = await window.webContents.executeJavaScript(`(async () => {
    const page = document.querySelector('[data-testid="page-knowledge"]')
    const dialog = page.querySelector('[data-testid="clear-knowledge-dialog"]')
    const initial = {
      exists: Boolean(dialog),
      role: dialog?.querySelector('[role="alertdialog"]')?.getAttribute('role'),
      modal: dialog?.querySelector('[role="alertdialog"]')?.getAttribute('aria-modal'),
      title: dialog?.querySelector('h2')?.textContent?.trim(),
      description: dialog?.querySelector('p')?.textContent?.trim(),
      actions: Array.from(dialog?.querySelectorAll('button') ?? []).map((button) => button.textContent?.trim())
    }
    page.querySelector('[data-testid="cancel-clear-knowledge"]')?.click()
    await new Promise((resolve) => requestAnimationFrame(resolve))
    const cancelled = !page.querySelector('[data-testid="clear-knowledge-dialog"]')
    page.querySelector('[data-testid="clear-knowledge"]')?.click()
    await new Promise((resolve) => requestAnimationFrame(resolve))
    page.querySelector('[data-testid="confirm-clear-knowledge"]')?.click()
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      const result = page.querySelector('[data-testid="clear-knowledge-result"]')?.textContent?.trim()
      const error = page.querySelector('.page-error')?.textContent?.trim()
      if (result || error) return {
        ...initial,
        cancelled,
        completed: Boolean(result),
        result,
        error,
        statementCountAfterClear: page.querySelectorAll('.knowledge-browser__item').length,
        closedAfterCompletion: !page.querySelector('[data-testid="clear-knowledge-dialog"]')
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return { ...initial, cancelled, completed: false, error: 'Timed out clearing knowledge' }
  })()`)

  window.setSize(1160, 780)
  await new Promise((resolve) => setTimeout(resolve, 80))
  await window.webContents.executeJavaScript(`document.querySelector('[data-testid="nav-knowledge-processing"]').click()`)
  await window.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
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
      modelSummary: page.querySelector('.chain-test__models')?.textContent?.trim(),
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
    let runningStateVisible = false
    while (Date.now() < deadline) {
      runningStateVisible ||= !page.querySelector('[data-testid="run-full-chain"]')
      const completed = Boolean(page.querySelector('[data-testid="full-chain-run-result"]'))
      const error = page.querySelector('.page-error')?.textContent?.trim()
      if (completed || error) {
        if (error) return { completed, runningStateVisible, error }
        const overviewHasTraceExplorer = Boolean(page.querySelector('[data-testid="processing-trace-explorer"]'))
        const summaryStatementCount = page.querySelector('[data-testid="full-chain-result-statement-count"]')?.textContent?.trim()
        const summaryCandidateCount = page.querySelector('[data-testid="full-chain-result-candidate-count"]')?.textContent?.trim()
        page.querySelector('[data-testid="open-full-chain-activity"]')?.click()
        await new Promise((resolve) => requestAnimationFrame(resolve))
        const traceExplorerExists = Boolean(page.querySelector('[data-testid="processing-trace-explorer"]'))
        const traceEventCount = page.querySelectorAll('.trace-explorer-event').length
        page.querySelector('[data-testid="trace-explorer-event-maintenance-model-call-1"]')?.click()
        await new Promise((resolve) => requestAnimationFrame(resolve))
        const modelOutput = page.querySelector('[data-testid="trace-explorer-event-output"]')?.textContent
        page.querySelector('[data-testid="trace-explorer-event-maintenance-tool-call-1"]')?.click()
        await new Promise((resolve) => requestAnimationFrame(resolve))
        const toolInput = page.querySelector('[data-testid="trace-explorer-event-input"]')?.textContent
        const toolOutput = page.querySelector('[data-testid="trace-explorer-event-output"]')?.textContent
        page.querySelector('[data-testid="full-chain-detail-back"]')?.click()
        await new Promise((resolve) => requestAnimationFrame(resolve))
        page.querySelector('[data-testid="open-full-chain-result"]')?.click()
        await new Promise((resolve) => requestAnimationFrame(resolve))
        const resultDetailExists = Boolean(page.querySelector('[data-testid="full-chain-result-detail"]'))
        const candidateCount = page.querySelectorAll('[data-testid="statement-candidate-list"] .statement-candidate').length
        const todoCount = page.querySelectorAll('[data-testid="agent-todo-list"] .statement-candidate').length
        const completedTodoCount = page.querySelectorAll('[data-testid="agent-todo-list"] .statement-candidate--resolved').length
        const statementCount = page.querySelectorAll('.knowledge-browser--sandbox .knowledge-browser__item').length
        const sandboxLink = page.querySelector('.knowledge-browser--sandbox .knowledge-statement-link > a')
        sandboxLink?.dispatchEvent(new MouseEvent('mouseenter'))
        let linkDeadline = Date.now() + 2_000
        while (
          document.querySelector('.knowledge-statement-preview > span')?.textContent?.includes('正在读取')
          && Date.now() < linkDeadline
        ) await new Promise((resolve) => setTimeout(resolve, 25))
        const sandboxLinkLabel = sandboxLink?.textContent?.trim()
        const sandboxLinkPreview = document.querySelector('.knowledge-statement-preview')?.textContent?.trim()
        sandboxLink?.click()
        linkDeadline = Date.now() + 2_000
        while (
          page.querySelector('.knowledge-browser--sandbox [data-testid="knowledge-statement-detail"] h2')?.textContent?.trim() !== 'Knowledge Maintenance Agent'
          && Date.now() < linkDeadline
        ) await new Promise((resolve) => setTimeout(resolve, 25))
        const sandboxLinkedTitle = page.querySelector('.knowledge-browser--sandbox [data-testid="knowledge-statement-detail"] h2')?.textContent?.trim()
        const sandboxBack = page.querySelector('.knowledge-browser--sandbox [data-testid="statement-nav-back"]')
        const sandboxBackAvailable = sandboxBack?.disabled === false
        sandboxBack?.click()
        await new Promise((resolve) => requestAnimationFrame(resolve))
        const sandboxTitleAfterBack = page.querySelector('.knowledge-browser--sandbox [data-testid="knowledge-statement-detail"] h2')?.textContent?.trim()
        const sandboxOverflowAfterBack = document.documentElement.scrollWidth > document.documentElement.clientWidth
        const sandboxForward = page.querySelector('.knowledge-browser--sandbox [data-testid="statement-nav-forward"]')
        const sandboxForwardAvailable = sandboxForward?.disabled === false
        sandboxForward?.click()
        await new Promise((resolve) => requestAnimationFrame(resolve))
        const sandboxTitleAfterForward = page.querySelector('.knowledge-browser--sandbox [data-testid="knowledge-statement-detail"] h2')?.textContent?.trim()
        const bodyText = page.innerText
        page.querySelector('[data-testid="full-chain-result-back"]')?.click()
        await new Promise((resolve) => requestAnimationFrame(resolve))
        return {
          completed,
          runningStateVisible,
          overviewHasTraceExplorer,
          summaryStatementCount,
          summaryCandidateCount,
          traceExplorerExists,
          traceEventCount,
          modelOutput,
          toolInput,
          toolOutput,
          resultDetailExists,
          candidateCount,
          todoCount,
          completedTodoCount,
          statementCount,
          sandboxLinkLabel,
          sandboxLinkPreview,
          sandboxLinkedTitle,
          sandboxBackAvailable,
          sandboxTitleAfterBack,
          sandboxOverflowAfterBack,
          sandboxForwardAvailable,
          sandboxTitleAfterForward,
          returnedToOverview: Boolean(page.querySelector('[data-testid="full-chain-session-select"]')),
          bodyText
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return { completed: false, runningStateVisible, error: 'Timed out waiting for full-chain result' }
  })()`)
  const processingHistorySemantics = await window.webContents.executeJavaScript(`(async () => {
    const page = document.querySelector('[data-testid="page-knowledge-processing"]')
    page.querySelector('[data-testid="processing-view-history"]')?.click()
    let deadline = Date.now() + 2_000
    while (!page.querySelector('.processing-history-run') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const run = page.querySelector('.processing-history-run')
    const listText = page.querySelector('[data-testid="processing-run-history"]')?.innerText
    run?.querySelector('[data-testid^="open-history-result-"]')?.click()
    deadline = Date.now() + 2_000
    while (!page.querySelector('[data-testid="history-run-result-detail"]') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const resultDetailExists = Boolean(page.querySelector('[data-testid="history-run-result-detail"]'))
    const sharedBrowserExists = Boolean(page.querySelector('[data-testid="history-run-result-detail"] [data-testid="knowledge-statement-browser"]'))
    const importButton = page.querySelector('[data-testid="import-history-run"]')
    importButton?.click()
    deadline = Date.now() + 2_000
    while (!page.querySelector('[data-testid="full-chain-import-result"]') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const importNotice = page.querySelector('[data-testid="full-chain-import-result"]')?.textContent?.trim()
    const historyLink = page.querySelector('[data-testid="history-run-result-detail"] .knowledge-statement-link > a')
    historyLink?.click()
    deadline = Date.now() + 2_000
    while (
      page.querySelector('[data-testid="history-run-result-detail"] [data-testid="knowledge-statement-detail"] h2')?.textContent?.trim() !== 'Knowledge Maintenance Agent'
      && Date.now() < deadline
    ) await new Promise((resolve) => setTimeout(resolve, 25))
    page.querySelector('[data-testid="history-run-result-detail"] [data-testid="statement-nav-back"]')?.click()
    deadline = Date.now() + 2_000
    while (
      page.querySelector('[data-testid="history-run-result-detail"] [data-testid="knowledge-statement-detail"] h2')?.textContent?.trim() !== '知识加工链路'
      && Date.now() < deadline
    ) await new Promise((resolve) => setTimeout(resolve, 25))
    const overflowAfterStatementBack = document.documentElement.scrollWidth > document.documentElement.clientWidth
    page.querySelector('[data-testid="history-run-result-back"]')?.click()
    await new Promise((resolve) => requestAnimationFrame(resolve))
    page.querySelector('.processing-history-run [data-testid^="open-history-activity-"]')?.click()
    deadline = Date.now() + 2_000
    while (!page.querySelector('[data-testid="history-run-activity-detail"]') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const activityDetailExists = Boolean(page.querySelector('[data-testid="history-run-activity-detail"]'))
    const traceEventCount = page.querySelectorAll('[data-testid="history-run-activity-detail"] .trace-explorer-event').length
    const traceText = page.querySelector('[data-testid="history-run-activity-detail"]')?.textContent
    page.querySelector('[data-testid="history-run-activity-back"]')?.click()
    await new Promise((resolve) => requestAnimationFrame(resolve))
    return {
      runCount: page.querySelectorAll('.processing-history-run').length,
      listText,
      resultDetailExists,
      sharedBrowserExists,
      importButtonExists: Boolean(importButton),
      importNotice,
      overflowAfterStatementBack,
      activityDetailExists,
      traceEventCount,
      traceText,
      returnedToHistory: Boolean(page.querySelector('.processing-history__list'))
    }
  })()`)
  const productionTitlesAfterHistoryImport = knowledgeStoreManager?.production
    .listStatements()
    .map((statement) => statement.title)
    .sort()
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
      chainStatementButtonCount: page.querySelectorAll('.knowledge-browser--sandbox .knowledge-browser__item').length,
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
    const builder = page.querySelector('.ai-builder')
    const builderWasCollapsed = Boolean(builder && !builder.open)
    if (builder) builder.open = true
    await new Promise((resolve) => requestAnimationFrame(resolve))
    page.querySelector('[data-testid="coding-plan-test-button"]')?.click()
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const completed = Boolean(page.querySelector('[data-testid="connection-test-result"]'))
      const error = page.querySelector('.page-error')?.textContent?.trim()
      if (completed || error) return { completed, error, builderWasCollapsed }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return { completed: false, error: 'Timed out waiting for connection test result', builderWasCollapsed }
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
  await window.webContents.executeJavaScript(`document.querySelector('[data-testid="nav-agent-configuration"]').click()`)
  await window.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  await new Promise((resolve) => setTimeout(resolve, 120))
  const agentConfigurationImage = await window.webContents.capturePage()
  await writeFile(join(dirname(capturePath), 'agent-configuration.png'), agentConfigurationImage.toPNG())
  const agentConfigurationSemantics = await window.webContents.executeJavaScript(`(async () => {
    const page = document.querySelector('[data-testid="page-agent-configuration"]')
    let deadline = Date.now() + 2_000
    while (page.querySelectorAll('.agent-config-role').length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const title = page.querySelector('h1')?.textContent?.trim()
    const roleCount = page.querySelectorAll('.agent-config-role').length
    const preprocessorRolePresent = Boolean(
      page.querySelector('[data-testid="agent-config-role-observation_preprocessor"]')
    )

    page.querySelector('[data-testid="agent-config-role-knowledge_maintenance_agent"]')?.click()
    await new Promise((resolve) => requestAnimationFrame(resolve))
    page.querySelector('[data-testid="agent-config-tab-tools"]')?.click()
    await new Promise((resolve) => requestAnimationFrame(resolve))
    const maintenanceToolNames = Array.from(page.querySelectorAll('.agent-config-tool code'))
      .map((node) => node.textContent?.trim())
    const toolsReadOnlyCopy = page.querySelector('[data-testid="agent-config-tools-panel"]')?.textContent?.trim()
    const schemaPanelCount = page.querySelectorAll('.agent-config-tool__schema').length
    const searchSchemaDetails = page.querySelector('[data-testid="agent-tool-schema-search_knowledge"]')
    const addTodosSchemaDetails = page.querySelector('[data-testid="agent-tool-schema-add_todos"]')
    searchSchemaDetails.open = true
    addTodosSchemaDetails.open = true
    await new Promise((resolve) => requestAnimationFrame(resolve))
    const searchToolSchema = JSON.parse(searchSchemaDetails.querySelector('pre')?.textContent || '{}')
    const addTodosToolSchema = JSON.parse(addTodosSchemaDetails.querySelector('pre')?.textContent || '{}')
    const expandedSchemaCount = page.querySelectorAll('.agent-config-tool__schema[open]').length

    page.querySelector('[data-testid="agent-config-tab-prompt"]')?.click()
    await new Promise((resolve) => requestAnimationFrame(resolve))
    const editor = page.querySelector('[data-testid="agent-default-prompt-editor"]')
    const builtInPrompt = editor?.value
    const marker = '\\nConfigured default from Agent configuration UI.'
    editor.value = builtInPrompt + marker
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    page.querySelector('[data-testid="save-agent-default-prompt"]')?.click()
    deadline = Date.now() + 2_000
    while (
      page.querySelector('.agent-config-detail__header .processing-mode-badge')?.textContent?.trim() !== 'Configured default'
      && Date.now() < deadline
    ) await new Promise((resolve) => setTimeout(resolve, 25))
    const configuredBadge = page.querySelector('.agent-config-detail__header .processing-mode-badge')?.textContent?.trim()
    const saveNotice = page.querySelector('[data-testid="agent-default-prompt-saved"]')?.textContent?.trim()

    document.querySelector('[data-testid="nav-knowledge-processing"]')?.click()
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const processingPage = document.querySelector('[data-testid="page-knowledge-processing"]')
    processingPage.querySelector('[data-testid="processing-view-stage-debug"]')?.click()
    processingPage.querySelector('[data-testid="processing-stage-tab-knowledge_maintenance_agent"]')?.click()
    deadline = Date.now() + 2_000
    while (
      !processingPage.querySelector('[data-testid="processing-instructions-knowledge_maintenance_agent"]')?.value?.includes('Configured default from Agent configuration UI.')
      && Date.now() < deadline
    ) await new Promise((resolve) => setTimeout(resolve, 25))
    const processingPromptUsesConfiguredDefault = processingPage
      .querySelector('[data-testid="processing-instructions-knowledge_maintenance_agent"]')
      ?.value?.includes('Configured default from Agent configuration UI.')

    document.querySelector('[data-testid="nav-agent-configuration"]')?.click()
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    page.querySelector('[data-testid="restore-built-in-agent-prompt"]')?.click()
    deadline = Date.now() + 2_000
    while (
      page.querySelector('.agent-config-detail__header .processing-mode-badge')?.textContent?.trim() !== 'Built-in default'
      && Date.now() < deadline
    ) await new Promise((resolve) => setTimeout(resolve, 25))
    const restoredBadge = page.querySelector('.agent-config-detail__header .processing-mode-badge')?.textContent?.trim()
    const restoredPrompt = page.querySelector('[data-testid="agent-default-prompt-editor"]')?.value

    page.querySelector('[data-testid="agent-config-role-chat_agent"]')?.click()
    await new Promise((resolve) => requestAnimationFrame(resolve))
    const chatRoleText = page.querySelector('[data-testid="agent-config-role-chat_agent"]')?.textContent?.trim()
    page.querySelector('[data-testid="agent-config-tab-tools"]')?.click()
    await new Promise((resolve) => requestAnimationFrame(resolve))
    const chatToolNames = Array.from(page.querySelectorAll('.agent-config-tool code'))
      .map((node) => node.textContent?.trim())
    const chatSchemaPanelCount = page.querySelectorAll('.agent-config-tool__schema').length
    const upsertSchemaDetails = page.querySelector('[data-testid="agent-tool-schema-upsert_knowledge"]')
    upsertSchemaDetails.open = true
    await new Promise((resolve) => requestAnimationFrame(resolve))
    const chatUpsertSchema = JSON.parse(upsertSchemaDetails.querySelector('pre')?.textContent || '{}')

    page.querySelector('[data-testid="agent-config-tab-prompt"]')?.click()
    await new Promise((resolve) => requestAnimationFrame(resolve))
    const chatEditor = page.querySelector('[data-testid="agent-default-prompt-editor"]')
    const chatBuiltInPrompt = chatEditor?.value
    chatEditor.value = chatBuiltInPrompt + '\\nConfigured chat default from Agent configuration UI.'
    chatEditor.dispatchEvent(new Event('input', { bubbles: true }))
    page.querySelector('[data-testid="save-agent-default-prompt"]')?.click()
    deadline = Date.now() + 2_000
    while (
      page.querySelector('.agent-config-detail__header .processing-mode-badge')?.textContent?.trim() !== 'Configured default'
      && Date.now() < deadline
    ) await new Promise((resolve) => setTimeout(resolve, 25))
    const chatConfiguredBadge = page.querySelector('.agent-config-detail__header .processing-mode-badge')?.textContent?.trim()
    page.querySelector('[data-testid="restore-built-in-agent-prompt"]')?.click()
    deadline = Date.now() + 2_000
    while (
      page.querySelector('.agent-config-detail__header .processing-mode-badge')?.textContent?.trim() !== 'Built-in default'
      && Date.now() < deadline
    ) await new Promise((resolve) => setTimeout(resolve, 25))
    const chatRestoredPrompt = page.querySelector('[data-testid="agent-default-prompt-editor"]')?.value

    page.querySelector('[data-testid="agent-config-role-knowledge_maintenance_agent"]')?.click()
    await new Promise((resolve) => requestAnimationFrame(resolve))

    return {
      title,
      roleCount,
      preprocessorRolePresent,
      maintenanceToolNames,
      toolsReadOnlyCopy,
      schemaPanelCount,
      expandedSchemaCount,
      searchToolSchema,
      addTodosToolSchema,
      builtInPrompt,
      configuredBadge,
      saveNotice,
      processingPromptUsesConfiguredDefault,
      restoredBadge,
      restoredMatchesBuiltIn: restoredPrompt === builtInPrompt,
      chatRoleText,
      chatToolNames,
      chatSchemaPanelCount,
      chatUpsertSchema,
      chatConfiguredBadge,
      chatRestoredMatchesBuiltIn: chatRestoredPrompt === chatBuiltInPrompt,
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth
    }
  })()`)
  await window.webContents.executeJavaScript(`new Promise((resolve) => {
    const page = document.querySelector('[data-testid="page-agent-configuration"]')
    page.querySelector('[data-testid="agent-config-tab-tools"]')?.click()
    requestAnimationFrame(() => {
      const schema = page.querySelector('[data-testid="agent-tool-schema-add_todos"]')
      if (schema) schema.open = true
      window.scrollTo(0, 0)
      requestAnimationFrame(resolve)
    })
  })`)
  const agentToolsImage = await window.webContents.capturePage()
  await writeFile(join(dirname(capturePath), 'agent-configuration-tools.png'), agentToolsImage.toPNG())
  await window.webContents.executeJavaScript(`document.querySelector('[data-testid="nav-chat"]').click()`)
  const chatSemantics = await window.webContents.executeJavaScript(`(async () => {
    const page = document.querySelector('[data-testid="page-chat"]')
    let deadline = Date.now() + 2_000
    while (!page.querySelector('[data-testid="chat-model-picker"]') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const connection = page.querySelector('[data-testid="chat-model-picker"] select')
    const firstConnection = connection?.options?.[1]?.value
    if (firstConnection) {
      connection.value = firstConnection
      connection.dispatchEvent(new Event('change', { bubbles: true }))
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const selects = page.querySelectorAll('[data-testid="chat-model-picker"] select')
    const model = selects[1]
    const composer = page.querySelector('.chat-composer textarea')
    composer.value = '请简要介绍你能如何使用知识库。'
    composer.dispatchEvent(new Event('input', { bubbles: true }))
    page.querySelector('[data-testid="chat-send"]')?.click()
    deadline = Date.now() + 5_000
    while (
      !page.querySelector('.chat-message--assistant')?.textContent?.includes('Fixture 对话 Agent')
      && !page.querySelector('.page-error')
      && Date.now() < deadline
    ) await new Promise((resolve) => setTimeout(resolve, 25))
    const workspace = page.querySelector('.chat-workspace')?.getBoundingClientRect()
    return {
      title: page.querySelector('h1')?.textContent?.trim(),
      sessionCount: page.querySelectorAll('.chat-session').length,
      selectedModel: model?.value,
      binding: page.querySelector('[data-testid="chat-current-binding"]')?.textContent?.trim(),
      userText: page.querySelector('.chat-message--user')?.textContent?.trim(),
      assistantText: page.querySelector('.chat-message--assistant')?.textContent?.trim(),
      assistantStrongText: page.querySelector('.chat-message--assistant strong')?.textContent?.trim(),
      assistantListItems: page.querySelectorAll('.chat-message--assistant li').length,
      composerVisible: Boolean(composer),
      pageError: page.querySelector('.page-error')?.textContent?.trim(),
      workspaceWithinViewport: Boolean(workspace && workspace.bottom <= window.innerHeight + 1),
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth
    }
  })()`)
  await new Promise((resolve) => setTimeout(resolve, 80))
  const chatImage = await window.webContents.capturePage()
  await writeFile(join(dirname(capturePath), 'chat.png'), chatImage.toPNG())

  window.setSize(900, 780)
  await new Promise((resolve) => setTimeout(resolve, 80))
  await window.webContents.executeJavaScript(`document.querySelector('[data-testid="nav-artifacts"]').click()`)
  const artifactSemantics = await window.webContents.executeJavaScript(`(async () => {
    const page = document.querySelector('[data-testid="page-artifacts"]')
    const createDisclosure = page.querySelector('.artifact-create')
    const createWasCollapsed = Boolean(createDisclosure && !createDisclosure.open)
    const path = page.querySelector('[data-testid="artifact-repository-path"]')
    let deadline = Date.now() + 2_000
    while (
      (!path?.textContent?.trim() || path.textContent.trim() === '正在读取…' || path.textContent.trim() === '—')
      && !page.querySelector('.page-error')
      && Date.now() < deadline
    ) await new Promise((resolve) => setTimeout(resolve, 25))

    const directoryInput = page.querySelector('[data-testid="artifact-directory-name"]')
    const attentionInput = page.querySelector('[data-testid="artifact-attention"]')
    directoryInput.value = 'attention-tracking'
    directoryInput.dispatchEvent(new Event('input', { bubbles: true }))
    attentionInput.value = '持续维护 **Attention 测试**。'
    attentionInput.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((resolve) => requestAnimationFrame(resolve))
    page.querySelector('[data-testid="create-artifact"]')?.click()

    deadline = Date.now() + 2_000
    while (!page.querySelector('[data-testid="artifact-card"]') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const cardCountAfterCreate = page.querySelectorAll('[data-testid="artifact-card"]').length
    const refresh = page.querySelector('[data-testid="refresh-artifacts"]')
    refresh?.click()
    deadline = Date.now() + 2_000
    while (refresh?.textContent?.includes('正在刷新') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }

    return {
      title: page.querySelector('h1')?.textContent?.trim(),
      repositoryPath: path?.textContent?.trim(),
      cardCountAfterCreate,
      cardCountAfterRefresh: page.querySelectorAll('[data-testid="artifact-card"]').length,
      directoryName: page.querySelector('.artifact-card__identity h2')?.textContent?.trim(),
      attentionHeading: page.querySelector('.artifact-card__attention h1')?.textContent?.trim(),
      attentionStrong: page.querySelector('.artifact-card__attention strong')?.textContent?.trim(),
      repositoryOpenDisabled: page.querySelector('[data-testid="open-artifact-repository"]')?.disabled,
      artifactOpenDisabled: page.querySelector('[data-testid="open-artifact"]')?.disabled,
      createWasCollapsed,
      cardDetailsCollapsed: Boolean(page.querySelector('.artifact-card__details:not([open])')),
      pageError: page.querySelector('.page-error')?.textContent?.trim(),
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      overflowElements: Array.from(page.querySelectorAll('*'))
        .filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1)
        .slice(0, 8)
        .map((element) => ({
          tag: element.tagName,
          className: element.className,
          right: Math.round(element.getBoundingClientRect().right),
          width: Math.round(element.getBoundingClientRect().width)
        }))
    }
  })()`)
  await new Promise((resolve) => setTimeout(resolve, 80))
  const artifactImage = await window.webContents.capturePage()
  await writeFile(join(dirname(capturePath), 'artifacts.png'), artifactImage.toPNG())

  window.setSize(1160, 780)
  await new Promise((resolve) => setTimeout(resolve, 80))
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
      skills: skillSemantics,
      ai: { ...aiSemantics, directTest: aiDirectTestSemantics },
      agentConfiguration: agentConfigurationSemantics,
      artifacts: artifactSemantics,
      chat: chatSemantics,
      knowledge: {
        browse: knowledgeBrowseSemantics,
        clear: clearKnowledgeSemantics
      },
      processing: {
        fullChain: fullChainSemantics,
        fullChainRun: fullChainRunSemantics,
        history: {
          ...processingHistorySemantics,
          productionTitles: productionTitlesAfterHistoryImport
        },
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

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const protocol = new URL(url).protocol
      if (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:') {
        void shell.openExternal(url)
      }
    } catch {
      // Invalid or relative model-authored links remain inside the renderer boundary.
    }
    return { action: 'deny' }
  })
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
  const skillDiscoveryService = createSkillDiscoveryService(service)
  if (fixtureMode()) await initializeFixtureSkills(skillDiscoveryHomeDirectory())
  const artifactRepository = new ArtifactRepository(
    join(app.getPath('userData'), 'artifacts')
  )
  const managedSkillService = createManagedSkillService(artifactRepository)
  aiBackendService = createBackendService()
  knowledgeStoreManager = await SqliteKnowledgeStoreManager.open(
    join(app.getPath('userData'), 'knowledge-store')
  )
  knowledgeFullChainRunRepository = await SqliteKnowledgeFullChainRunRepository.open(
    join(app.getPath('userData'), 'knowledge-processing-history.sqlite')
  )
  for (const sandbox of await knowledgeStoreManager.listSandboxes()) {
    await knowledgeStoreManager.discardSandbox(sandbox.id)
  }
  knowledgeProcessingService = createKnowledgeProcessingService(aiBackendService, knowledgeStoreManager)
  chatSessionRepository = new PiChatSessionRepository(join(app.getPath('userData'), 'chat-sessions'))
  chatAgentService = new ChatAgentService({
    sessions: chatSessionRepository,
    configuration: new JsonChatConfigurationRepository(
      join(app.getPath('userData'), 'chat-agent.json')
    ),
    aiBackend: aiBackendService,
    knowledgeStore: knowledgeStoreManager.production,
    artifactRepositoryPath: artifactRepository.repositoryPath
  })
  knowledgeFullChainService = new KnowledgeFullChainService(
    service,
    knowledgeProcessingService,
    knowledgeStoreManager,
    (reader) => fixtureMode()
      ? new FixtureKnowledgeAgentRuntime()
      : new PiKnowledgeMaintenanceAgent(reader),
    knowledgeFullChainRunRepository
  )
  const artifactInitialization = artifactRepository.initialize().catch((error: unknown) => {
    console.error('Artifact Repository 初始化失败；可在协作产物页面重试。', error)
  })
  await Promise.all([
    service.initialize(),
    artifactInitialization,
    aiBackendService.initialize(),
    knowledgeProcessingService.initialize(),
    chatAgentService.initialize()
  ])
  if (fixtureMode() && knowledgeStoreManager.production.listStatements().length === 0) {
    knowledgeStoreManager.production.commit({
      runRef: 'fixture:knowledge-browser',
      statements: [
        {
          title: 'Oyster 知识加工链路',
          content: '将外部 Agent 对话中的候选概念交给 [[Knowledge Maintenance Agent|知识维护 Agent]] 判断，并在隔离空间中验证写入结果。'
        },
        {
          title: 'Knowledge Maintenance Agent',
          content: '负责通过通用 Todo 组织调查、按需回溯[[Raw Evidence|原始证据]]，并让知识层中的 Statement 可以互相解释。'
        },
        {
          title: 'Statement Candidate',
          content: 'Observation Preprocessor 发现的带回源线索的待调查问题；Host 在启动 [[Knowledge Maintenance Agent]] 时将它投影为普通 Todo，它本身不是知识或 Maintainer 内部的业务状态。'
        },
        {
          title: 'Raw Evidence',
          content: '为 [[Statement Candidate]] 和后续调查保留可回读的原始材料。'
        }
      ]
    })
  }
  registerIpc(service)
  registerSkillIpc(skillDiscoveryService, managedSkillService, () => mainWindow)
  registerArtifactIpc(artifactRepository, () => mainWindow)
  registerAiBackendIpc(aiBackendService, () => mainWindow)
  registerKnowledgeProcessingIpc(
    knowledgeProcessingService,
    new SessionPreprocessor(service, knowledgeProcessingService),
    knowledgeFullChainService,
    () => mainWindow
  )
  registerKnowledgeIpc(
    knowledgeStoreManager.production,
    knowledgeFullChainService,
    () => mainWindow
  )
  registerChatIpc(chatAgentService, () => mainWindow)
  await createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createMainWindow()
  })
})

app.on('before-quit', () => {
  chatAgentService?.dispose()
  knowledgeFullChainService?.dispose()
  knowledgeProcessingService?.dispose()
  knowledgeFullChainRunRepository?.close()
  knowledgeStoreManager?.close()
  aiBackendService?.dispose()
  void chatSessionRepository?.dispose()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { discoveryChannels } from '../shared/channels'
import type { DiscoveryStateView, SourceConversationCatalogView } from '../shared/discovery'
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
  FIXTURE_SOURCE_CONVERSATION_ID,
  FIXTURE_SOURCE_CONVERSATION_CONTENT
} from './fixture-state'
import {
  createFixtureKnowledgeProcessingService
} from './knowledge-processing/fixture'
import {
  KnowledgeTaskService
} from './knowledge-processing/knowledge-task-service'
import { GitKnowledgeTaskHistory } from './knowledge-processing/knowledge-task-history'
import { registerKnowledgeProcessingIpc } from './knowledge-processing/ipc'
import { KnowledgeProcessingService } from './knowledge-processing/knowledge-processing-service'
import {
  PiKnowledgeMaintainerAgent,
  PiKnowledgeReviewerAgent
} from './knowledge-processing/pi-collaboration-agents'
import { KnowledgeTaskGitRepository } from './knowledge-processing/knowledge-task-git-repository'
import { JsonKnowledgeProcessingConfigurationRepository } from './knowledge-processing/repository'
import { FileKnowledgeStore } from './knowledge-store/file-knowledge-store'
import { registerKnowledgeIpc } from './knowledge-store/ipc'
import { ChatAgentService } from './chat/chat-agent-service'
import { JsonChatConfigurationRepository } from './chat/chat-configuration-repository'
import { registerChatIpc } from './chat/ipc'
import { PiChatConversationRepository } from './chat/pi-chat-conversation-repository'
import { PiChatAgent } from './chat/pi-chat-agent'
import { ArtifactService } from './artifacts/artifact-repository'
import { runArtifactGit } from './artifacts/git-runtime'
import { registerArtifactIpc } from './artifacts/ipc'
import { registerSkillIpc } from './skills/ipc'
import { ManagedSkillService } from './skills/managed-skill-service'
import { SkillDiscoveryService } from './skills/skill-discovery-service'
import { OysterRepository } from './repository/oyster-repository'
import { FolderBrowserService } from './folder-browser/folder-browser-service'
import { registerFolderBrowserIpc } from './folder-browser/ipc'
import { FileAgentDebugStore, type AgentDebugStore } from './agent-runtime/agent-debug-store'
import { PiExtensionConfigurationService } from './agent-runtime/pi-extension-configuration-service'
import { registerPiExtensionConfigurationIpc } from './agent-runtime/pi-extension-configuration-ipc'
import { PiAgentSettingsService } from './agent-runtime/pi-agent-settings-service'
import { registerPiAgentSettingsIpc } from './agent-runtime/pi-agent-settings-ipc'
import { AppSettingsService } from './app-settings/app-settings-service'
import { registerAppSettingsIpc } from './app-settings/ipc'
import type { AppLanguage } from '../shared/app-settings'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
let mainWindow: BrowserWindow | undefined
let aiBackendService: AiBackendService | undefined
let knowledgeProcessingService: KnowledgeProcessingService | undefined
let knowledgeTaskService: KnowledgeTaskService | undefined
let knowledgeTaskHistory: GitKnowledgeTaskHistory | undefined
let knowledgeStore: FileKnowledgeStore | undefined
let chatAgentService: ChatAgentService | undefined
let chatConversationRepository: PiChatConversationRepository | undefined

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
        sourceConversationId: FIXTURE_SOURCE_CONVERSATION_ID,
        content: FIXTURE_SOURCE_CONVERSATION_CONTENT
      }])
    : new FileSourceEvidenceReader()
  return new DiscoveryService(
    repository,
    evidenceReader,
    createDefaultAdapters(),
    createDetectionContext(app.getPath('home')),
    { recoverInterruptedScans: !useFixtures }
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

async function initializeFixtureKnowledge(store: FileKnowledgeStore): Promise<void> {
  if (store.listStatements().length) return
  const statements = [
    {
      path: 'oyster-processing.md',
      title: 'Oyster 知识加工链路',
      content: 'Host 在统一 Repository 中创建 Knowledge Processing Task branch 与独立 linked worktree，让 [[Knowledge Maintenance Agent|知识维护 Agent]] 和 Reviewer 通过 PROGRESS.md 与 Host checkpoint 交替工作；固定的 [[Raw Evidence|原始证据]] 输入视图保存在该 Task 中，测试结果保持未合并。'
    },
    {
      path: 'knowledge-maintainer.md',
      title: 'Knowledge Maintenance Agent',
      content: '从独立 Task worktree 读取 BRIEF.md、PROGRESS.md 与文件化 Canonical Activity，按需回溯[[Raw Evidence|原始证据]]并直接维护 Knowledge/Artifact 文件；Host 负责 checkpoint commit。'
    },
    {
      path: 'raw-evidence.md',
      title: 'Raw Evidence',
      content: '外部 Source Conversation 的确定版本材料。Host 为一次 Knowledge Processing Task 生成固定的 Source Snapshot 文件视图与 Canonical Activity，供 [[Knowledge Maintenance Agent]] 用普通文件工具有界读取和精确回查。'
    },
    {
      path: 'skill-activation.md',
      title: 'Skill 激活探测',
      content: 'Source Adapter 按 Agent Harness 的记录格式识别 Skill 工具调用、`SKILL.md` 读取和运行时注入，并向 [[Knowledge Maintenance Agent|知识维护 Agent]] 提供回到原始证据核查的导航提示。'
    }
  ]
  await Promise.all(statements.map((statement) => writeFile(
    join(store.knowledgePath, statement.path),
    `# ${statement.title}\n\n${statement.content}\n`,
    'utf8'
  )))
  const repositoryPath = dirname(store.knowledgePath)
  await runArtifactGit(['add', '--', 'knowledge'], repositoryPath)
  await runArtifactGit([
    'commit', '--quiet', '--no-gpg-sign', '-m', 'Initialize fixture knowledge'
  ], repositoryPath)
}

async function initializeFixtureArtifact(repository: OysterRepository): Promise<void> {
  const artifactPath = join(repository.artifactsPath, 'research-brief')
  await mkdir(artifactPath, { recursive: true })
  await writeFile(
    join(artifactPath, 'AGENTS.md'),
    '# 研究简报\n\n持续维护 **Agent Memory 研究简报**，区分事实、推断和待确认事项。\n',
    'utf8'
  )
  await runArtifactGit(['add', '--', 'artifacts'], repository.rootPath)
  await runArtifactGit([
    'commit', '--quiet', '--no-gpg-sign', '-m', 'Initialize fixture Artifact'
  ], repository.rootPath)
}

function createSkillDiscoveryService(discovery: DiscoveryService): SkillDiscoveryService {
  const useFixtures = fixtureMode()
  const homeDirectory = skillDiscoveryHomeDirectory()
  const context = createDetectionContext(homeDirectory, useFixtures ? {} : process.env)
  const projectPaths = () => useFixtures
    ? [join(homeDirectory, 'projects', 'oyster')]
    : discovery.listSourceConversations().flatMap((conversation) => (
        conversation.projectPath ? [conversation.projectPath] : []
      ))
  const adminRoot = useFixtures
    ? join(homeDirectory, 'etc', 'codex', 'skills')
    : undefined

  return new SkillDiscoveryService(context, projectPaths, adminRoot)
}

function createManagedSkillService(repository: ArtifactService): ManagedSkillService {
  const useFixtures = fixtureMode()
  const homeDirectory = skillDiscoveryHomeDirectory()
  const context = createDetectionContext(homeDirectory, useFixtures ? {} : process.env)
  return new ManagedSkillService(repository, context)
}

function createKnowledgeProcessingService(
  aiBackend: AiBackendService,
  processingRepository: KnowledgeTaskGitRepository,
  debugStore: AgentDebugStore,
  getLanguage: () => AppLanguage
): KnowledgeProcessingService {
  if (fixtureMode()) {
    return createFixtureKnowledgeProcessingService(aiBackend, processingRepository, debugStore)
  }
  return new KnowledgeProcessingService(
    new JsonKnowledgeProcessingConfigurationRepository(
      join(app.getPath('userData'), 'knowledge-processing.json')
    ),
    aiBackend,
    processingRepository,
    new PiKnowledgeMaintainerAgent(debugStore, getLanguage),
    new PiKnowledgeReviewerAgent(debugStore, getLanguage)
  )
}

function registerIpc(service: DiscoveryService, getLanguage: () => AppLanguage): void {
  ipcMain.handle(discoveryChannels.getState, () => service.stateView())
  ipcMain.handle(
    discoveryChannels.getSourceConversationCatalog,
    () => service.sourceConversationCatalogView()
  )
  ipcMain.handle(
    discoveryChannels.refreshSourceConversationCatalog,
    () => service.refreshSourceConversationCatalog()
  )
  ipcMain.handle(discoveryChannels.detectAgents, () => service.detectAgents())
  ipcMain.handle(discoveryChannels.scanSource, (_event, sourceId: string) => service.scanSource(sourceId))
  ipcMain.handle(discoveryChannels.cancelScan, (_event, scanId: string) => service.cancelScan(scanId))
  ipcMain.handle(discoveryChannels.chooseSourceRoot, async (_event, sourceId: string) => {
    const owner = BrowserWindow.getFocusedWindow() || mainWindow
    const source = service.stateView().sources.find((candidate) => candidate.id === sourceId)
    const defaultPath = await nearestExistingDirectory(source?.rootPath || app.getPath('home'), app.getPath('home'))
    const result = await dialog.showOpenDialog(owner!, {
      title: getLanguage() === 'en-US' ? 'Choose History Directory' : '选择历史记录目录',
      defaultPath,
      properties: ['openDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return service.stateView()
    return service.chooseSourceRoot(sourceId, result.filePaths[0])
  })

  service.subscribe((state: DiscoveryStateView) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(discoveryChannels.state, state)
    }
  })
  service.subscribeSourceConversationCatalog((catalog: SourceConversationCatalogView) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(discoveryChannels.sourceConversationCatalog, catalog)
    }
  })
}

async function captureFixture(window: BrowserWindow, capturePath: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 700))
  const defaultPage = await window.webContents.executeJavaScript(`(() => {
    const chat = document.querySelector('[data-testid="page-chat"]')
    return chat && !chat.hidden ? 'chat' : 'unknown'
  })()`)
  await window.webContents.executeJavaScript(`document.querySelector('[data-testid="nav-sources"]')?.click()`)
  await new Promise((resolve) => setTimeout(resolve, 80))
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
    const pageHeaderStyle = getComputedStyle(page.querySelector('.page-header'))
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
      headerDragRegion: pageHeaderStyle.getPropertyValue('-webkit-app-region'),
      headerPosition: pageHeaderStyle.position,
      headerTop: pageHeaderStyle.top,
      headerActionRegion: getComputedStyle(primaryButton).getPropertyValue('-webkit-app-region'),
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
      bodyText: page.innerText,
      documentScrollY: window.scrollY,
      bodyOverflow: bodyStyle.overflow,
      navigationItems: Array.from(document.querySelectorAll('.sidebar__navigation .nav-item'))
        .map((item) => item.textContent?.trim()),
      processingInPrimaryNavigation: Boolean(
        document.querySelector('[data-testid="nav-knowledge-processing"]')?.closest('.nav-primary')
      ),
      advancedNavigationExists: Boolean(document.querySelector('.nav-advanced'))
    }
  })()`)
  semantics.defaultPage = defaultPage

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
    const initiallySelectedTitle = page.querySelector('.knowledge-browser__item[aria-selected="true"] strong')?.textContent?.trim()
    const initialDetailTitle = page.querySelector('[data-testid="knowledge-statement-detail"] h2')?.textContent?.trim()
    const initialDetailContent = page.querySelector('[data-testid="knowledge-statement-detail"]')?.textContent?.trim()
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
      nodes: Array.from(referenceGraph?.querySelectorAll('.knowledge-local-graph__node') ?? [])
        .filter((node) => Number(node.dataset.distance) < 2)
        .map((node) => [node.dataset.title, node.style.left, node.style.top])
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
    const referenceNavigationDisclosureNode = Array.from(
      referenceGraph?.querySelectorAll('.knowledge-local-graph__node') ?? []
    ).find((node) => Number(node.dataset.distance) === 1)
    referenceNavigationDisclosureNode?.dispatchEvent(new MouseEvent('mouseenter'))
    await new Promise((resolve) => setTimeout(resolve, 160))
    const referenceNavigationNode = Array.from(
      referenceGraph?.querySelectorAll('.knowledge-local-graph__node') ?? []
    ).find((node) => node.dataset.title === referenceTwoHopTitle)
    referenceNavigationNode?.click()
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
      (page.querySelector('[data-testid="knowledge-statement-detail"] h2')?.textContent?.trim() !== 'Knowledge Maintenance Agent'
        || page.querySelector('[data-testid="statement-nav-back"]')?.disabled !== false)
      && Date.now() < deadline
    ) await new Promise((resolve) => setTimeout(resolve, 25))
    const linkedTitle = page.querySelector('[data-testid="knowledge-statement-detail"] h2')?.textContent?.trim()
    const backButton = page.querySelector('[data-testid="statement-nav-back"]')
    const backAvailable = backButton?.disabled === false
    backButton?.click()
    deadline = Date.now() + 2_000
    while (
      (page.querySelector('[data-testid="knowledge-statement-detail"] h2')?.textContent?.trim() !== 'Oyster 知识加工链路'
        || page.querySelector('[data-testid="statement-nav-forward"]')?.disabled !== false)
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
      selectedTitle: initiallySelectedTitle,
      detailTitle: initialDetailTitle,
      detailContent: initialDetailContent,
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
  const knowledgeTaskSemantics = await window.webContents.executeJavaScript(`(() => {
    const page = document.querySelector('[data-testid="page-knowledge-processing"]')
    const select = page.querySelector('[data-testid="knowledge-task-source-conversation-select"]')
    const initialButton = page.querySelector('[data-testid="start-knowledge-task"]')
    const result = {
      knowledgeTaskSelected: page.querySelector('[data-testid="processing-view-knowledge-task"]')?.getAttribute('aria-selected'),
      worktreeExists: Boolean(page.querySelector('[data-testid="knowledge-task-worktree"]')),
      sourceConversationOptionCount: select?.options.length,
      refreshSourceConversationsButtonExists: Boolean(page.querySelector('[data-testid="refresh-knowledge-task-source-conversations"]')),
      knowledgeTaskButtonExists: Boolean(initialButton),
      knowledgeTaskButtonDisabled: initialButton?.disabled,
      initialDisabledReason: page.querySelector('[data-testid="knowledge-task-disabled-reason"]')?.textContent?.trim(),
      modelSummary: page.querySelector('.knowledge-task__models')?.textContent?.trim(),
      bodyText: page.innerText,
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth
    }
    if (select?.options[1]) {
      select.value = select.options[1].value
      select.dispatchEvent(new Event('change', { bubbles: true }))
    }
    return new Promise((resolve) => requestAnimationFrame(() => resolve({
      ...result,
      selectedSourceConversation: select?.value,
      selectedSourceConversationDetails: {
        title: page.querySelector('[data-testid="knowledge-task-source-conversation-meta-title"]')?.textContent?.trim(),
        timeRange: page.querySelector('[data-testid="knowledge-task-source-conversation-meta-time-range"]')?.textContent?.trim(),
        size: page.querySelector('[data-testid="knowledge-task-source-conversation-meta-size"]')?.textContent?.trim(),
        project: page.querySelector('[data-testid="knowledge-task-source-conversation-meta-project"]')?.textContent?.trim()
      },
      knowledgeTaskButtonEnabledAfterSelection: page.querySelector('[data-testid="start-knowledge-task"]')?.disabled === false,
      readyReason: page.querySelector('[data-testid="knowledge-task-disabled-reason"]')?.textContent?.trim()
    })))
  })()`)
  const knowledgeTaskActivitySemantics = await window.webContents.executeJavaScript(`(async () => {
    const page = document.querySelector('[data-testid="page-knowledge-processing"]')
    page.querySelector('[data-testid="start-knowledge-task"]')?.click()
    let liveUpdatePreservesTool = false
    let liveUpdateKeepsScroll = false
    let liveToolPayloadVisible = false
    let liveDeadline = Date.now() + 2_000
    while (!page.querySelector('[data-testid="open-knowledge-task-activity"]') && Date.now() < liveDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    page.querySelector('[data-testid="open-knowledge-task-activity"]')?.click()
    liveDeadline = Date.now() + 2_000
    while (!page.querySelector('[data-testid="knowledge-task-activity-detail"] .agent-activity-tool') && Date.now() < liveDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const liveDetail = page.querySelector('[data-testid="knowledge-task-activity-detail"]')
    const liveScroll = page.querySelector('.knowledge-task__inspector-content')
    const liveTool = liveDetail?.querySelector('.agent-activity-tool')
    const initialLiveToolCount = liveDetail?.querySelectorAll('.agent-activity-tool').length ?? 0
    const liveSpacer = document.createElement('div')
    liveSpacer.style.height = '900px'
    liveDetail?.prepend(liveSpacer)
    liveTool?.scrollIntoView({ block: 'center' })
    await new Promise((resolve) => requestAnimationFrame(resolve))
    liveTool?.querySelector('.agent-activity-tool__toggle')?.click()
    await new Promise((resolve) => requestAnimationFrame(resolve))
    const liveScrollBefore = liveScroll?.scrollTop ?? 0
    liveDeadline = Date.now() + 2_000
    while (
      (liveDetail?.querySelectorAll('.agent-activity-tool').length ?? 0) <= initialLiveToolCount
      && Date.now() < liveDeadline
    ) await new Promise((resolve) => setTimeout(resolve, 10))
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const currentLiveTool = liveDetail?.querySelector('[data-tool-call-id="' + liveTool?.dataset.toolCallId + '"]')
    liveUpdatePreservesTool = Boolean(liveTool && currentLiveTool === liveTool)
    liveUpdateKeepsScroll = liveScrollBefore > 0 && Math.abs((liveScroll?.scrollTop ?? 0) - liveScrollBefore) < 1
    liveToolPayloadVisible = currentLiveTool?.querySelector('.agent-activity-tool__payloads')?.hidden === false
    liveSpacer.remove()
    page.querySelector('[data-testid="knowledge-task-detail-back"]')?.click()
    await new Promise((resolve) => requestAnimationFrame(resolve))
    const deadline = Date.now() + 5_000
    let inProgressStateVisible = true
    while (Date.now() < deadline) {
      inProgressStateVisible ||= !page.querySelector('[data-testid="start-knowledge-task"]')
      const completed = Boolean(page.querySelector('[data-testid="knowledge-task-result"]'))
      const error = page.querySelector('.page-error')?.textContent?.trim()
      if (completed || error) {
        if (error) return { completed, inProgressStateVisible, error }
        const overviewHasActivityExplorer = Boolean(page.querySelector('[data-testid="agent-invocation-view"]'))
        const summaryStatementCount = page.querySelector('[data-testid="knowledge-task-result-statement-count"]')?.textContent?.trim()
        page.querySelector('[data-testid="open-knowledge-task-activity"]')?.click()
        await new Promise((resolve) => requestAnimationFrame(resolve))
        const activityExplorerExists = Boolean(page.querySelector('[data-testid="agent-invocation-view"]'))
        const invocationHeadingCount = Array.from(page.querySelectorAll(
          '.knowledge-task__inspector strong, .knowledge-task__inspector h2'
        )).filter((element) => element.textContent?.trim() === 'Agent Invocation 详情').length
        const invocationSelectorText = page.querySelector('.agent-invocation-collection__selector')?.textContent
        const selectedAgentName = page.querySelector('.agent-invocation-view__summary > div:first-child strong')?.textContent?.trim()
        const activityEventCount = page.querySelectorAll('.agent-activity-message, .agent-activity-tool, .agent-activity-model-activity').length
        const tool = page.querySelector('.agent-activity-tool')
        if (tool) tool.open = true
        await new Promise((resolve) => requestAnimationFrame(resolve))
        const toolText = tool?.textContent
        const toolInput = tool?.querySelectorAll('pre')[0]?.textContent
        const toolOutput = tool?.querySelectorAll('pre')[1]?.textContent
        const modelCallButton = page.querySelector('.agent-activity-message--assistant button, .agent-activity-model-activity')
        modelCallButton?.click()
        await new Promise((resolve) => requestAnimationFrame(resolve))
        const modelCallDetailExists = Boolean(page.querySelector('[data-testid="knowledge-task-model-call-detail"]'))
        const modelCallUsesSingleInspector = page.querySelectorAll(
          '.knowledge-task__inspector, .agent-invocation-view__inspector'
        ).length === 1
        const modelCallBack = page.querySelector('[data-testid="knowledge-task-model-call-back"]')
        const modelCallBackAvailable = Boolean(modelCallBack)
        modelCallBack?.click()
        await new Promise((resolve) => requestAnimationFrame(resolve))
        const returnedFromModelCall = Boolean(page.querySelector('[data-testid="agent-invocation-view"]'))
          && !page.querySelector('[data-testid="knowledge-task-model-call-detail"]')
        page.querySelector('.agent-activity-message--assistant button, .agent-activity-model-activity')?.click()
        await new Promise((resolve) => requestAnimationFrame(resolve))
        const invocationInspectorCloseAvailable = Boolean(page.querySelector('[data-testid="knowledge-task-detail-back"]'))
        page.querySelector('[data-testid="knowledge-task-detail-back"]')?.click()
        await new Promise((resolve) => requestAnimationFrame(resolve))
        const invocationInspectorClosedFromModelCall = !page.querySelector('.knowledge-task__inspector')
        page.querySelector('[data-testid="open-knowledge-task-result"]')?.click()
        await new Promise((resolve) => requestAnimationFrame(resolve))
        const resultDetailExists = Boolean(page.querySelector('[data-testid="knowledge-task-result-detail"]'))
        const statementCount = page.querySelectorAll('.knowledge-browser--collaboration .knowledge-browser__item').length
        const gitResultText = page.querySelector('[data-testid="knowledge-task-git-result"]')?.textContent
        const changedPathCount = page.querySelector('.knowledge-task__candidates')?.querySelectorAll('code').length
        const collaborationInitialTitle = page.querySelector('.knowledge-browser--collaboration [data-testid="knowledge-statement-detail"] h2')?.textContent?.trim()
        const collaborationLink = page.querySelector('.knowledge-browser--collaboration .knowledge-statement-link > a')
        collaborationLink?.dispatchEvent(new MouseEvent('mouseenter'))
        let linkDeadline = Date.now() + 2_000
        while (
          document.querySelector('.knowledge-statement-preview > span')?.textContent?.includes('正在读取')
          && Date.now() < linkDeadline
        ) await new Promise((resolve) => setTimeout(resolve, 25))
        const collaborationLinkLabel = collaborationLink?.textContent?.trim()
        const collaborationLinkPreview = document.querySelector('.knowledge-statement-preview')?.textContent?.trim()
        collaborationLink?.click()
        linkDeadline = Date.now() + 2_000
        await new Promise((resolve) => requestAnimationFrame(resolve))
        const collaborationLinkedTitle = page.querySelector('.knowledge-browser--collaboration [data-testid="knowledge-statement-detail"] h2')?.textContent?.trim()
        const collaborationBack = page.querySelector('.knowledge-browser--collaboration [data-testid="statement-nav-back"]')
        const collaborationBackAvailable = collaborationBack?.disabled === false
        collaborationBack?.click()
        await new Promise((resolve) => requestAnimationFrame(resolve))
        const collaborationTitleAfterBack = page.querySelector('.knowledge-browser--collaboration [data-testid="knowledge-statement-detail"] h2')?.textContent?.trim()
        const collaborationOverflowAfterBack = document.documentElement.scrollWidth > document.documentElement.clientWidth
        const collaborationForward = page.querySelector('.knowledge-browser--collaboration [data-testid="statement-nav-forward"]')
        const collaborationForwardAvailable = collaborationForward?.disabled === false
        collaborationForward?.click()
        await new Promise((resolve) => requestAnimationFrame(resolve))
        const collaborationTitleAfterForward = page.querySelector('.knowledge-browser--collaboration [data-testid="knowledge-statement-detail"] h2')?.textContent?.trim()
        const bodyText = page.innerText
        page.querySelector('[data-testid="knowledge-task-result-back"]')?.click()
        await new Promise((resolve) => requestAnimationFrame(resolve))
        return {
          completed,
          inProgressStateVisible,
          liveUpdatePreservesTool,
          liveUpdateKeepsScroll,
          liveToolPayloadVisible,
          overviewHasActivityExplorer,
          summaryStatementCount,
          activityExplorerExists,
          invocationHeadingCount,
          invocationSelectorText,
          selectedAgentName,
          activityEventCount,
          toolText,
          toolInput,
          toolOutput,
          modelCallDetailExists,
          modelCallUsesSingleInspector,
          modelCallBackAvailable,
          returnedFromModelCall,
          invocationInspectorCloseAvailable,
          invocationInspectorClosedFromModelCall,
          resultDetailExists,
          statementCount,
          gitResultText,
          changedPathCount,
          collaborationInitialTitle,
          collaborationLinkLabel,
          collaborationLinkPreview,
          collaborationLinkedTitle,
          collaborationBackAvailable,
          collaborationTitleAfterBack,
          collaborationOverflowAfterBack,
          collaborationForwardAvailable,
          collaborationTitleAfterForward,
          returnedToOverview: Boolean(page.querySelector('[data-testid="knowledge-task-source-conversation-select"]')),
          bodyText
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return { completed: false, inProgressStateVisible, error: 'Timed out waiting for knowledge-task result' }
  })()`)
  const processingHistorySemantics = await window.webContents.executeJavaScript(`(async () => {
    const page = document.querySelector('[data-testid="page-knowledge-processing"]')
    page.querySelector('[data-testid="processing-view-history"]')?.click()
    let deadline = Date.now() + 2_000
    while (!page.querySelector('.processing-history-task') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const taskCard = page.querySelector('.processing-history-task')
    const listText = page.querySelector('[data-testid="knowledge-task-history"]')?.innerText
    taskCard?.querySelector('[data-testid^="open-history-result-"]')?.click()
    deadline = Date.now() + 2_000
    while (!page.querySelector('[data-testid="history-task-result-detail"]') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const resultDetailExists = Boolean(page.querySelector('[data-testid="history-task-result-detail"]'))
    const sharedBrowserExists = Boolean(page.querySelector('[data-testid="history-task-result-detail"] [data-testid="knowledge-statement-browser"]'))
    const importButton = page.querySelector('[data-testid="import-history-task"]')
    const historyLink = page.querySelector('[data-testid="history-task-result-detail"] .knowledge-statement-link > a')
    const historyInitialTitle = page.querySelector('[data-testid="history-task-result-detail"] [data-testid="knowledge-statement-detail"] h2')?.textContent?.trim()
    historyLink?.click()
    await new Promise((resolve) => requestAnimationFrame(resolve))
    const historyLinkedTitle = page.querySelector('[data-testid="history-task-result-detail"] [data-testid="knowledge-statement-detail"] h2')?.textContent?.trim()
    page.querySelector('[data-testid="history-task-result-detail"] [data-testid="statement-nav-back"]')?.click()
    await new Promise((resolve) => requestAnimationFrame(resolve))
    const historyTitleAfterBack = page.querySelector('[data-testid="history-task-result-detail"] [data-testid="knowledge-statement-detail"] h2')?.textContent?.trim()
    const overflowAfterStatementBack = document.documentElement.scrollWidth > document.documentElement.clientWidth
    page.querySelector('[data-testid="history-task-result-back"]')?.click()
    await new Promise((resolve) => requestAnimationFrame(resolve))
    page.querySelector('.processing-history-task [data-testid^="open-history-activity-"]')?.click()
    deadline = Date.now() + 2_000
    while (!page.querySelector('[data-testid="history-task-activity-detail"]') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const activityDetailExists = Boolean(page.querySelector('[data-testid="history-task-activity-detail"]'))
    const activityEventCount = page.querySelectorAll('[data-testid="history-task-activity-detail"] .agent-activity-message, [data-testid="history-task-activity-detail"] .agent-activity-tool, [data-testid="history-task-activity-detail"] .agent-activity-model-activity').length
    const activityDetail = page.querySelector('[data-testid="history-task-activity-detail"]')
    const activityScroll = page.querySelector('.processing-history__inspector-content')
    const activityText = page.querySelector('[data-testid="history-task-activity-detail"]')?.textContent
    const invocationSelectorText = page.querySelector('.agent-invocation-collection__selector')?.textContent
    const tool = activityDetail?.querySelector('.agent-activity-tool')
    const toolStyle = tool ? getComputedStyle(tool) : undefined
    const toolIsUnboxed = Boolean(toolStyle
      && (toolStyle.backgroundColor === 'rgba(0, 0, 0, 0)' || toolStyle.backgroundColor === 'transparent')
      && Number.parseFloat(toolStyle.borderTopWidth) === 0)
    const spacer = document.createElement('div')
    spacer.style.height = '900px'
    activityDetail?.prepend(spacer)
    tool?.scrollIntoView({ block: 'center' })
    await new Promise((resolve) => requestAnimationFrame(resolve))
    const toolScrollBefore = activityScroll?.scrollTop ?? 0
    tool?.querySelector('.agent-activity-tool__toggle')?.click()
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const toolScrollAfter = activityScroll?.scrollTop ?? 0
    const toolPayloadVisible = tool?.querySelector('.agent-activity-tool__payloads')?.hidden === false
    spacer.remove()
    if (activityScroll) activityScroll.scrollTop = 0
    page.querySelector('[data-testid="history-task-activity-back"]')?.click()
    await new Promise((resolve) => requestAnimationFrame(resolve))
    return {
      taskCount: page.querySelectorAll('.processing-history-task').length,
      listText,
      resultDetailExists,
      sharedBrowserExists,
      importButtonExists: Boolean(importButton),
      historyInitialTitle,
      historyLinkedTitle,
      historyTitleAfterBack,
      overflowAfterStatementBack,
      activityDetailExists,
      activityEventCount,
      activityText,
      invocationSelectorText,
      toolExpansionKeepsScroll: toolScrollBefore > 0 && Math.abs(toolScrollAfter - toolScrollBefore) < 1,
      toolPayloadVisible,
      toolIsUnboxed,
      returnedToHistory: Boolean(page.querySelector('.processing-history__list'))
    }
  })()`)
  const productionTitlesAfterProcessing = knowledgeStore
    ?.listStatements()
    .map((statement) => statement.title)
    .sort()
  await window.webContents.executeJavaScript(`document.querySelector('[data-testid="processing-view-agent-preview"]').click()`)
  await new Promise((resolve) => setTimeout(resolve, 120))
  await window.webContents.executeJavaScript(`document.querySelector('[data-testid="maintainer-source-conversation-select"]')?.scrollIntoView({ block: 'center' })`)
  await new Promise((resolve) => setTimeout(resolve, 80))
  const agentPreviewImage = await window.webContents.capturePage()
  await writeFile(join(dirname(capturePath), 'knowledge-agent-preview.png'), agentPreviewImage.toPNG())
  const processingSemantics = await window.webContents.executeJavaScript(`(() => {
    const page = document.querySelector('[data-testid="page-knowledge-processing"]')
    const prompts = Array.from(page.querySelectorAll('[data-testid^="processing-instructions-"]'))
    const badges = Array.from(page.querySelectorAll('[data-testid^="processing-prompt-badge-"]'))
    const buttons = Array.from(page.querySelectorAll('button'))
    return {
      title: page.querySelector('h1')?.textContent,
      agentDefinitionCount: page.querySelectorAll('[data-testid="knowledge-agent-knowledge_maintainer"]').length,
      promptCount: prompts.length,
      promptValues: prompts.map((prompt) => prompt.value),
      badgeValues: badges.map((badge) => badge.textContent?.trim()),
      configurationText: Array.from(page.querySelectorAll('[data-testid^="processing-config-"]')).map((node) => node.textContent?.trim()),
      maintainerSourceConversationOptionCount: page.querySelector('[data-testid="maintainer-source-conversation-select"]')?.options.length,
      maintainerSourceConversationValue: page.querySelector('[data-testid="maintainer-source-conversation-select"]')?.value,
      maintainerReadyReason: page.querySelector('[data-testid="maintainer-disabled-reason"]')?.textContent?.trim(),
      maintainerButtonExists: Boolean(page.querySelector('[data-testid="preview-maintainer"]')),
      maintainerDisabled: page.querySelector('[data-testid="preview-maintainer"]')?.disabled,
      resultCount: page.querySelectorAll('[data-testid^="processing-result-"]').length,
      buttonCount: buttons.length,
      sharedButtonCount: page.querySelectorAll('.ui-button').length,
      tabButtonCount: page.querySelectorAll('button[role="tab"]').length,
      taskStatementButtonCount: page.querySelectorAll('.knowledge-browser--collaboration .knowledge-browser__item').length,
      buttonIconCount: buttons.filter((button) => button.querySelector('.ui-button__icon .ui-icon')?.childElementCount > 0).length,
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      bodyText: page.innerText
    }
  })()`)
  const promptRestoreSemantics = await window.webContents.executeJavaScript(`(() => {
    const page = document.querySelector('[data-testid="page-knowledge-processing"]')
    const editor = page.querySelector('[data-testid="processing-instructions-knowledge_maintainer"]')
    const badge = page.querySelector('[data-testid="processing-prompt-badge-knowledge_maintainer"]')
    const restore = page.querySelector('[data-testid="restore-processing-instructions-knowledge_maintainer"]')
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
  await window.webContents.executeJavaScript(`(async () => {
    const page = document.querySelector('[data-testid="page-knowledge-processing"]')
    const button = page.querySelector('[data-testid="preview-maintainer"]')
    button?.click()
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      if (page.querySelector('[data-testid="processing-result-knowledge_maintainer"]')) return
      if (page.querySelector('.page-error')) return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  })()`)
  const agentPreviewActivitySemantics = await window.webContents.executeJavaScript(`(() => {
    const page = document.querySelector('[data-testid="page-knowledge-processing"]')
    const agentPreviewPanels = Array.from(page.querySelectorAll('.knowledge-agent [data-testid="agent-preview-invocation"]'))
    const result = page.querySelector('[data-testid="processing-result-knowledge_maintainer"]')
    result?.scrollIntoView({ block: 'center' })
    return {
      panelCount: agentPreviewPanels.length,
      maintenanceEventCount: page.querySelectorAll('.knowledge-agent .agent-activity-message, .knowledge-agent .agent-activity-tool, .knowledge-agent .agent-activity-model-activity').length,
      modelCallAction: Boolean(page.querySelector('.knowledge-agent .agent-activity-message--assistant button')),
      agentName: page.querySelector('.knowledge-agent .agent-invocation-view__compact-header strong')?.textContent?.trim(),
      resultText: result?.textContent,
      bodyText: page.innerText,
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth
    }
  })()`)
  await new Promise((resolve) => setTimeout(resolve, 80))
  await window.webContents.executeJavaScript(`document.querySelector('.knowledge-agent [data-testid="agent-preview-invocation"]')?.scrollIntoView({ block: 'center' })`)
  await new Promise((resolve) => setTimeout(resolve, 80))
  const maintainerInvocationImage = await window.webContents.capturePage()
  await writeFile(
    join(dirname(capturePath), 'knowledge-processing-maintainer-invocation.png'),
    maintainerInvocationImage.toPNG()
  )
  await window.webContents.executeJavaScript(`document.querySelector('[data-testid="nav-ai-backends"]').click()`)
  await window.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(resolve))`)
  const generalSettingsDefaultSemantics = await window.webContents.executeJavaScript(`(() => ({
    selected: document.querySelector('[data-testid="settings-tab-general"]')?.getAttribute('aria-selected'),
    visible: !document.querySelector('[data-testid="page-general-settings"]')?.hidden,
    language: document.querySelector('[data-testid="app-language-select"]')?.value
  }))()`)
  await window.webContents.executeJavaScript(`document.querySelector('[data-testid="settings-tab-ai-backends"]')?.click()`)
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
      title: document.querySelector('[data-testid="settings-tab-ai-backends"]')?.textContent?.trim(),
      nestedInSettings: Boolean(page.closest('[data-testid="page-settings"]')),
      backendKind: page.querySelector('[data-testid="backend-kind-select"]')?.value,
      provider: page.querySelector('[data-testid="provider-select"]')?.value,
      codexCards: page.querySelectorAll('[data-testid="codex-runtime-card"]').length,
      modelCards: page.querySelectorAll('[data-testid="model-connection-card"]').length,
      codingPlanModel: page.querySelector('[data-testid="coding-plan-model-select"]')?.value,
      codingPlanReasoning: page.querySelector('[data-testid="coding-plan-reasoning-select"]')?.value,
      codingPlanConfiguration: page.querySelector('[data-testid="coding-plan-test-configuration"]')?.textContent,
      defaultLlmConnection: page.querySelector('[data-testid="default-llm-connection-select"]')?.value,
      defaultLlmModel: page.querySelector('[data-testid="default-llm-model-select"]')?.value,
      defaultLlmSummary: page.querySelector('[data-testid="default-llm-summary"]')?.textContent?.trim(),
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
    while (page.querySelectorAll('.agent-config-role').length < 3 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const title = document.querySelector('[data-testid="settings-tab-agents"]')?.textContent?.trim()
    const roleCount = page.querySelectorAll('.agent-config-role').length

    page.querySelector('[data-testid="agent-config-role-knowledge_maintainer"]')?.click()
    await new Promise((resolve) => requestAnimationFrame(resolve))
    page.querySelector('[data-testid="agent-config-tab-tools"]')?.click()
    await new Promise((resolve) => requestAnimationFrame(resolve))
    const maintenanceToolNames = Array.from(page.querySelectorAll('.agent-config-tool code'))
      .map((node) => node.textContent?.trim())
    const toolsReadOnlyCopy = page.querySelector('[data-testid="agent-config-tools-panel"]')?.textContent?.trim()
    const schemaPanelCount = page.querySelectorAll('.agent-config-tool__schema').length
    const readSchemaDetails = page.querySelector('[data-testid="agent-tool-schema-read"]')
    if (readSchemaDetails) readSchemaDetails.open = true
    await new Promise((resolve) => requestAnimationFrame(resolve))
    const readToolSchema = JSON.parse(readSchemaDetails?.querySelector('pre')?.textContent || '{}')
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
      page.querySelector('.agent-config-detail__header .processing-mode-badge')?.textContent?.trim() !== '已配置默认值'
      && Date.now() < deadline
    ) await new Promise((resolve) => setTimeout(resolve, 25))
    const configuredBadge = page.querySelector('.agent-config-detail__header .processing-mode-badge')?.textContent?.trim()
    const saveNotice = page.querySelector('[data-testid="agent-default-prompt-saved"]')?.textContent?.trim()

    document.querySelector('[data-testid="nav-knowledge-processing"]')?.click()
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const processingPage = document.querySelector('[data-testid="page-knowledge-processing"]')
    processingPage.querySelector('[data-testid="processing-view-agent-preview"]')?.click()
    processingPage.querySelector('[data-testid="knowledge-agent-tab-knowledge_maintainer"]')?.click()
    deadline = Date.now() + 2_000
    while (
      !processingPage.querySelector('[data-testid="processing-instructions-knowledge_maintainer"]')?.value?.includes('Configured default from Agent configuration UI.')
      && Date.now() < deadline
    ) await new Promise((resolve) => setTimeout(resolve, 25))
    const processingPromptUsesConfiguredDefault = processingPage
      .querySelector('[data-testid="processing-instructions-knowledge_maintainer"]')
      ?.value?.includes('Configured default from Agent configuration UI.')

    document.querySelector('[data-testid="nav-ai-backends"]')?.click()
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    document.querySelector('[data-testid="nav-agent-configuration"]')?.click()
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    page.querySelector('[data-testid="restore-built-in-agent-prompt"]')?.click()
    deadline = Date.now() + 2_000
    while (
      page.querySelector('.agent-config-detail__header .processing-mode-badge')?.textContent?.trim() !== '内置默认值'
      && Date.now() < deadline
    ) await new Promise((resolve) => setTimeout(resolve, 25))
    const restoredBadge = page.querySelector('.agent-config-detail__header .processing-mode-badge')?.textContent?.trim()
    const restoredPrompt = page.querySelector('[data-testid="agent-default-prompt-editor"]')?.value

    page.querySelector('[data-testid="agent-config-role-knowledge_reviewer"]')?.click()
    await new Promise((resolve) => requestAnimationFrame(resolve))
    page.querySelector('[data-testid="agent-config-tab-tools"]')?.click()
    await new Promise((resolve) => requestAnimationFrame(resolve))
    const reviewerToolNames = Array.from(page.querySelectorAll('.agent-config-tool code'))
      .map((node) => node.textContent?.trim())
    const reviewerSchemaPanelCount = page.querySelectorAll('.agent-config-tool__schema').length

    page.querySelector('[data-testid="agent-config-role-chat_agent"]')?.click()
    await new Promise((resolve) => requestAnimationFrame(resolve))
    const chatRoleText = page.querySelector('[data-testid="agent-config-role-chat_agent"]')?.textContent?.trim()
    page.querySelector('[data-testid="agent-config-tab-tools"]')?.click()
    await new Promise((resolve) => requestAnimationFrame(resolve))
    const chatToolNames = Array.from(page.querySelectorAll('.agent-config-tool code'))
      .map((node) => node.textContent?.trim())
    const chatSchemaPanelCount = page.querySelectorAll('.agent-config-tool__schema').length
    const spawnSchemaDetails = page.querySelector('[data-testid="agent-tool-schema-spawn_agent"]')
    if (spawnSchemaDetails) spawnSchemaDetails.open = true
    await new Promise((resolve) => requestAnimationFrame(resolve))
    const chatSpawnSchema = JSON.parse(spawnSchemaDetails?.querySelector('pre')?.textContent || '{}')

    page.querySelector('[data-testid="agent-config-tab-prompt"]')?.click()
    await new Promise((resolve) => requestAnimationFrame(resolve))
    const chatEditor = page.querySelector('[data-testid="agent-default-prompt-editor"]')
    const chatBuiltInPrompt = chatEditor?.value
    chatEditor.value = chatBuiltInPrompt + '\\nConfigured chat default from Agent configuration UI.'
    chatEditor.dispatchEvent(new Event('input', { bubbles: true }))
    page.querySelector('[data-testid="save-agent-default-prompt"]')?.click()
    deadline = Date.now() + 2_000
    while (
      page.querySelector('.agent-config-detail__header .processing-mode-badge')?.textContent?.trim() !== '已配置默认值'
      && Date.now() < deadline
    ) await new Promise((resolve) => setTimeout(resolve, 25))
    const chatConfiguredBadge = page.querySelector('.agent-config-detail__header .processing-mode-badge')?.textContent?.trim()
    page.querySelector('[data-testid="restore-built-in-agent-prompt"]')?.click()
    deadline = Date.now() + 2_000
    while (
      page.querySelector('.agent-config-detail__header .processing-mode-badge')?.textContent?.trim() !== '内置默认值'
      && Date.now() < deadline
    ) await new Promise((resolve) => setTimeout(resolve, 25))
    const chatRestoredPrompt = page.querySelector('[data-testid="agent-default-prompt-editor"]')?.value

    page.querySelector('[data-testid="agent-config-tab-runtime"]')?.click()
    deadline = Date.now() + 2_000
    while (
      (
        !page.querySelector('[data-testid="pi-agent-auto-compaction"]')
        || page.querySelector('[data-testid="pi-agent-auto-compaction"]')?.disabled
      )
      && Date.now() < deadline
    ) await new Promise((resolve) => setTimeout(resolve, 25))
    const runtimeCompaction = page.querySelector('[data-testid="pi-agent-auto-compaction"]')
    const runtimeTransport = page.querySelector('[data-testid="pi-agent-transport"]')
    const runtimeTimeout = page.querySelector('[data-testid="pi-agent-http-idle-timeout"]')
    if (runtimeCompaction && runtimeTransport && runtimeTimeout) {
      runtimeCompaction.checked = false
      runtimeCompaction.dispatchEvent(new Event('change', { bubbles: true }))
      runtimeTransport.value = 'sse'
      runtimeTransport.dispatchEvent(new Event('change', { bubbles: true }))
      runtimeTimeout.value = '42'
      runtimeTimeout.dispatchEvent(new Event('input', { bubbles: true }))
      page.querySelector('[data-testid="save-pi-agent-settings"]')?.click()
      deadline = Date.now() + 2_000
      while (
        page.querySelector('[data-testid="save-pi-agent-settings"]')?.textContent?.trim() === '保存中…'
        && Date.now() < deadline
      ) await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const runtimeSettings = {
      tabExists: Boolean(page.querySelector('[data-testid="agent-config-tab-runtime"]')),
      pageVisible: !page.hidden
        && !page.closest('[data-testid="page-settings"]')?.hidden,
      compaction: page.querySelector('[data-testid="pi-agent-auto-compaction"]')?.checked,
      transport: page.querySelector('[data-testid="pi-agent-transport"]')?.value,
      timeout: page.querySelector('[data-testid="pi-agent-http-idle-timeout"]')?.value,
      settingsPath: page.querySelector('.pi-agent-settings__path')?.textContent?.trim(),
      notice: page.querySelector('.pi-agent-settings__notice')?.textContent?.trim(),
      error: page.querySelector('.pi-agent-settings .page-error')?.textContent?.trim(),
      saveDisabled: page.querySelector('[data-testid="save-pi-agent-settings"]')?.disabled
    }
    await new Promise((resolve) => requestAnimationFrame(resolve))

    page.querySelector('[data-testid="agent-config-role-knowledge_maintainer"]')?.click()
    await new Promise((resolve) => requestAnimationFrame(resolve))

    return {
      title,
      nestedInSettings: Boolean(page.closest('[data-testid="page-settings"]')),
      roleCount,
      maintenanceToolNames,
      toolsReadOnlyCopy,
      schemaPanelCount,
      expandedSchemaCount,
      readToolSchema,
      builtInPrompt,
      configuredBadge,
      saveNotice,
      processingPromptUsesConfiguredDefault,
      restoredBadge,
      restoredMatchesBuiltIn: restoredPrompt === builtInPrompt,
      reviewerToolNames,
      reviewerSchemaPanelCount,
      chatRoleText,
      chatToolNames,
      chatSchemaPanelCount,
      chatSpawnSchema,
      chatConfiguredBadge,
      chatRestoredMatchesBuiltIn: chatRestoredPrompt === chatBuiltInPrompt,
      runtimeSettings,
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth
    }
  })()`)
  await window.webContents.executeJavaScript(`new Promise((resolve) => {
    const page = document.querySelector('[data-testid="page-agent-configuration"]')
    page.querySelector('[data-testid="agent-config-role-chat_agent"]')?.click()
    requestAnimationFrame(() => {
      page.querySelector('[data-testid="agent-config-tab-runtime"]')?.click()
      requestAnimationFrame(resolve)
    })
  })`)
  await new Promise((resolve) => setTimeout(resolve, 80))
  const agentRuntimeImage = await window.webContents.capturePage()
  await writeFile(join(dirname(capturePath), 'agent-configuration-runtime.png'), agentRuntimeImage.toPNG())
  await window.webContents.executeJavaScript(`document.querySelector('[data-testid="agent-config-role-knowledge_maintainer"]')?.click()`)
  await window.webContents.executeJavaScript(`new Promise((resolve) => {
    const page = document.querySelector('[data-testid="page-agent-configuration"]')
    page.querySelector('[data-testid="agent-config-tab-tools"]')?.click()
    requestAnimationFrame(() => {
      const schema = page.querySelector('[data-testid="agent-tool-schema-read"]')
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
    while (!page.querySelector('[data-testid="chat-default-binding"]') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const selectedModel = page.querySelector('[data-testid="chat-default-binding"] > div:nth-child(2) strong')?.textContent?.trim()
    const composer = page.querySelector('.chat-composer textarea')
    composer.value = '请简要介绍你能如何使用知识库。'
    composer.dispatchEvent(new Event('input', { bubbles: true }))
    page.querySelector('[data-testid="chat-send"]')?.click()
    deadline = Date.now() + 5_000
    while (
      !page.querySelector('.agent-activity-message--assistant')?.textContent?.includes('Fixture 对话 Agent')
      && !page.querySelector('.page-error')
      && Date.now() < deadline
    ) await new Promise((resolve) => setTimeout(resolve, 25))
    const modelCallButton = page.querySelector('.agent-activity-message--assistant button')
    const messages = page.querySelector('.chat-messages')
    const messageScrollHeightBeforeInspector = messages?.scrollHeight
    modelCallButton?.click()
    await new Promise((resolve) => requestAnimationFrame(resolve))
    const modelCallInspector = page.querySelector('[data-testid="agent-model-call-inspector"]')
    const inspectorPanel = page.querySelector('[data-testid="agent-invocation-inspector"]')
    const inspectorBounds = inspectorPanel?.getBoundingClientRect()
    const inspectorPosition = inspectorPanel ? getComputedStyle(inspectorPanel).position : undefined
    const messageHeightStable = messages?.scrollHeight === messageScrollHeightBeforeInspector
    const modelCallContext = page.querySelector('[data-testid="agent-model-call-context"]')?.textContent
    const overflowWithInspector = document.documentElement.scrollWidth > document.documentElement.clientWidth
    page.querySelector('.agent-invocation-view__close')?.click()
    await new Promise((resolve) => requestAnimationFrame(resolve))
    const workspace = page.querySelector('.chat-workspace')?.getBoundingClientRect()
    const timelineStyle = page.querySelector('.agent-activity-timeline')
      ? getComputedStyle(page.querySelector('.agent-activity-timeline'))
      : undefined
    const assistantStyle = page.querySelector('.agent-activity-message__text')
      ? getComputedStyle(page.querySelector('.agent-activity-message__text'))
      : undefined
    const messagesStyle = messages ? getComputedStyle(messages) : undefined
    return {
      title: page.querySelector('h1')?.textContent?.trim(),
      conversationCount: page.querySelectorAll('.chat-conversation-item').length,
      selectedModel,
      binding: page.querySelector('[data-testid="chat-current-binding"]')?.textContent?.trim(),
      userText: page.querySelector('.agent-activity-message--user')?.textContent?.trim(),
      assistantText: page.querySelector('.agent-activity-message--assistant')?.textContent?.trim(),
      assistantStrongText: page.querySelector('.agent-activity-message--assistant .agent-activity-message__text strong')?.textContent?.trim(),
      assistantListItems: page.querySelectorAll('.agent-activity-message--assistant li').length,
      invocationViewCount: page.querySelectorAll('[data-testid="agent-invocation-view"]').length,
      modelCallAction: Boolean(modelCallButton),
      modelCallInspector: Boolean(modelCallInspector),
      modelCallContext,
      inspectorPosition,
      inspectorRole: inspectorPanel?.getAttribute('role'),
      inspectorModal: inspectorPanel?.getAttribute('aria-modal'),
      inspectorWithinViewport: Boolean(inspectorBounds
        && inspectorBounds.top >= 52
        && inspectorBounds.right <= window.innerWidth
        && inspectorBounds.bottom <= window.innerHeight),
      messageHeightStable,
      timelineGap: timelineStyle?.rowGap,
      messageFontSize: assistantStyle?.fontSize,
      messageLineHeight: assistantStyle?.lineHeight,
      messagePaddingTop: messagesStyle?.paddingTop,
      conversationOverflowY: getComputedStyle(page.querySelector('.chat-conversations__list')).overflowY,
      messagesOverflowY: messagesStyle?.overflowY,
      documentScrollY: window.scrollY,
      overflowWithInspector,
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
    let deadline = Date.now() + 2_000
    while (!page.querySelector('[data-testid="artifact-card"]') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const refresh = page.querySelector('[data-testid="refresh-artifacts"]')
    refresh?.click()
    deadline = Date.now() + 2_000
    while (refresh?.textContent?.includes('正在刷新') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }

    return {
      title: page.querySelector('h1')?.textContent?.trim(),
      designDocumentsCard: Boolean(page.querySelector('[data-testid="design-documents-card"]')),
      manualCreateExists: Boolean(page.querySelector('[data-testid="create-artifact"]')),
      repositoryManagementExists: Boolean(page.querySelector('[data-testid="artifact-repository-path"]')),
      startConversationDisabled: page.querySelector('[data-testid="start-artifact-conversation"]')?.disabled,
      cardCountAfterRefresh: page.querySelectorAll('[data-testid="artifact-card"]').length,
      directoryName: page.querySelector('[data-testid="artifact-card"] .folder-card__identity h2')?.textContent?.trim(),
      attentionHeading: page.querySelector('.artifact-card__attention h1')?.textContent?.trim(),
      attentionStrong: page.querySelector('.artifact-card__attention strong')?.textContent?.trim(),
      artifactBrowseDisabled: page.querySelector('[data-testid="browse-artifact"]')?.disabled,
      artifactOpenDisabled: page.querySelector('[data-testid="open-artifact"]')?.disabled,
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

  await window.webContents.executeJavaScript(`document.querySelector('[data-testid="browse-artifact"]')?.click()`)
  const artifactBrowserSemantics = await window.webContents.executeJavaScript(`(async () => {
    const deadline = Date.now() + 2_000
    let page
    while (Date.now() < deadline) {
      page = document.querySelector('[data-testid="page-folder-browser"]')
      if (page && !page.hidden && page.querySelector('[data-testid="folder-browser-markdown"]')) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return {
      title: page?.querySelector('h1')?.textContent?.trim(),
      path: page?.querySelector('.folder-browser-page__path')?.textContent?.trim(),
      selectedPath: page?.querySelector('.folder-browser__navigation > span')?.textContent?.trim(),
      fileNames: Array.from(page?.querySelectorAll('[data-testid="folder-browser-entry"] span') || [])
        .map((element) => element.textContent?.trim()),
      markdownHeading: page?.querySelector('[data-testid="folder-browser-markdown"] h1')?.textContent?.trim(),
      pageError: page?.querySelector('.page-error')?.textContent?.trim(),
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      fileTabSelected: document.querySelector('[data-testid="artifacts-tab-files"]')?.getAttribute('aria-selected'),
      nestedInArtifacts: Boolean(page?.closest('[data-testid="page-artifacts"]'))
    }
  })()`)
  const artifactBrowserImage = await window.webContents.capturePage()
  await writeFile(join(dirname(capturePath), 'artifact-browser.png'), artifactBrowserImage.toPNG())
  await window.webContents.executeJavaScript(`document.querySelector('[data-testid="folder-browser-close"]')?.click()`)

  await window.webContents.executeJavaScript(`document.querySelector('[data-testid="nav-ai-backends"]')?.click()`)
  await window.webContents.executeJavaScript(`document.querySelector('[data-testid="settings-tab-general"]')?.click()`)
  await window.webContents.executeJavaScript(`document.querySelector('[data-testid="browse-design-documents"]')?.click()`)
  const designDocumentsBrowserSemantics = await window.webContents.executeJavaScript(`(async () => {
    const deadline = Date.now() + 2_000
    let page
    while (Date.now() < deadline) {
      page = document.querySelector('[data-testid="settings-design-documents-browser"] [data-testid="folder-browser-page"]')
      if (page && !page.hidden && page.querySelector('[data-testid="folder-browser-markdown"]')) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return {
      title: page?.querySelector('h1')?.textContent?.trim(),
      path: page?.querySelector('.folder-browser-page__path')?.textContent?.trim(),
      selectedPath: page?.querySelector('.folder-browser__navigation > span')?.textContent?.trim(),
      fileNames: Array.from(page?.querySelectorAll('[data-testid="folder-browser-entry"] span') || [])
        .map((element) => element.textContent?.trim()),
      markdownRendered: Boolean(page?.querySelector('[data-testid="folder-browser-markdown"]')),
      nestedInSettings: Boolean(page?.closest('[data-testid="settings-design-documents-browser"]')),
      pageError: page?.querySelector('.page-error')?.textContent?.trim(),
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth
    }
  })()`)
  const designDocumentsBrowserImage = await window.webContents.capturePage()
  await writeFile(join(dirname(capturePath), 'design-documents-browser.png'), designDocumentsBrowserImage.toPNG())
  await window.webContents.executeJavaScript(`document.querySelector('[data-testid="folder-browser-close"]')?.click()`)

  window.setSize(1160, 780)
  await new Promise((resolve) => setTimeout(resolve, 80))
  await window.webContents.executeJavaScript(`document.querySelector('[data-testid="nav-knowledge-processing"]').click()`)
  await new Promise((resolve) => setTimeout(resolve, 120))
  const processingStateAfterNavigation = await window.webContents.executeJavaScript(`(() => {
    const page = document.querySelector('[data-testid="page-knowledge-processing"]')
    return {
      selectedSourceConversation: page.querySelector('[data-testid="knowledge-task-source-conversation-select"]')?.value,
      agentPreviewSelected: page.querySelector('[data-testid="processing-view-agent-preview"]')?.getAttribute('aria-selected')
    }
  })()`)

  await window.webContents.executeJavaScript(`document.querySelector('[data-testid="nav-ai-backends"]')?.click()`)
  await window.webContents.executeJavaScript(`document.querySelector('[data-testid="settings-tab-general"]')?.click()`)
  const languageSemantics = await window.webContents.executeJavaScript(`(async () => {
    const select = document.querySelector('[data-testid="app-language-select"]')
    select.value = 'en-US'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    const deadline = Date.now() + 2_000
    while (
      (document.documentElement.lang !== 'en-US' || select.disabled)
      && !document.querySelector('[data-testid="page-general-settings"] .page-error')
      && Date.now() < deadline
    ) await new Promise((resolve) => setTimeout(resolve, 25))
    return {
      documentLanguage: document.documentElement.lang,
      selectedLanguage: select.value,
      settingsTitle: document.querySelector('[data-testid="settings-page"] h1')?.textContent?.trim(),
      generalTab: document.querySelector('[data-testid="settings-tab-general"]')?.textContent?.trim(),
      generalPageVisible: !document.querySelector('[data-testid="page-general-settings"]')?.hidden,
      navigationItems: Array.from(document.querySelectorAll('.sidebar__navigation .nav-item'))
        .map((item) => item.textContent?.trim()),
      error: document.querySelector('[data-testid="page-general-settings"] .page-error')?.textContent?.trim(),
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth
    }
  })()`)
  await new Promise((resolve) => setTimeout(resolve, 80))
  const englishSettingsImage = await window.webContents.capturePage()
  await writeFile(join(dirname(capturePath), 'settings-english.png'), englishSettingsImage.toPNG())
  await writeFile(
    `${capturePath}.json`,
    `${JSON.stringify({
      ...semantics,
      settings: {
        defaultGeneral: generalSettingsDefaultSemantics,
        language: languageSemantics
      },
      skills: skillSemantics,
      ai: { ...aiSemantics, directTest: aiDirectTestSemantics },
      agentConfiguration: agentConfigurationSemantics,
      artifacts: artifactSemantics,
      folderBrowser: {
        artifact: artifactBrowserSemantics,
        designDocuments: designDocumentsBrowserSemantics
      },
      chat: chatSemantics,
      knowledge: {
        browse: knowledgeBrowseSemantics,
        clear: clearKnowledgeSemantics
      },
      processing: {
        knowledgeTask: knowledgeTaskSemantics,
        knowledgeTaskActivity: knowledgeTaskActivitySemantics,
        history: {
          ...processingHistorySemantics,
          productionTitles: productionTitlesAfterProcessing
        },
        ...processingSemantics,
        promptRestore: promptRestoreSemantics,
        agentPreviewActivity: agentPreviewActivitySemantics,
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
  const appSettingsService = new AppSettingsService(
    join(app.getPath('userData'), 'app-settings.json')
  )
  await appSettingsService.initialize()
  const service = createService()
  const skillDiscoveryService = createSkillDiscoveryService(service)
  if (fixtureMode()) await initializeFixtureSkills(skillDiscoveryHomeDirectory())
  const repository = new OysterRepository(join(app.getPath('userData'), 'repository'))
  await repository.initialize()
  if (fixtureMode()) await initializeFixtureArtifact(repository)
  const agentDebugStore = new FileAgentDebugStore(
    join(app.getPath('userData'), 'agent-debug', 'invocations')
  )
  const artifactService = new ArtifactService(repository)
  const folderBrowser = new FolderBrowserService()
  const designDocumentsPath = app.isPackaged
    ? resolve(currentDirectory, '..', 'oyster-design-docs', 'docs')
    : resolve(currentDirectory, '..', '..', 'docs')
  const managedSkillService = createManagedSkillService(artifactService)
  aiBackendService = createBackendService()
  knowledgeStore = new FileKnowledgeStore(repository.knowledgePath)
  const processingRepository = new KnowledgeTaskGitRepository(repository, {
    worktreesPath: join(app.getPath('userData'), 'worktrees'),
    runtimePath: join(app.getPath('userData'), 'agent-runtime')
  })
  knowledgeTaskHistory = new GitKnowledgeTaskHistory(repository, processingRepository)
  knowledgeProcessingService = createKnowledgeProcessingService(
    aiBackendService,
    processingRepository,
    agentDebugStore,
    () => appSettingsService.languageSetting
  )
  chatConversationRepository = new PiChatConversationRepository(
    join(app.getPath('userData'), 'chat-conversations'),
    agentDebugStore
  )
  chatAgentService = new ChatAgentService({
    conversations: chatConversationRepository,
    configuration: new JsonChatConfigurationRepository(
      join(app.getPath('userData'), 'chat-agent.json')
    ),
    aiBackend: aiBackendService,
    repositoryPath: repository.rootPath,
    debugStore: agentDebugStore,
    agent: new PiChatAgent(
      repository.rootPath,
      join(app.getPath('userData'), 'pi-agent'),
      agentDebugStore,
      () => appSettingsService.languageSetting
    )
  })
  knowledgeTaskService = new KnowledgeTaskService(
    service,
    knowledgeProcessingService,
    processingRepository,
    knowledgeTaskHistory,
    agentDebugStore
  )
  const artifactInitialization = artifactService.initialize().catch((error: unknown) => {
    console.error('Artifact 层初始化失败；可在工作台重试。', error)
  })
  await Promise.all([
    service.initialize(),
    artifactInitialization,
    aiBackendService.initialize(),
    knowledgeProcessingService.initialize(),
    chatAgentService.initialize()
  ])
  if (fixtureMode()) await initializeFixtureKnowledge(knowledgeStore)
  registerIpc(service, () => appSettingsService.languageSetting)
  registerSkillIpc(skillDiscoveryService, managedSkillService, () => mainWindow)
  registerArtifactIpc(artifactService, () => mainWindow)
  registerFolderBrowserIpc(folderBrowser, designDocumentsPath, () => mainWindow)
  registerAiBackendIpc(aiBackendService, () => mainWindow)
  registerKnowledgeProcessingIpc(
    service,
    knowledgeProcessingService,
    knowledgeTaskService,
    () => mainWindow
  )
  registerKnowledgeIpc(
    knowledgeStore,
    () => mainWindow
  )
  registerChatIpc(chatAgentService, () => mainWindow)
  registerAppSettingsIpc(appSettingsService, () => mainWindow)
  registerPiExtensionConfigurationIpc(
    new PiExtensionConfigurationService(join(app.getPath('userData'), 'pi-agent')),
    () => mainWindow
  )
  registerPiAgentSettingsIpc(
    new PiAgentSettingsService(join(app.getPath('userData'), 'pi-agent')),
    () => mainWindow
  )
  await createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createMainWindow()
  })
})

app.on('before-quit', () => {
  chatAgentService?.dispose()
  knowledgeTaskService?.dispose()
  knowledgeProcessingService?.dispose()
  aiBackendService?.dispose()
  void chatConversationRepository?.dispose()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

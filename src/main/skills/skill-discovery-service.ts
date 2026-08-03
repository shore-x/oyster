import { createHash } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, open, readdir, realpath, stat, type FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { AgentType } from '../../shared/discovery'
import type {
  DiscoveredSkill,
  SkillDiscoveryError,
  SkillDiscoverySnapshot,
  SkillDocument,
  SkillFormat,
  SkillScope
} from '../../shared/skills'
import type { DetectionContext } from '../discovery/model'
import { skillMetadataFields } from './skill-metadata'

const MAX_PREVIEW_BYTES = 2 * 1024 * 1024
const METADATA_HEAD_BYTES = 64 * 1024
const DEFAULT_CODEX_ADMIN_ROOT = '/etc/codex/skills'
const READ_ONLY_NO_FOLLOW = constants.O_RDONLY | constants.O_NOFOLLOW

type ProjectPathGetter = () => readonly string[] | Promise<readonly string[]>

interface SkillRegistration {
  agentType: AgentType
  agentDisplayName: string
  scope: SkillScope
  projectPath?: string
  directoryPath: string
  documentPath: string
  format: SkillFormat
}

interface DiscoveryAccumulator {
  skills: Map<string, DiscoveredSkill>
  documentIdentities: Map<string, DocumentIdentity>
  errors: SkillDiscoveryError[]
}

interface DocumentIdentity {
  device: number
  inode: number
  sizeBytes: number
  modifiedAtMs: number
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function missingPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function addError(
  accumulator: DiscoveryAccumulator,
  agentType: AgentType,
  path: string,
  error: unknown
): void {
  if (missingPath(error)) return
  accumulator.errors.push({ agentType, path: resolve(path), message: errorMessage(error) })
}

function skillId(registration: SkillRegistration): string {
  const digest = createHash('sha256')
    .update([
      registration.agentType,
      registration.scope,
      registration.projectPath ?? '',
      registration.format,
      resolve(registration.documentPath)
    ].join('\0'))
    .digest('hex')
    .slice(0, 32)
  return `skill:${digest}`
}

function documentIdentity(details: Stats): DocumentIdentity {
  return {
    device: details.dev,
    inode: details.ino,
    sizeBytes: details.size,
    modifiedAtMs: details.mtimeMs
  }
}

function sameDocument(identity: DocumentIdentity, details: Stats): boolean {
  return identity.device === details.dev
    && identity.inode === details.ino
    && identity.sizeBytes === details.size
    && identity.modifiedAtMs === details.mtimeMs
}

async function readOpenDocument(handle: FileHandle, sizeBytes: number): Promise<string> {
  const buffer = Buffer.alloc(sizeBytes)
  const { bytesRead } = await handle.read(buffer, 0, sizeBytes, 0)
  return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead))
}

async function readDocumentHead(handle: FileHandle, sizeBytes: number): Promise<string> {
  const bytesToRead = Math.min(sizeBytes, METADATA_HEAD_BYTES)
  const buffer = Buffer.alloc(bytesToRead)
  const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0)
  // A prefix can end halfway through a UTF-8 sequence. Display metadata is best-effort,
  // while the on-demand full preview below still requires valid UTF-8.
  return new TextDecoder('utf-8').decode(buffer.subarray(0, bytesRead))
}

async function addRegistration(
  accumulator: DiscoveryAccumulator,
  registration: SkillRegistration,
  fallbackName: string
): Promise<void> {
  const documentPath = resolve(registration.documentPath)
  let handle: FileHandle | undefined
  try {
    handle = await open(documentPath, READ_ONLY_NO_FOLLOW)
    const details = await handle.stat()
    if (!details.isFile()) return
    let fields: { name?: string; description?: string } = {}
    try {
      fields = skillMetadataFields(await readDocumentHead(handle, details.size))
    } catch (error) {
      // Metadata is optional for Oyster's read-only catalog. Keep the registration visible
      // while reporting why its display fields could not be read.
      addError(accumulator, registration.agentType, documentPath, error)
    }
    const summary: DiscoveredSkill = {
      id: skillId(registration),
      agentType: registration.agentType,
      agentDisplayName: registration.agentDisplayName,
      name: fields.name || fallbackName,
      description: fields.description,
      scope: registration.scope,
      projectPath: registration.projectPath,
      directoryPath: resolve(registration.directoryPath),
      documentPath,
      documentFileName: basename(documentPath),
      format: registration.format,
      sizeBytes: details.size,
      modifiedAt: details.mtime.toISOString()
    }
    accumulator.skills.set(summary.id, summary)
    accumulator.documentIdentities.set(summary.id, documentIdentity(details))
  } catch (error) {
    addError(accumulator, registration.agentType, documentPath, error)
  } finally {
    await handle?.close()
  }
}

async function directoryEntry(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function exactSkillDocument(directoryPath: string): Promise<string | undefined> {
  const entries = await readdir(directoryPath, { withFileTypes: true })
  const entry = entries.find((candidate) => candidate.name === 'SKILL.md')
  if (!entry || entry.isSymbolicLink() || !entry.isFile()) return undefined
  return join(directoryPath, entry.name)
}

function ignoredDirectory(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules'
}

async function scanDirectSkillChildren(
  accumulator: DiscoveryAccumulator,
  registration: Omit<SkillRegistration, 'directoryPath' | 'documentPath' | 'format'>,
  rootPath: string
): Promise<void> {
  let entries
  try {
    entries = await readdir(rootPath, { withFileTypes: true })
  } catch (error) {
    addError(accumulator, registration.agentType, rootPath, error)
    return
  }

  for (const entry of entries) {
    if (ignoredDirectory(entry.name)) continue
    const directoryPath = join(rootPath, entry.name)
    if (!entry.isDirectory() && !(entry.isSymbolicLink() && await directoryEntry(directoryPath))) continue
    try {
      const documentPath = await exactSkillDocument(directoryPath)
      if (!documentPath) continue
      await addRegistration(accumulator, {
        ...registration,
        directoryPath,
        documentPath,
        format: 'agent_skill'
      }, entry.name)
    } catch (error) {
      addError(accumulator, registration.agentType, directoryPath, error)
    }
  }
}

async function scanRecursiveSkillRoot(
  accumulator: DiscoveryAccumulator,
  registration: Omit<SkillRegistration, 'directoryPath' | 'documentPath' | 'format'>,
  rootPath: string
): Promise<void> {
  const visited = new Set<string>()

  const visit = async (directoryPath: string): Promise<void> => {
    let physicalPath: string
    let entries
    try {
      physicalPath = await realpath(directoryPath)
      if (visited.has(physicalPath)) return
      visited.add(physicalPath)
      entries = await readdir(directoryPath, { withFileTypes: true })
    } catch (error) {
      addError(accumulator, registration.agentType, directoryPath, error)
      return
    }

    const document = entries.find((entry) => entry.name === 'SKILL.md')
    if (document && document.isFile() && !document.isSymbolicLink()) {
      await addRegistration(accumulator, {
        ...registration,
        directoryPath,
        documentPath: join(directoryPath, document.name),
        format: 'agent_skill'
      }, basename(directoryPath))
      return
    }

    for (const entry of entries) {
      if (ignoredDirectory(entry.name)) continue
      const childPath = join(directoryPath, entry.name)
      if (entry.isDirectory() || (entry.isSymbolicLink() && await directoryEntry(childPath))) {
        await visit(childPath)
      }
    }
  }

  await visit(rootPath)
}

async function scanLegacyMarkdownTree(
  accumulator: DiscoveryAccumulator,
  registration: Omit<SkillRegistration, 'directoryPath' | 'documentPath' | 'format'>,
  rootPath: string
): Promise<void> {
  const visited = new Set<string>()

  const visit = async (directoryPath: string): Promise<void> => {
    let physicalPath: string
    let entries
    try {
      physicalPath = await realpath(directoryPath)
      if (visited.has(physicalPath)) return
      visited.add(physicalPath)
      entries = await readdir(directoryPath, { withFileTypes: true })
    } catch (error) {
      addError(accumulator, registration.agentType, directoryPath, error)
      return
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const entryPath = join(directoryPath, entry.name)
      if (entry.isDirectory() || (entry.isSymbolicLink() && await directoryEntry(entryPath))) {
        await visit(entryPath)
        continue
      }
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.md')) continue
      const relativeName = relative(rootPath, entryPath).slice(0, -'.md'.length).split(sep).join(':')
      await addRegistration(accumulator, {
        ...registration,
        directoryPath,
        documentPath: entryPath,
        format: 'legacy_markdown'
      }, relativeName)
    }
  }

  await visit(rootPath)
}

async function scanNativeRootMarkdown(
  accumulator: DiscoveryAccumulator,
  registration: Omit<SkillRegistration, 'directoryPath' | 'documentPath' | 'format'>,
  rootPath: string
): Promise<void> {
  let entries
  try {
    entries = await readdir(rootPath, { withFileTypes: true })
  } catch (error) {
    addError(accumulator, registration.agentType, rootPath, error)
    return
  }
  for (const entry of entries) {
    if (
      entry.name === 'SKILL.md'
      || entry.name.startsWith('.')
      || !entry.name.endsWith('.md')
      || !entry.isFile()
      || entry.isSymbolicLink()
    ) continue
    await addRegistration(accumulator, {
      ...registration,
      directoryPath: rootPath,
      documentPath: join(rootPath, entry.name),
      format: 'legacy_markdown'
    }, entry.name.slice(0, -'.md'.length))
  }
}

async function findGitRoot(directoryPath: string): Promise<string | undefined> {
  let current = resolve(directoryPath)
  while (true) {
    try {
      await lstat(join(current, '.git'))
      return current
    } catch (error) {
      if (!missingPath(error)) return undefined
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

function ancestorsTo(directoryPath: string, boundary?: string): string[] {
  const directories: string[] = []
  let current = resolve(directoryPath)
  const stop = boundary && resolve(boundary)
  while (true) {
    directories.push(current)
    if (current === stop) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return directories
}

function configuredRoot(value: string | undefined, fallback: string, homeDirectory: string): string {
  if (!value) return resolve(fallback)
  if (value === '~') return resolve(homeDirectory)
  if (value.startsWith('~/')) return resolve(homeDirectory, value.slice(2))
  return resolve(value)
}

export class SkillDiscoveryService {
  private snapshotValue: SkillDiscoverySnapshot = { skills: [], errors: [] }
  private catalog = new Map<string, DiscoveredSkill>()
  private documentIdentities = new Map<string, DocumentIdentity>()

  constructor(
    private readonly context: DetectionContext,
    private readonly getProjectPaths: ProjectPathGetter,
    private readonly codexAdminRoot = DEFAULT_CODEX_ADMIN_ROOT
  ) {}

  getSnapshot(): SkillDiscoverySnapshot {
    return clone(this.snapshotValue)
  }

  async discover(): Promise<SkillDiscoverySnapshot> {
    const accumulator: DiscoveryAccumulator = {
      skills: new Map(),
      documentIdentities: new Map(),
      errors: []
    }
    const projectPaths = [...new Set((await this.getProjectPaths())
      .filter((path): path is string => typeof path === 'string' && isAbsolute(path))
      .map((path) => resolve(path)))]

    await Promise.all([
      this.discoverClaude(accumulator, projectPaths),
      this.discoverPi(accumulator, projectPaths),
      this.discoverCodex(accumulator, projectPaths)
    ])

    const agentOrder = new Map<AgentType, number>([['claude', 0], ['pi', 1], ['codex', 2]])
    const skills = [...accumulator.skills.values()].sort((left, right) => (
      (agentOrder.get(left.agentType) ?? 99) - (agentOrder.get(right.agentType) ?? 99)
      || left.name.localeCompare(right.name)
      || left.directoryPath.localeCompare(right.directoryPath)
    ))
    const errors = [...new Map(accumulator.errors.map((entry) => [
      `${entry.agentType}\0${entry.path}\0${entry.message}`,
      entry
    ])).values()].sort((left, right) => (
      (agentOrder.get(left.agentType) ?? 99) - (agentOrder.get(right.agentType) ?? 99)
      || left.path.localeCompare(right.path)
    ))

    this.catalog = new Map(skills.map((skill) => [skill.id, skill]))
    this.documentIdentities = new Map(skills.map((skill) => [
      skill.id,
      accumulator.documentIdentities.get(skill.id)!
    ]))
    this.snapshotValue = { skills, errors, scannedAt: new Date().toISOString() }
    return this.getSnapshot()
  }

  private async discoverClaude(
    accumulator: DiscoveryAccumulator,
    projectPaths: readonly string[]
  ): Promise<void> {
    const configRoot = configuredRoot(
      this.context.environment.CLAUDE_CONFIG_DIR,
      join(this.context.homeDirectory, '.claude'),
      this.context.homeDirectory
    )
    const user = { agentType: 'claude' as const, agentDisplayName: 'Claude Code', scope: 'user' as const }
    await Promise.all([
      scanDirectSkillChildren(accumulator, user, join(configRoot, 'skills')),
      scanLegacyMarkdownTree(accumulator, user, join(configRoot, 'commands'))
    ])

    await Promise.all(projectPaths.map(async (projectPath) => {
      const gitRoot = await findGitRoot(projectPath)
      const directories = gitRoot ? ancestorsTo(projectPath, gitRoot) : [projectPath]
      await Promise.all(directories.flatMap((directory) => {
        const registration = {
          agentType: 'claude' as const,
          agentDisplayName: 'Claude Code',
          scope: 'project' as const,
          projectPath: directory
        }
        return [
          scanDirectSkillChildren(accumulator, registration, join(directory, '.claude', 'skills')),
          scanLegacyMarkdownTree(accumulator, registration, join(directory, '.claude', 'commands'))
        ]
      }))
    }))
  }

  private async discoverPi(
    accumulator: DiscoveryAccumulator,
    projectPaths: readonly string[]
  ): Promise<void> {
    const agentRoot = configuredRoot(
      this.context.environment.PI_CODING_AGENT_DIR,
      join(this.context.homeDirectory, '.pi', 'agent'),
      this.context.homeDirectory
    )
    const nativeUserRoot = join(agentRoot, 'skills')
    const user = { agentType: 'pi' as const, agentDisplayName: 'Pi', scope: 'user' as const }
    await Promise.all([
      scanRecursiveSkillRoot(accumulator, user, nativeUserRoot),
      scanNativeRootMarkdown(accumulator, user, nativeUserRoot),
      scanRecursiveSkillRoot(accumulator, user, join(this.context.homeDirectory, '.agents', 'skills'))
    ])

    await Promise.all(projectPaths.map(async (projectPath) => {
      const nativeRegistration = {
        agentType: 'pi' as const,
        agentDisplayName: 'Pi',
        scope: 'project' as const,
        projectPath
      }
      const nativeRoot = join(projectPath, '.pi', 'skills')
      await Promise.all([
        scanRecursiveSkillRoot(accumulator, nativeRegistration, nativeRoot),
        scanNativeRootMarkdown(accumulator, nativeRegistration, nativeRoot)
      ])

      const gitRoot = await findGitRoot(projectPath)
      const userAgentsSkillsRoot = resolve(this.context.homeDirectory, '.agents', 'skills')
      const directories = ancestorsTo(projectPath, gitRoot).filter((directory) => (
        resolve(directory, '.agents', 'skills') !== userAgentsSkillsRoot
      ))
      await Promise.all(directories.map((directory) => scanRecursiveSkillRoot(accumulator, {
        agentType: 'pi' as const,
        agentDisplayName: 'Pi',
        scope: 'project' as const,
        projectPath: directory
      }, join(directory, '.agents', 'skills'))))
    }))
  }

  private async discoverCodex(
    accumulator: DiscoveryAccumulator,
    projectPaths: readonly string[]
  ): Promise<void> {
    const codexHome = configuredRoot(
      this.context.environment.CODEX_HOME,
      join(this.context.homeDirectory, '.codex'),
      this.context.homeDirectory
    )
    await Promise.all([
      scanDirectSkillChildren(accumulator, {
        agentType: 'codex', agentDisplayName: 'Codex', scope: 'user'
      }, join(this.context.homeDirectory, '.agents', 'skills')),
      scanDirectSkillChildren(accumulator, {
        agentType: 'codex', agentDisplayName: 'Codex', scope: 'user'
      }, join(codexHome, 'skills')),
      scanDirectSkillChildren(accumulator, {
        agentType: 'codex', agentDisplayName: 'Codex', scope: 'system'
      }, join(codexHome, 'skills', '.system')),
      scanDirectSkillChildren(accumulator, {
        agentType: 'codex', agentDisplayName: 'Codex', scope: 'admin'
      }, this.codexAdminRoot)
    ])

    await Promise.all(projectPaths.map(async (projectPath) => {
      const gitRoot = await findGitRoot(projectPath)
      const directories = gitRoot ? ancestorsTo(projectPath, gitRoot) : [projectPath]
      await Promise.all(directories.map((directory) => scanDirectSkillChildren(accumulator, {
        agentType: 'codex' as const,
        agentDisplayName: 'Codex',
        scope: 'project' as const,
        projectPath: directory
      }, join(directory, '.agents', 'skills'))))
    }))
  }

  private requireSkill(skillId: string): DiscoveredSkill {
    if (typeof skillId !== 'string' || !/^skill:[a-f0-9]{32}$/.test(skillId)) {
      throw new Error('Skill ID 无效')
    }
    const skill = this.catalog.get(skillId)
    if (!skill) throw new Error('Skill 不存在或需要重新发现')
    return skill
  }

  async readDocument(skillId: string): Promise<SkillDocument> {
    const skill = this.requireSkill(skillId)
    const expectedIdentity = this.documentIdentities.get(skill.id)
    if (!expectedIdentity) throw new Error('Skill 不存在或需要重新发现')
    let handle: FileHandle | undefined
    try {
      handle = await open(skill.documentPath, READ_ONLY_NO_FOLLOW)
    } catch (error) {
      if (missingPath(error)) throw new Error('Skill 文档已不存在，请重新发现')
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
        throw new Error('Skill 文档不再是可读取的普通文件')
      }
      throw error
    }
    try {
      const details = await handle.stat()
      if (!details.isFile()) throw new Error('Skill 文档不再是可读取的普通文件')
      if (!sameDocument(expectedIdentity, details)) {
        throw new Error('Skill 文档在发现后已变化，请重新发现')
      }
      if (details.size > MAX_PREVIEW_BYTES) {
        throw new Error('Skill 文档超过 2 MiB，无法在应用内预览')
      }
      const content = await readOpenDocument(handle, details.size)
      const detailsAfterRead = await handle.stat()
      if (!sameDocument(expectedIdentity, detailsAfterRead)) {
        throw new Error('Skill 文档在预览时发生变化，请重新发现')
      }
      return {
        skillId: skill.id,
        documentPath: skill.documentPath,
        fileName: skill.documentFileName,
        content,
        sizeBytes: details.size,
        modifiedAt: details.mtime.toISOString()
      }
    } finally {
      await handle.close()
    }
  }

  async getSkillFolderPath(skillId: string): Promise<string> {
    const skill = this.requireSkill(skillId)
    try {
      if (!(await stat(skill.directoryPath)).isDirectory()) {
        throw new Error('Skill 原始文件夹已不存在，请重新发现')
      }
    } catch (error) {
      if (missingPath(error)) throw new Error('Skill 原始文件夹已不存在，请重新发现')
      throw error
    }
    return skill.directoryPath
  }
}

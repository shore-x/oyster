import { constants } from 'node:fs'
import { access, lstat, open, opendir, readFile, stat } from 'node:fs/promises'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { HistoryArtifact, InstructionScope } from '../../shared/discovery'
import type {
  AgentHistoryAdapter,
  ArtifactCandidate,
  DetectionContext,
  DetectionResult,
  ScanEntry
} from './model'

const HEAD_LIMIT_BYTES = 96 * 1024

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

function stringValue(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0)
}

function isoValue(...values: unknown[]): string | undefined {
  const value = values.find((candidate) => typeof candidate === 'string' || typeof candidate === 'number')
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString()
}

function contentText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return undefined
  const parts = value.flatMap((item) => {
    const block = asRecord(item)
    const text = stringValue(block?.text, block?.content)
    return text ? [text] : []
  })
  return parts.length ? parts.join(' ') : undefined
}

function titlePreview(value: unknown): string | undefined {
  const text = contentText(value)?.replace(/\s+/g, ' ').trim()
  if (!text) return undefined
  const characters = Array.from(text)
  return characters.length > 80 ? `${characters.slice(0, 80).join('')}…` : text
}

function claudeUserTitle(records: Record<string, unknown>[]): string | undefined {
  for (const record of records) {
    if (record.type !== 'user') continue
    const message = asRecord(record.message)
    const title = titlePreview(message?.content ?? record.content ?? record.message)
    if (title) return title
  }
  return undefined
}

function piUserTitle(records: Record<string, unknown>[]): string | undefined {
  for (const record of records) {
    if (record.type !== 'message') continue
    const message = asRecord(record.message)
    if (record.role !== 'user' && message?.role !== 'user') continue
    const title = titlePreview(record.content ?? message?.content)
    if (title) return title
  }
  return undefined
}

function codexUserTitle(records: Record<string, unknown>[]): string | undefined {
  for (const record of records) {
    if (record.type !== 'response_item') continue
    const payload = asRecord(record.payload)
    if (payload?.role !== 'user') continue
    const title = titlePreview(payload.content)
    if (title) return title
  }
  return undefined
}

async function readJsonLinesHead(filePath: string): Promise<Record<string, unknown>[]> {
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(HEAD_LIMIT_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    const lines = text.split(/\r?\n/)
    if (bytesRead === buffer.length) lines.pop()
    const records: Record<string, unknown>[] = []
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const record = asRecord(JSON.parse(line))
        if (record) records.push(record)
      } catch {
        // A malformed event does not invalidate a session when its header is readable.
      }
    }
    return records
  } finally {
    await handle.close()
  }
}

async function* walkJsonl(rootPath: string, signal: AbortSignal): AsyncGenerator<string> {
  signal.throwIfAborted()
  const directory = await opendir(rootPath)
  for await (const entry of directory) {
    signal.throwIfAborted()
    if (entry.isSymbolicLink()) continue
    const entryPath = join(rootPath, entry.name)
    if (entry.isDirectory()) {
      yield* walkJsonl(entryPath, signal)
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) {
      yield entryPath
    }
  }
}

async function* walkMarkdown(rootPath: string, signal: AbortSignal): AsyncGenerator<string> {
  signal.throwIfAborted()
  let directory
  try {
    directory = await opendir(rootPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for await (const entry of directory) {
    signal.throwIfAborted()
    if (entry.isSymbolicLink()) continue
    const entryPath = join(rootPath, entry.name)
    if (entry.isDirectory()) {
      yield* walkMarkdown(entryPath, signal)
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      yield entryPath
    }
  }
}

function safeResolve(rootPath: string, relativePath: string): string {
  const root = resolve(rootPath)
  const target = resolve(root, relativePath)
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error('Session path escapes the configured history directory')
  }
  return target
}

async function findExecutable(context: DetectionContext, name: string): Promise<string | undefined> {
  const candidates = [
    ...context.pathEntries.map((entry) => join(entry, name)),
    join('/opt/homebrew/bin', name),
    join('/usr/local/bin', name)
  ]
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // Continue looking through PATH.
    }
  }
  return undefined
}

async function detectDirectory(
  context: DetectionContext,
  rootPath: string,
  executableName: string
): Promise<DetectionResult> {
  const executablePath = await findExecutable(context, executableName)
  try {
    const metadata = await stat(rootPath)
    await access(rootPath, constants.R_OK)
    return { rootPath, found: metadata.isDirectory(), executablePath }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { rootPath, found: false, executablePath }
    if (code === 'EACCES' || code === 'EPERM') {
      return { rootPath, found: true, executablePath, permissionDenied: true }
    }
    return { rootPath, found: false, executablePath, errorMessage: (error as Error).message }
  }
}

function candidateFromFile(
  rootPath: string,
  filePath: string,
  externalId: string,
  metadata: { size: number; mtime: Date },
  extra: Partial<ArtifactCandidate> = {}
): ArtifactCandidate {
  return {
    kind: 'conversation',
    externalId,
    relativePath: relative(rootPath, filePath),
    sourcePath: resolve(filePath),
    sizeBytes: metadata.size,
    modifiedAt: metadata.mtime.toISOString(),
    ...extra
  }
}

function displayPath(rootPath: string, filePath: string): string {
  const root = resolve(rootPath)
  const target = resolve(filePath)
  return target === root || target.startsWith(`${root}${sep}`) ? relative(root, target) : target
}

function isWithinPath(rootPath: string, filePath: string): boolean {
  const root = resolve(rootPath)
  const target = resolve(filePath)
  return target === root || target.startsWith(`${root}${sep}`)
}

function parentOfNamedAncestor(filePath: string, directoryName: string): string | undefined {
  let current = resolve(filePath)
  while (true) {
    if (basename(current) === directoryName) return dirname(current)
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

async function instructionCandidate(
  rootPath: string,
  filePath: string,
  instructionScope: InstructionScope,
  projectPath?: string
): Promise<ArtifactCandidate | undefined> {
  try {
    const metadata = await lstat(filePath)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0) return undefined
    const sourcePath = resolve(filePath)
    return {
      kind: 'human_instruction',
      externalId: `instruction:${sourcePath}`,
      relativePath: displayPath(rootPath, sourcePath),
      sourcePath,
      title: basename(sourcePath),
      projectPath,
      instructionScope,
      sizeBytes: metadata.size,
      modifiedAt: metadata.mtime.toISOString(),
      updatedAt: metadata.mtime.toISOString()
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM') return undefined
    throw error
  }
}

async function* instructionCandidates(
  rootPath: string,
  paths: Iterable<{ path: string; scope: InstructionScope; projectPath?: string }>,
  seen: Set<string>,
  signal: AbortSignal
): AsyncGenerator<ScanEntry> {
  for (const entry of paths) {
    signal.throwIfAborted()
    const candidate = await instructionCandidate(rootPath, entry.path, entry.scope, entry.projectPath)
    if (!candidate || seen.has(candidate.sourcePath)) continue
    seen.add(candidate.sourcePath)
    yield { kind: 'artifact', candidate }
  }
}

function ancestorDirectories(directoryPath: string, stopAt?: string): string[] {
  if (!isAbsolute(directoryPath)) return []
  const directories: string[] = []
  let current = resolve(directoryPath)
  const boundary = stopAt ? resolve(stopAt) : undefined
  while (true) {
    directories.push(current)
    if (current === boundary) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return directories.reverse()
}

async function findGitRoot(directoryPath: string): Promise<string | undefined> {
  let current = resolve(directoryPath)
  while (true) {
    try {
      await lstat(join(current, '.git'))
      return current
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

async function firstInstructionCandidate(
  rootPath: string,
  paths: string[],
  scope: InstructionScope,
  projectPath?: string
): Promise<ArtifactCandidate | undefined> {
  for (const filePath of paths) {
    const candidate = await instructionCandidate(rootPath, filePath, scope, projectPath)
    if (candidate) return candidate
  }
  return undefined
}

async function codexFallbackNames(rootPath: string): Promise<string[]> {
  try {
    const content = await readFile(join(rootPath, 'config.toml'), 'utf8')
    const value = content.match(/^\s*project_doc_fallback_filenames\s*=\s*\[([^\]]*)\]/m)?.[1]
    if (!value) return []
    return [...value.matchAll(/["']([^"']+)["']/g)]
      .map((match) => match[1])
      .filter((name) => basename(name) === name && name !== 'AGENTS.md' && name !== 'AGENTS.override.md')
  } catch {
    return []
  }
}

function resolveArtifactPath(rootPath: string, artifact: HistoryArtifact): string {
  if (artifact.kind === 'conversation') return safeResolve(rootPath, artifact.relativePath)
  if (!artifact.sourcePath || !isAbsolute(artifact.sourcePath)) {
    throw new Error('Instruction artifact is missing its absolute source path')
  }
  return resolve(artifact.sourcePath)
}

export class ClaudeHistoryAdapter implements AgentHistoryAdapter {
  readonly agentType = 'claude' as const
  readonly displayName = 'Claude Code'

  defaultRoot(context: DetectionContext): string {
    const configRoot = context.environment.CLAUDE_CONFIG_DIR || join(context.homeDirectory, '.claude')
    return join(configRoot, 'projects')
  }

  detect(context: DetectionContext, rootOverride?: string): Promise<DetectionResult> {
    return detectDirectory(context, rootOverride || this.defaultRoot(context), 'claude')
  }

  resolveArtifactPath(rootPath: string, artifact: HistoryArtifact): string {
    return resolveArtifactPath(rootPath, artifact)
  }

  async *scan(
    rootPath: string,
    signal: AbortSignal,
    context?: DetectionContext
  ): AsyncGenerator<ScanEntry> {
    const projectPaths = new Set<string>()
    for await (const filePath of walkJsonl(rootPath, signal)) {
      const metadata = await stat(filePath)
      const records = await readJsonLinesHead(filePath)
      const header = records.find((record) => stringValue(record.sessionId, record.session_id))
      const externalId = header && stringValue(header.sessionId, header.session_id)
      if (!header || !externalId) {
        yield { kind: 'invalid', relativePath: relative(rootPath, filePath), sizeBytes: metadata.size }
        continue
      }
      const message = asRecord(header.message)
      yield {
        kind: 'artifact',
        candidate: candidateFromFile(rootPath, filePath, externalId, metadata, {
          title: stringValue(
            header.slug,
            titlePreview(message?.content),
            claudeUserTitle(records),
            basename(filePath, '.jsonl')
          ),
          projectPath: stringValue(header.cwd, header.projectPath),
          startedAt: isoValue(header.timestamp),
          updatedAt: metadata.mtime.toISOString()
        })
      }
      const projectPath = stringValue(header.cwd, header.projectPath)
      if (projectPath && isAbsolute(projectPath)) projectPaths.add(projectPath)
    }

    const seen = new Set<string>()
    const configuredRoot = context
      ? context.environment.CLAUDE_CONFIG_DIR || join(context.homeDirectory, '.claude')
      : undefined
    const configRoot =
      (configuredRoot && isWithinPath(configuredRoot, rootPath) ? configuredRoot : undefined) ||
      parentOfNamedAncestor(rootPath, 'projects') ||
      configuredRoot ||
      dirname(resolve(rootPath))
    const globalPaths = [
      { path: join(configRoot, 'CLAUDE.md'), scope: 'user' as const },
      { path: '/Library/Application Support/ClaudeCode/CLAUDE.md', scope: 'managed' as const },
      { path: '/etc/claude-code/CLAUDE.md', scope: 'managed' as const }
    ]
    yield* instructionCandidates(rootPath, globalPaths, seen, signal)
    for await (const filePath of walkMarkdown(join(configRoot, 'rules'), signal)) {
      yield* instructionCandidates(rootPath, [{ path: filePath, scope: 'user' }], seen, signal)
    }

    for (const projectPath of projectPaths) {
      const paths: { path: string; scope: InstructionScope; projectPath?: string }[] = []
      for (const directory of ancestorDirectories(projectPath)) {
        paths.push(
          { path: join(directory, 'CLAUDE.md'), scope: 'project', projectPath },
          { path: join(directory, 'CLAUDE.local.md'), scope: 'project', projectPath },
          { path: join(directory, '.claude', 'CLAUDE.md'), scope: 'project', projectPath }
        )
      }
      yield* instructionCandidates(rootPath, paths, seen, signal)
      const gitRoot = await findGitRoot(projectPath)
      const rulesRoot = join(gitRoot || projectPath, '.claude', 'rules')
      for await (const filePath of walkMarkdown(rulesRoot, signal)) {
        yield* instructionCandidates(
          rootPath,
          [{ path: filePath, scope: 'project', projectPath }],
          seen,
          signal
        )
      }
    }
  }
}

export class PiHistoryAdapter implements AgentHistoryAdapter {
  readonly agentType = 'pi' as const
  readonly displayName = 'Pi'

  defaultRoot(context: DetectionContext): string {
    return (
      context.environment.PI_CODING_AGENT_SESSION_DIR ||
      join(context.environment.PI_CODING_AGENT_DIR || join(context.homeDirectory, '.pi', 'agent'), 'sessions')
    )
  }

  async detect(context: DetectionContext, rootOverride?: string): Promise<DetectionResult> {
    const defaultRoot = this.defaultRoot(context)
    let rootPath = rootOverride || defaultRoot
    const isDefaultCandidate = !rootOverride || rootOverride === defaultRoot
    if (isDefaultCandidate && !context.environment.PI_CODING_AGENT_SESSION_DIR) {
      const agentRoot = context.environment.PI_CODING_AGENT_DIR || join(context.homeDirectory, '.pi', 'agent')
      try {
        const settings = asRecord(JSON.parse(await readFile(join(agentRoot, 'settings.json'), 'utf8')))
        const configuredRoot = stringValue(settings?.sessionDir)
        if (configuredRoot) {
          rootPath = configuredRoot.startsWith('~/')
            ? join(context.homeDirectory, configuredRoot.slice(2))
            : isAbsolute(configuredRoot)
              ? configuredRoot
              : resolve(agentRoot, configuredRoot)
        }
      } catch {
        // A missing, malformed, or locked settings file falls back to the documented root.
      }
    }
    return detectDirectory(context, rootPath, 'pi')
  }

  resolveArtifactPath(rootPath: string, artifact: HistoryArtifact): string {
    return resolveArtifactPath(rootPath, artifact)
  }

  async *scan(
    rootPath: string,
    signal: AbortSignal,
    context?: DetectionContext
  ): AsyncGenerator<ScanEntry> {
    const projectPaths = new Set<string>()
    for await (const filePath of walkJsonl(rootPath, signal)) {
      const metadata = await stat(filePath)
      const records = await readJsonLinesHead(filePath)
      const header = records.find((record) => record.type === 'session')
      const externalId = header && stringValue(header.id, header.sessionId, header.session_id)
      if (!header || !externalId) {
        yield { kind: 'invalid', relativePath: relative(rootPath, filePath), sizeBytes: metadata.size }
        continue
      }
      yield {
        kind: 'artifact',
        candidate: candidateFromFile(rootPath, filePath, externalId, metadata, {
          title: stringValue(header.title, piUserTitle(records), basename(filePath, '.jsonl')),
          projectPath: stringValue(header.cwd, header.projectPath),
          startedAt: isoValue(header.timestamp, header.createdAt),
          updatedAt: metadata.mtime.toISOString()
        })
      }
      const projectPath = stringValue(header.cwd, header.projectPath)
      if (projectPath && isAbsolute(projectPath)) projectPaths.add(projectPath)
    }

    const seen = new Set<string>()
    const configuredAgentRoot = context
      ? context.environment.PI_CODING_AGENT_DIR || join(context.homeDirectory, '.pi', 'agent')
      : undefined
    const agentRoot =
      (configuredAgentRoot && isWithinPath(configuredAgentRoot, rootPath) ? configuredAgentRoot : undefined) ||
      (basename(resolve(rootPath)) === 'sessions' ? dirname(resolve(rootPath)) : undefined) ||
      configuredAgentRoot ||
      dirname(resolve(rootPath))
    yield* instructionCandidates(
      rootPath,
      [
        { path: join(agentRoot, 'AGENTS.md'), scope: 'user' },
        { path: join(agentRoot, 'CLAUDE.md'), scope: 'user' },
        { path: join(agentRoot, 'SYSTEM.md'), scope: 'user' },
        { path: join(agentRoot, 'APPEND_SYSTEM.md'), scope: 'user' }
      ],
      seen,
      signal
    )

    for (const projectPath of projectPaths) {
      const paths: { path: string; scope: InstructionScope; projectPath?: string }[] = []
      for (const directory of ancestorDirectories(projectPath)) {
        paths.push(
          { path: join(directory, 'AGENTS.md'), scope: 'project', projectPath },
          { path: join(directory, 'CLAUDE.md'), scope: 'project', projectPath }
        )
      }
      paths.push(
        { path: join(projectPath, '.pi', 'SYSTEM.md'), scope: 'project', projectPath },
        { path: join(projectPath, '.pi', 'APPEND_SYSTEM.md'), scope: 'project', projectPath }
      )
      yield* instructionCandidates(rootPath, paths, seen, signal)
    }
  }
}

export class CodexHistoryAdapter implements AgentHistoryAdapter {
  readonly agentType = 'codex' as const
  readonly displayName = 'Codex'

  defaultRoot(context: DetectionContext): string {
    return context.environment.CODEX_HOME || join(context.homeDirectory, '.codex')
  }

  detect(context: DetectionContext, rootOverride?: string): Promise<DetectionResult> {
    return detectDirectory(context, rootOverride || this.defaultRoot(context), 'codex')
  }

  resolveArtifactPath(rootPath: string, artifact: HistoryArtifact): string {
    return resolveArtifactPath(rootPath, artifact)
  }

  async *scan(rootPath: string, signal: AbortSignal): AsyncGenerator<ScanEntry> {
    const visited = new Set<string>()
    const projectPaths = new Set<string>()
    for (const folder of ['sessions', 'archived_sessions']) {
      const scanRoot = join(rootPath, folder)
      try {
        for await (const filePath of walkJsonl(scanRoot, signal)) {
          const metadata = await stat(filePath)
          const records = await readJsonLinesHead(filePath)
          const header = records.find((record) => record.type === 'session_meta')
          const payload = header && asRecord(header.payload)
          const externalId = payload && stringValue(payload.id, payload.session_id)
          if (!header || !payload || !externalId) {
            yield { kind: 'invalid', relativePath: relative(rootPath, filePath), sizeBytes: metadata.size }
            continue
          }
          if (visited.has(externalId)) continue
          visited.add(externalId)
          yield {
            kind: 'artifact',
            candidate: candidateFromFile(rootPath, filePath, externalId, metadata, {
              title: stringValue(
                payload.title,
                codexUserTitle(records),
                basename(filePath, '.jsonl')
              ),
              projectPath: stringValue(payload.cwd),
              startedAt: isoValue(payload.timestamp, header.timestamp),
              updatedAt: metadata.mtime.toISOString()
            })
          }
          const projectPath = stringValue(payload.cwd)
          if (projectPath && isAbsolute(projectPath)) projectPaths.add(projectPath)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }

    const seen = new Set<string>()
    const globalInstruction = await firstInstructionCandidate(
      rootPath,
      [join(rootPath, 'AGENTS.override.md'), join(rootPath, 'AGENTS.md')],
      'user'
    )
    if (globalInstruction) {
      seen.add(globalInstruction.sourcePath)
      yield { kind: 'artifact', candidate: globalInstruction }
    }

    const fallbackNames = await codexFallbackNames(rootPath)
    for (const projectPath of projectPaths) {
      const gitRoot = await findGitRoot(projectPath)
      const directories = ancestorDirectories(projectPath, gitRoot || projectPath)
      for (const directory of directories) {
        const candidate = await firstInstructionCandidate(
          rootPath,
          [
            join(directory, 'AGENTS.override.md'),
            join(directory, 'AGENTS.md'),
            ...fallbackNames.map((name) => join(directory, name))
          ],
          'project',
          projectPath
        )
        if (!candidate || seen.has(candidate.sourcePath)) continue
        seen.add(candidate.sourcePath)
        yield { kind: 'artifact', candidate }
      }
    }
  }
}

export function createDefaultAdapters(): AgentHistoryAdapter[] {
  return [new ClaudeHistoryAdapter(), new PiHistoryAdapter(), new CodexHistoryAdapter()]
}

export function createDetectionContext(
  homeDirectory: string,
  environment: NodeJS.ProcessEnv = process.env
): DetectionContext {
  return {
    homeDirectory,
    environment,
    pathEntries: (environment.PATH || '').split(delimiter).filter((entry) => entry && isAbsolute(entry))
  }
}

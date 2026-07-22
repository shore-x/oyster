import { constants } from 'node:fs'
import { access, open, opendir, readFile, stat } from 'node:fs/promises'
import { basename, delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  AgentHistoryAdapter,
  DetectionContext,
  DetectionResult,
  ScanEntry,
  SessionCandidate
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
  extra: Partial<SessionCandidate> = {}
): SessionCandidate {
  return {
    externalId,
    relativePath: relative(rootPath, filePath),
    sizeBytes: metadata.size,
    modifiedAt: metadata.mtime.toISOString(),
    ...extra
  }
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

  resolveSessionPath(rootPath: string, relativePath: string): string {
    return safeResolve(rootPath, relativePath)
  }

  async *scan(rootPath: string, signal: AbortSignal): AsyncGenerator<ScanEntry> {
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
        kind: 'session',
        candidate: candidateFromFile(rootPath, filePath, externalId, metadata, {
          title: stringValue(header.slug, message?.content, basename(filePath, '.jsonl')),
          projectPath: stringValue(header.cwd, header.projectPath),
          startedAt: isoValue(header.timestamp),
          updatedAt: metadata.mtime.toISOString()
        })
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

  resolveSessionPath(rootPath: string, relativePath: string): string {
    return safeResolve(rootPath, relativePath)
  }

  async *scan(rootPath: string, signal: AbortSignal): AsyncGenerator<ScanEntry> {
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
        kind: 'session',
        candidate: candidateFromFile(rootPath, filePath, externalId, metadata, {
          title: stringValue(header.title, basename(filePath, '.jsonl')),
          projectPath: stringValue(header.cwd, header.projectPath),
          startedAt: isoValue(header.timestamp, header.createdAt),
          updatedAt: metadata.mtime.toISOString()
        })
      }
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

  resolveSessionPath(rootPath: string, relativePath: string): string {
    return safeResolve(rootPath, relativePath)
  }

  async *scan(rootPath: string, signal: AbortSignal): AsyncGenerator<ScanEntry> {
    const visited = new Set<string>()
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
            kind: 'session',
            candidate: candidateFromFile(rootPath, filePath, externalId, metadata, {
              title: stringValue(payload.title, basename(filePath, '.jsonl')),
              projectPath: stringValue(payload.cwd),
              startedAt: isoValue(payload.timestamp, header.timestamp),
              updatedAt: metadata.mtime.toISOString()
            })
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
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

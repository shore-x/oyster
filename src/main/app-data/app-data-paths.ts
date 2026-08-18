import { lstat, mkdir, readdir, rename, rmdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { runArtifactGit } from '../artifacts/git-runtime'

export interface AppDataPaths {
  rootPath: string
  repositoryPath: string
  configPath: string
  appSettingsPath: string
  aiConnectionsPath: string
  knowledgeProcessingPath: string
  chatAgentPath: string
  piAgentPath: string
  statePath: string
  discoveryStatePath: string
  chatConversationsPath: string
  runtimePath: string
  worktreesPath: string
  agentRuntimePath: string
  fixtureHomePath: string
  diagnosticsPath: string
  agentDebugPath: string
  chromiumPath: string
}

export function createAppDataPaths(rootPath: string): AppDataPaths {
  const root = resolve(rootPath)
  const configPath = join(root, 'config')
  const statePath = join(root, 'state')
  const runtimePath = join(root, 'runtime')
  const diagnosticsPath = join(root, 'diagnostics')
  return {
    rootPath: root,
    repositoryPath: join(root, 'repository'),
    configPath,
    appSettingsPath: join(configPath, 'app-settings.json'),
    aiConnectionsPath: join(configPath, 'ai-connections.json'),
    knowledgeProcessingPath: join(configPath, 'knowledge-processing.json'),
    chatAgentPath: join(configPath, 'chat-agent.json'),
    piAgentPath: join(configPath, 'pi-agent'),
    statePath,
    discoveryStatePath: join(statePath, 'discovery-state.json'),
    chatConversationsPath: join(statePath, 'chat-conversations'),
    runtimePath,
    worktreesPath: join(runtimePath, 'worktrees'),
    agentRuntimePath: join(runtimePath, 'agent-sessions'),
    fixtureHomePath: join(runtimePath, 'fixture-home'),
    diagnosticsPath,
    agentDebugPath: join(diagnosticsPath, 'agent-invocations'),
    chromiumPath: join(root, 'chromium')
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function moveLegacyPath(source: string, target: string): Promise<void> {
  if (!await pathExists(source)) return
  if (await pathExists(target)) {
    throw new Error(`Oyster 数据迁移存在新旧路径冲突：${source} -> ${target}`)
  }
  const details = await lstat(source)
  if (details.isSymbolicLink()) throw new Error(`Oyster 数据迁移拒绝符号链接：${source}`)
  await mkdir(dirname(target), { recursive: true })
  await rename(source, target)
}

async function removeEmptyDirectory(path: string): Promise<void> {
  try {
    await rmdir(path)
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
  }
}

async function moveLegacyWorktrees(paths: AppDataPaths): Promise<void> {
  const legacyRoot = join(paths.rootPath, 'worktrees')
  if (!await pathExists(legacyRoot)) return
  const details = await lstat(legacyRoot)
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`Oyster 旧 worktrees 路径不是本地真实目录：${legacyRoot}`)
  }
  await mkdir(paths.worktreesPath, { recursive: true })
  for (const entry of await readdir(legacyRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`Oyster 旧 worktrees 包含无法迁移的项目：${entry.name}`)
    }
    const source = join(legacyRoot, entry.name)
    const target = join(paths.worktreesPath, entry.name)
    if (await pathExists(target)) {
      throw new Error(`Oyster worktree 迁移目标已经存在：${target}`)
    }
    await runArtifactGit(['worktree', 'move', source, target], paths.repositoryPath)
  }
  await removeEmptyDirectory(legacyRoot)
}

/** Moves only paths owned by current Oyster features; obsolete product models are cleaned separately. */
export async function migrateLegacyAppData(paths: AppDataPaths): Promise<void> {
  const root = paths.rootPath
  const moves: ReadonlyArray<readonly [string, string]> = [
    [join(root, 'app-settings.json'), paths.appSettingsPath],
    [join(root, 'ai-connections.json'), paths.aiConnectionsPath],
    [join(root, 'knowledge-processing.json'), paths.knowledgeProcessingPath],
    [join(root, 'chat-agent.json'), paths.chatAgentPath],
    [join(root, 'pi-agent'), paths.piAgentPath],
    [join(root, 'discovery-state.json'), paths.discoveryStatePath],
    [join(root, 'chat-conversations'), paths.chatConversationsPath],
    [join(root, 'agent-runtime'), paths.agentRuntimePath],
    [join(root, 'skill-fixture-home'), paths.fixtureHomePath],
    [join(root, 'agent-debug', 'invocations'), paths.agentDebugPath]
  ]
  for (const [source, target] of moves) await moveLegacyPath(source, target)
  await removeEmptyDirectory(join(root, 'agent-debug'))
  await moveLegacyWorktrees(paths)
}

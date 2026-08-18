import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createAppDataPaths,
  migrateLegacyAppData
} from '../src/main/app-data/app-data-paths'
import { KnowledgeTaskGitRepository } from '../src/main/knowledge-processing/knowledge-task-git-repository'
import { OysterRepository } from '../src/main/repository/oyster-repository'

const temporaryDirectories: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'oyster-app-data-'))
  temporaryDirectories.push(root)
  return root
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => (
    rm(path, { recursive: true, force: true })
  )))
})

describe('App data paths', () => {
  it('separates formal content, configuration, state, runtime, diagnostics, and Chromium data', async () => {
    const root = await temporaryRoot()
    const paths = createAppDataPaths(root)

    expect(paths.repositoryPath).toBe(join(root, 'repository'))
    expect(paths.aiConnectionsPath).toBe(join(root, 'config', 'ai-connections.json'))
    expect(paths.discoveryStatePath).toBe(join(root, 'state', 'discovery-state.json'))
    expect(paths.worktreesPath).toBe(join(root, 'runtime', 'worktrees'))
    expect(paths.agentRuntimePath).toBe(join(root, 'runtime', 'agent-sessions'))
    expect(paths.agentDebugPath).toBe(join(root, 'diagnostics', 'agent-invocations'))
    expect(paths.chromiumPath).toBe(join(root, 'chromium'))
  })

  it('moves legacy app-owned files without touching obsolete product-model paths', async () => {
    const root = await temporaryRoot()
    const paths = createAppDataPaths(root)
    await Promise.all([
      writeFile(join(root, 'ai-connections.json'), '{"connections":[]}\n'),
      writeFile(join(root, 'discovery-state.json'), '{"sources":[]}\n'),
      mkdir(join(root, 'agent-debug', 'invocations'), { recursive: true }),
      mkdir(join(root, 'agent-runtime', 'task-1'), { recursive: true }),
      mkdir(join(root, 'artifacts'), { recursive: true }),
      mkdir(join(root, 'raw-evidence'), { recursive: true })
    ])
    await writeFile(join(root, 'agent-debug', 'invocations', 'call.json'), '{}\n')

    await migrateLegacyAppData(paths)

    await expect(readFile(paths.aiConnectionsPath, 'utf8')).resolves.toContain('connections')
    await expect(readFile(paths.discoveryStatePath, 'utf8')).resolves.toContain('sources')
    expect(await exists(join(paths.agentDebugPath, 'call.json'))).toBe(true)
    expect(await exists(join(paths.agentRuntimePath, 'task-1'))).toBe(true)
    expect(await exists(join(root, 'ai-connections.json'))).toBe(false)
    expect(await exists(join(root, 'agent-debug'))).toBe(false)
    expect(await exists(join(root, 'artifacts'))).toBe(true)
    expect(await exists(join(root, 'raw-evidence'))).toBe(true)
  })

  it('moves registered linked worktrees with Git metadata intact', async () => {
    const root = await temporaryRoot()
    const paths = createAppDataPaths(root)
    const repository = new OysterRepository(paths.repositoryPath)
    const legacyTasks = new KnowledgeTaskGitRepository(repository)
    const worktree = await legacyTasks.createWorktree({
      taskId: 'preview-migration',
      kind: 'preview',
      plan: {
        files: [{ relativePath: 'inputs/activity.md', content: '# Activity\n' }],
        items: ['Inspect.']
      }
    })

    await migrateLegacyAppData(paths)

    const migratedPath = join(paths.worktreesPath, worktree.taskId)
    expect(await exists(worktree.worktreePath)).toBe(false)
    expect(await exists(migratedPath)).toBe(true)
    expect(await exists(join(paths.agentRuntimePath, worktree.taskId))).toBe(true)
    const gitFile = await readFile(join(migratedPath, '.git'), 'utf8')
    expect(gitFile).toContain(join(paths.repositoryPath, '.git', 'worktrees'))
  })
})

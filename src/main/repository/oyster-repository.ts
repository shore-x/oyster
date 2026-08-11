import { mkdir, lstat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { runArtifactGit } from '../artifacts/git-runtime'

export const OYSTER_TARGET_BRANCH = 'main'
export const KNOWLEDGE_DIRECTORY = 'knowledge'
export const ARTIFACTS_DIRECTORY = 'artifacts'
export const TASKS_DIRECTORY = 'tasks'

async function isMissing(error: unknown): Promise<boolean> {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/** The one application-managed Git repository containing Oyster's stable layers. */
export class OysterRepository {
  readonly rootPath: string
  readonly knowledgePath: string
  readonly artifactsPath: string
  readonly tasksPath: string

  constructor(rootPath: string) {
    this.rootPath = resolve(rootPath)
    this.knowledgePath = join(this.rootPath, KNOWLEDGE_DIRECTORY)
    this.artifactsPath = join(this.rootPath, ARTIFACTS_DIRECTORY)
    this.tasksPath = join(this.rootPath, TASKS_DIRECTORY)
  }

  private async assertRealRoot(): Promise<void> {
    const details = await lstat(this.rootPath)
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new Error('Oyster Repository 根路径必须是 APP 管理的真实目录')
    }
  }

  private async assertManagedDirectory(path: string, label: string): Promise<void> {
    const details = await lstat(path)
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new Error(`Oyster Repository 的 ${label} 必须是 APP 管理的真实目录`)
    }
  }

  private async hasGitDirectory(): Promise<boolean> {
    try {
      const details = await lstat(join(this.rootPath, '.git'))
      if (!details.isDirectory() || details.isSymbolicLink()) {
        throw new Error('Oyster Repository 的 .git 必须是本地真实目录')
      }
      return true
    } catch (error) {
      if (await isMissing(error)) return false
      throw error
    }
  }

  private async hasHead(): Promise<boolean> {
    try {
      await runArtifactGit(['rev-parse', '--verify', 'HEAD'], this.rootPath)
      return true
    } catch {
      return false
    }
  }

  async initialize(): Promise<void> {
    await mkdir(this.rootPath, { recursive: true })
    await this.assertRealRoot()
    const existingGit = await this.hasGitDirectory()
    if (!existingGit) {
      await runArtifactGit(['init', '--quiet', `--initial-branch=${OYSTER_TARGET_BRANCH}`], this.rootPath)
      await runArtifactGit(['config', 'user.name', 'Oyster'], this.rootPath)
      await runArtifactGit(['config', 'user.email', 'repository@oyster.local'], this.rootPath)
    }

    await Promise.all([
      mkdir(this.knowledgePath, { recursive: true }),
      mkdir(this.artifactsPath, { recursive: true }),
      mkdir(this.tasksPath, { recursive: true })
    ])
    await Promise.all([
      this.assertManagedDirectory(this.knowledgePath, KNOWLEDGE_DIRECTORY),
      this.assertManagedDirectory(this.artifactsPath, ARTIFACTS_DIRECTORY),
      this.assertManagedDirectory(this.tasksPath, TASKS_DIRECTORY)
    ])

    if (!await this.hasHead()) {
      await Promise.all([
        writeFile(join(this.knowledgePath, '.gitkeep'), '', { flag: 'a' }),
        writeFile(join(this.artifactsPath, '.gitkeep'), '', { flag: 'a' }),
        writeFile(join(this.tasksPath, '.gitkeep'), '', { flag: 'a' })
      ])
      await runArtifactGit([
        'add', '--', KNOWLEDGE_DIRECTORY, ARTIFACTS_DIRECTORY, TASKS_DIRECTORY
      ], this.rootPath)
      await runArtifactGit([
        'commit', '--quiet', '--no-gpg-sign', '-m', 'Initialize Oyster repository'
      ], this.rootPath)
    }
  }
}

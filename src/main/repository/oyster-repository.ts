import { mkdir, lstat, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { runArtifactGit } from '../artifacts/git-runtime'

export const OYSTER_TARGET_BRANCH = 'main'
export const KNOWLEDGE_DIRECTORY = 'knowledge'
export const ARTIFACTS_DIRECTORY = 'artifacts'
export const RUNS_DIRECTORY = 'runs'

const INITIAL_GITIGNORE = `/${RUNS_DIRECTORY}/\n`

async function isMissing(error: unknown): Promise<boolean> {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/** The one application-managed Git repository containing Oyster's stable layers. */
export class OysterRepository {
  readonly rootPath: string
  readonly knowledgePath: string
  readonly artifactsPath: string
  readonly runsPath: string

  constructor(rootPath: string) {
    this.rootPath = resolve(rootPath)
    this.knowledgePath = join(this.rootPath, KNOWLEDGE_DIRECTORY)
    this.artifactsPath = join(this.rootPath, ARTIFACTS_DIRECTORY)
    this.runsPath = join(this.rootPath, RUNS_DIRECTORY)
  }

  private async assertRealRoot(): Promise<void> {
    const details = await lstat(this.rootPath)
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new Error('Oyster Repository 根路径必须是 APP 管理的真实目录')
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
      mkdir(this.runsPath, { recursive: true })
    ])

    if (!await this.hasHead()) {
      await Promise.all([
        writeFile(join(this.knowledgePath, '.gitkeep'), '', { flag: 'a' }),
        writeFile(join(this.artifactsPath, '.gitkeep'), '', { flag: 'a' }),
        writeFile(join(this.rootPath, '.gitignore'), INITIAL_GITIGNORE, { flag: 'a' })
      ])
      await runArtifactGit([
        'add', '--', '.gitignore', KNOWLEDGE_DIRECTORY, ARTIFACTS_DIRECTORY
      ], this.rootPath)
      await runArtifactGit([
        'commit', '--quiet', '--no-gpg-sign', '-m', 'Initialize Oyster repository'
      ], this.rootPath)
      return
    }

    const gitignorePath = join(this.rootPath, '.gitignore')
    try {
      const current = await readFile(gitignorePath, 'utf8')
      if (!current.split(/\r?\n/).includes(`/${RUNS_DIRECTORY}/`)) {
        await writeFile(gitignorePath, `${current}${current.endsWith('\n') ? '' : '\n'}${INITIAL_GITIGNORE}`)
      }
    } catch (error) {
      if (!await isMissing(error)) throw error
      await writeFile(gitignorePath, INITIAL_GITIGNORE)
    }
  }
}

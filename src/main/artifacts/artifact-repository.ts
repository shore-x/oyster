import { mkdir, lstat, readFile, readdir, rmdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type {
  ArtifactSnapshot,
  ArtifactSummary,
  CreateArtifactInput
} from '../../shared/artifacts'
import { runArtifactGit } from './git-runtime'
import { inspectArtifactSkill } from './skill-artifact'

const ATTENTION_FILE_NAME = 'AGENTS.md'

function clone<T>(value: T): T {
  return structuredClone(value)
}

function assertAttention(attention: string): string {
  if (typeof attention !== 'string' || !attention.trim()) {
    throw new Error('Artifact Attention 不能为空')
  }
  return attention.trim()
}

/**
 * Resolves one first-level, visible Artifact directory without allowing path traversal.
 * IPC handlers can reuse this before opening an Artifact in the operating system.
 */
export function resolveArtifactDirectoryPath(
  repositoryPath: string,
  directoryName: string
): string {
  if (
    typeof directoryName !== 'string'
    || !directoryName
    || directoryName.startsWith('.')
    || directoryName.includes('/')
    || (sep === '\\' && directoryName.includes('\\'))
    || directoryName.includes('\0')
  ) {
    throw new Error('Artifact 文件夹名称无效')
  }

  const absoluteRepositoryPath = resolve(repositoryPath)
  const artifactPath = resolve(absoluteRepositoryPath, directoryName)
  if (dirname(artifactPath) !== absoluteRepositoryPath) {
    throw new Error('Artifact 文件夹名称无效')
  }
  return artifactPath
}

function resolveNewArtifactDirectoryPath(
  repositoryPath: string,
  directoryName: string
): string {
  if (
    typeof directoryName !== 'string'
    || directoryName !== directoryName.trim()
    || directoryName.includes('\\')
  ) {
    throw new Error('Artifact 文件夹名称无效')
  }
  return resolveArtifactDirectoryPath(repositoryPath, directoryName)
}

async function readArtifact(
  repositoryPath: string,
  directoryName: string
): Promise<ArtifactSummary | undefined> {
  // directoryName comes directly from readdir, so pre-existing filesystem names remain readable
  // even when the create API would decline to create such a name.
  const agentsPath = join(repositoryPath, directoryName, ATTENTION_FILE_NAME)

  try {
    const details = await lstat(agentsPath)
    if (!details.isFile()) return undefined
    const artifactPath = join(repositoryPath, directoryName)
    const skill = await inspectArtifactSkill(artifactPath)
    return {
      directoryName,
      attention: await readFile(agentsPath, 'utf8'),
      modifiedAt: details.mtime.toISOString(),
      ...(skill ? { skill } : {})
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') return undefined
    throw error
  }
}

export class ArtifactRepository {
  readonly repositoryPath: string

  constructor(repositoryPath: string) {
    this.repositoryPath = resolve(repositoryPath)
  }

  async initialize(): Promise<ArtifactSnapshot> {
    return this.refresh()
  }

  async refresh(): Promise<ArtifactSnapshot> {
    await this.ensureRepository()
    return this.scan()
  }

  private async assertRealRepositoryRoot(): Promise<void> {
    const details = await lstat(this.repositoryPath)
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new Error('Artifact Repository 根路径必须是 APP 管理的真实目录')
    }
  }

  private async ensureRepository(): Promise<void> {
    try {
      await mkdir(this.repositoryPath, { recursive: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    await this.assertRealRepositoryRoot()

    const gitPath = join(this.repositoryPath, '.git')
    try {
      const details = await lstat(gitPath)
      if (!details.isDirectory() || details.isSymbolicLink()) {
        throw new Error('Artifact Repository 的 .git 必须是本地真实目录')
      }
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    await runArtifactGit(['init', '--quiet'], this.repositoryPath)
    await this.assertRealRepositoryRoot()
    try {
      const details = await lstat(gitPath)
      if (!details.isDirectory() || details.isSymbolicLink()) {
        throw new Error('Artifact Repository 的 .git 必须是本地真实目录')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('Git 初始化没有在 Artifact Repository 中建立 .git 目录')
      }
      throw error
    }
  }

  private async scan(): Promise<ArtifactSnapshot> {
    const entries = await readdir(this.repositoryPath, { withFileTypes: true })
    const directories = entries
      .filter((entry) => !entry.name.startsWith('.') && entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right))

    const scanned = await Promise.all(directories.map(async (directoryName) => ({
      directoryName,
      artifact: await readArtifact(this.repositoryPath, directoryName)
    })))

    return clone({
      repositoryPath: this.repositoryPath,
      artifacts: scanned
        .map(({ artifact }) => artifact)
        .filter((artifact): artifact is ArtifactSummary => Boolean(artifact)),
      invalidDirectories: scanned
        .filter(({ artifact }) => !artifact)
        .map(({ directoryName }) => directoryName)
    })
  }

  async createArtifact(input: CreateArtifactInput): Promise<ArtifactSnapshot> {
    await this.ensureRepository()
    const artifactPath = resolveNewArtifactDirectoryPath(this.repositoryPath, input?.directoryName)
    const attention = assertAttention(input?.attention)

    try {
      await mkdir(artifactPath, { recursive: false })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`Artifact 文件夹已存在：${input.directoryName}`)
      }
      throw error
    }

    try {
      await writeFile(
        resolve(artifactPath, ATTENTION_FILE_NAME),
        `# Attention\n\n${attention}\n`,
        { encoding: 'utf8', flag: 'wx' }
      )
    } catch (error) {
      // Remove only the directory just created by this operation, and only if it is still empty.
      await rmdir(artifactPath).catch(() => undefined)
      throw error
    }

    return this.scan()
  }
}

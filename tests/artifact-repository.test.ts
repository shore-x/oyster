import { execFile } from 'node:child_process'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ArtifactService,
  resolveArtifactDirectoryPath
} from '../src/main/artifacts/artifact-repository'
import {
  ARTIFACT_GIT_BINARY_PATH,
  createArtifactGitEnvironment,
  runArtifactGit
} from '../src/main/artifacts/git-runtime'

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []

async function temporaryRepositoryPath(): Promise<string> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'oyster-artifacts-'))
  temporaryDirectories.push(temporaryDirectory)
  return join(temporaryDirectory, 'application-data', 'repository')
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )))
})

describe('ArtifactService', () => {
  it('initializes the one repository and its empty Artifact layer', async () => {
    const repositoryPath = await temporaryRepositoryPath()
    const repository = new ArtifactService(repositoryPath)

    const snapshot = await repository.initialize()

    expect(snapshot).toEqual({
      repositoryPath: resolve(repositoryPath),
      artifacts: [],
      invalidDirectories: []
    })
    expect((await lstat(join(repositoryPath, '.git'))).isDirectory()).toBe(true)
    expect(await readFile(join(repositoryPath, '.git', 'HEAD'), 'utf8')).toMatch(/^ref: refs\/heads\//)
    await expect(runArtifactGit(['rev-parse', '--verify', 'HEAD'], repositoryPath)).resolves.toBeUndefined()
  })

  it('initializes with the bundled Git when PATH contains no Git executable', async () => {
    const repositoryPath = await temporaryRepositoryPath()
    const repository = new ArtifactService(repositoryPath)
    const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
    const originalPath = process.env[pathKey]

    try {
      process.env[pathKey] = ''
      await expect(repository.initialize()).resolves.toMatchObject({
        repositoryPath: resolve(repositoryPath),
        artifacts: []
      })
    } finally {
      if (originalPath === undefined) delete process.env[pathKey]
      else process.env[pathKey] = originalPath
    }

    expect((await lstat(join(repositoryPath, '.git'))).isDirectory()).toBe(true)
  })

  it('does not invoke a git executable supplied through PATH', async () => {
    if (process.platform === 'win32') return
    const repositoryPath = await temporaryRepositoryPath()
    const fakeBinaryDirectory = join(repositoryPath, '..', 'fake-bin')
    await mkdir(fakeBinaryDirectory, { recursive: true })
    await writeFile(join(fakeBinaryDirectory, 'git'), '#!/bin/sh\nexit 93\n', 'utf8')
    await chmod(join(fakeBinaryDirectory, 'git'), 0o700)
    const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
    const originalPath = process.env[pathKey]

    try {
      process.env[pathKey] = fakeBinaryDirectory
      await expect(new ArtifactService(repositoryPath).initialize()).resolves.toBeDefined()
    } finally {
      if (originalPath === undefined) delete process.env[pathKey]
      else process.env[pathKey] = originalPath
    }
  })

  it('exposes an absolute bundled binary and reusable private shell environment', async () => {
    expect(isAbsolute(ARTIFACT_GIT_BINARY_PATH)).toBe(true)
    expect((await lstat(ARTIFACT_GIT_BINARY_PATH)).isFile()).toBe(true)

    const environment = createArtifactGitEnvironment({
      PATH: '/system-only',
      GIT_DIR: '/redirected/git-dir',
      GIT_WORK_TREE: '/redirected/work-tree',
      LOCAL_GIT_DIRECTORY: '/redirected/runtime',
      GIT_EXEC_PATH: '/redirected/exec-path'
    })
    expect(environment.PATH?.split(delimiter)[0]).toBe(
      dirname(ARTIFACT_GIT_BINARY_PATH)
    )
    expect(environment.GIT_DIR).toBeUndefined()
    expect(environment.GIT_WORK_TREE).toBeUndefined()
    expect(environment.LOCAL_GIT_DIRECTORY).not.toBe('/redirected/runtime')
    expect(environment.GIT_EXEC_PATH).not.toBe('/redirected/exec-path')
  })

  it('preserves the host PATH key casing without creating a competing key', () => {
    const environment = createArtifactGitEnvironment({ Path: '/system-only' })
    const pathKeys = Object.keys(environment).filter((key) => key.toUpperCase() === 'PATH')

    expect(pathKeys).toEqual(['Path'])
    expect(environment.Path?.split(delimiter)[0]).toBe(dirname(ARTIFACT_GIT_BINARY_PATH))
    expect(environment.Path).toContain('/system-only')
  })

  it('lets a generic shell command resolve the bundled Git through the private environment', async () => {
    const { stdout } = await execFileAsync('git', ['--version'], {
      env: createArtifactGitEnvironment({ PATH: '' })
    })

    expect(stdout).toMatch(/^git version /)
  })

  it('retries initialization after a local Repository layout error is repaired', async () => {
    const repositoryPath = await temporaryRepositoryPath()
    const gitTargetPath = join(repositoryPath, '..', 'temporary-git-target')
    await mkdir(repositoryPath, { recursive: true })
    await mkdir(gitTargetPath)
    await symlink(gitTargetPath, join(repositoryPath, '.git'))
    const repository = new ArtifactService(repositoryPath)

    await expect(repository.initialize()).rejects.toThrow(
      'Oyster Repository 的 .git 必须是本地真实目录'
    )
    await unlink(join(repositoryPath, '.git'))
    await expect(repository.refresh()).resolves.toMatchObject({
      repositoryPath: resolve(repositoryPath),
      artifacts: []
    })
  })

  it('clears Git layout environment variables during initialization', async () => {
    const repositoryPath = await temporaryRepositoryPath()
    const redirectedPath = join(repositoryPath, '..', 'redirected-git-layout')
    const originalValues = new Map<string, string | undefined>()
    const redirectedEnvironment = {
      GIT_DIR: join(redirectedPath, 'git-dir'),
      GIT_WORK_TREE: join(redirectedPath, 'work-tree'),
      GIT_COMMON_DIR: join(redirectedPath, 'common-dir'),
      GIT_OBJECT_DIRECTORY: join(redirectedPath, 'objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(redirectedPath, 'alternate-objects'),
      GIT_INDEX_FILE: join(redirectedPath, 'index')
    }
    for (const [key, value] of Object.entries(redirectedEnvironment)) {
      originalValues.set(key, process.env[key])
      process.env[key] = value
    }

    try {
      await new ArtifactService(repositoryPath).initialize()
    } finally {
      for (const [key, value] of originalValues) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }

    expect((await lstat(join(repositoryPath, '.git'))).isDirectory()).toBe(true)
    await expect(lstat(redirectedPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a Repository root that is a symbolic link', async () => {
    const repositoryPath = await temporaryRepositoryPath()
    const targetPath = join(repositoryPath, '..', 'repository-target')
    await mkdir(join(repositoryPath, '..'), { recursive: true })
    await mkdir(targetPath)
    await symlink(targetPath, repositoryPath)

    await expect(new ArtifactService(repositoryPath).initialize()).rejects.toThrow(
      'Oyster Repository 根路径必须是 APP 管理的真实目录'
    )
    await expect(lstat(join(targetPath, '.git'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a symbolic-link .git directory', async () => {
    const repositoryPath = await temporaryRepositoryPath()
    const gitTargetPath = join(repositoryPath, '..', 'git-target')
    await mkdir(repositoryPath, { recursive: true })
    await mkdir(gitTargetPath)
    await symlink(gitTargetPath, join(repositoryPath, '.git'))

    await expect(new ArtifactService(repositoryPath).initialize()).rejects.toThrow(
      'Oyster Repository 的 .git 必须是本地真实目录'
    )
  })

  it('loads only visible first-level real directories with a regular root AGENTS.md', async () => {
    const repositoryPath = await temporaryRepositoryPath()
    const repository = new ArtifactService(repositoryPath)
    await repository.initialize()

    const validPath = join(repository.artifactsPath, 'a-valid-artifact')
    const invalidPath = join(repository.artifactsPath, 'b-missing-attention')
    const nestedOnlyPath = join(repository.artifactsPath, 'c-nested-only')
    const agentsDirectoryPath = join(repository.artifactsPath, 'd-agents-directory')
    const externallyNamedPath = join(repository.artifactsPath, ' externally-named ')
    const hiddenPath = join(repository.artifactsPath, '.hidden-artifact')
    const symlinkTargetPath = join(repository.artifactsPath, '.external-target')
    await Promise.all([
      mkdir(validPath),
      mkdir(invalidPath),
      mkdir(join(nestedOnlyPath, 'nested'), { recursive: true }),
      mkdir(join(agentsDirectoryPath, 'AGENTS.md'), { recursive: true }),
      mkdir(externallyNamedPath),
      mkdir(hiddenPath),
      mkdir(symlinkTargetPath)
    ])
    const attention = '# Attention\n\nTrack a long-running topic.\n\n- Preserve user edits.\n'
    await Promise.all([
      writeFile(join(validPath, 'AGENTS.md'), attention, 'utf8'),
      writeFile(join(externallyNamedPath, 'AGENTS.md'), '# External name\n', 'utf8'),
      writeFile(join(nestedOnlyPath, 'nested', 'AGENTS.md'), '# Nested', 'utf8'),
      writeFile(join(hiddenPath, 'AGENTS.md'), '# Hidden', 'utf8'),
      writeFile(join(symlinkTargetPath, 'AGENTS.md'), '# Symlink target', 'utf8'),
      writeFile(join(repository.artifactsPath, 'ordinary-file.txt'), 'ignored', 'utf8')
    ])
    await symlink(symlinkTargetPath, join(repository.artifactsPath, 'e-symlink-artifact'))

    const snapshot = await repository.refresh()
    const agentsDetails = await stat(join(validPath, 'AGENTS.md'))

    expect(snapshot.artifacts).toEqual([
      expect.objectContaining({
        directoryName: ' externally-named ',
        directoryPath: externallyNamedPath,
        attention: '# External name\n'
      }),
      {
        directoryName: 'a-valid-artifact',
        directoryPath: validPath,
        attention,
        modifiedAt: agentsDetails.mtime.toISOString()
      }
    ])
    expect(snapshot.invalidDirectories).toEqual([
      'b-missing-attention',
      'c-nested-only',
      'd-agents-directory'
    ])
  })

  it('derives a ready Skill view from a valid root SKILL.md', async () => {
    const repositoryPath = await temporaryRepositoryPath()
    const repository = new ArtifactService(repositoryPath)
    await repository.initialize()
    const artifactPath = join(repository.artifactsPath, 'review-skill')
    await mkdir(join(artifactPath, 'output'), { recursive: true })
    await Promise.all([
      writeFile(join(artifactPath, 'AGENTS.md'), '# Attention\n\nMaintain review guidance.\n'),
      writeFile(join(artifactPath, 'SKILL.md'), [
        '---',
        'name: review',
        'description: Review changes before delivery.',
        '---',
        '',
        '# Review',
        ''
      ].join('\n'))
    ])

    const snapshot = await repository.refresh()

    expect(snapshot.artifacts).toEqual([expect.objectContaining({
      directoryName: 'review-skill',
      skill: {
        skillPath: artifactPath,
        documentPath: join(artifactPath, 'SKILL.md'),
        name: 'review',
        description: 'Review changes before delivery.',
        status: 'ready'
      }
    })])
  })

  it('ignores ordinary output directories and keeps malformed root SKILL.md visible', async () => {
    const repositoryPath = await temporaryRepositoryPath()
    const repository = new ArtifactService(repositoryPath)
    await repository.initialize()
    const ordinaryOutput = join(repository.artifactsPath, 'ordinary-output')
    const linkedDocument = join(repository.artifactsPath, 'linked-document')
    const documentTarget = join(repository.artifactsPath, '.skill-target')
    await Promise.all([
      mkdir(join(ordinaryOutput, 'output'), { recursive: true }),
      mkdir(linkedDocument),
      writeFile(documentTarget, '---\nname: linked\ndescription: Linked.\n---\n')
    ])
    await Promise.all([
      writeFile(join(ordinaryOutput, 'AGENTS.md'), '# Ordinary output\n'),
      writeFile(join(linkedDocument, 'AGENTS.md'), '# Linked document\n')
    ])
    await symlink(documentTarget, join(linkedDocument, 'SKILL.md'), 'file')

    const snapshot = await repository.refresh()

    expect(snapshot.artifacts).toEqual([
      expect.objectContaining({
        directoryName: 'linked-document',
        skill: expect.objectContaining({
          status: 'invalid',
          issue: expect.stringContaining('普通文件')
        })
      }),
      expect.objectContaining({
        directoryName: 'ordinary-output'
      })
    ])
  })

  it('reports an unreadable AGENTS.md as invalid without failing the scan', async () => {
    if (process.platform === 'win32') return
    const repositoryPath = await temporaryRepositoryPath()
    const repository = new ArtifactService(repositoryPath)
    await repository.initialize()
    const artifactPath = join(repository.artifactsPath, 'unreadable-attention')
    const attentionPath = join(artifactPath, 'AGENTS.md')
    await mkdir(artifactPath)
    await writeFile(attentionPath, '# Attention\n', 'utf8')
    await chmod(attentionPath, 0o000)

    try {
      await expect(repository.refresh()).resolves.toMatchObject({
        artifacts: [],
        invalidDirectories: ['unreadable-attention']
      })
    } finally {
      await chmod(attentionPath, 0o600)
    }
  })

  it('uses the same safe path resolution for later open-directory integration', async () => {
    const repositoryPath = await temporaryRepositoryPath()
    expect(resolveArtifactDirectoryPath(repositoryPath, 'valid-artifact')).toBe(
      resolve(repositoryPath, 'valid-artifact')
    )
    expect(resolveArtifactDirectoryPath(repositoryPath, ' externally-named ')).toBe(
      resolve(repositoryPath, ' externally-named ')
    )
    expect(() => resolveArtifactDirectoryPath(repositoryPath, '../outside')).toThrow(
      'Artifact 文件夹名称无效'
    )
  })
})

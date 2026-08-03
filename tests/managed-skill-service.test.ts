import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactRepository } from '../src/main/artifacts/artifact-repository'
import type { DetectionContext } from '../src/main/discovery/model'
import { ManagedSkillService } from '../src/main/skills/managed-skill-service'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )))
})

async function fixture(environment: NodeJS.ProcessEnv = {}): Promise<{
  rootPath: string
  homeDirectory: string
  repository: ArtifactRepository
  service: ManagedSkillService
}> {
  const rootPath = await mkdtemp(join(tmpdir(), 'oyster-managed-skills-'))
  temporaryDirectories.push(rootPath)
  const homeDirectory = join(rootPath, 'home')
  const repository = new ArtifactRepository(join(rootPath, 'app-data', 'artifacts'))
  await mkdir(homeDirectory, { recursive: true })
  await repository.initialize()
  const context: DetectionContext = { homeDirectory, environment, pathEntries: [] }
  return {
    rootPath,
    homeDirectory,
    repository,
    service: new ManagedSkillService(repository, context)
  }
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
}

async function writeArtifact(
  repository: ArtifactRepository,
  directoryName: string,
  skillDocument?: string
): Promise<string> {
  const artifactPath = join(repository.repositoryPath, directoryName)
  await write(join(artifactPath, 'AGENTS.md'), '# Attention\n\nMaintain this Skill.\n')
  await mkdir(join(artifactPath, 'output'), { recursive: true })
  if (skillDocument !== undefined) {
    await write(join(artifactPath, 'output', 'SKILL.md'), skillDocument)
  }
  return artifactPath
}

function skillDocument(name = 'review', description = 'Review changes before delivery.'): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    `# ${name}`,
    '',
    'Keep the change focused.',
    ''
  ].join('\n')
}

describe('ManagedSkillService', () => {
  it('derives managed Skills and the three default user registration targets', async () => {
    const { homeDirectory, repository, service } = await fixture()
    const artifactPath = await writeArtifact(repository, 'review-artifact', skillDocument())

    const snapshot = await service.getSnapshot()

    expect(snapshot.errors).toEqual([])
    expect(snapshot.scannedAt).toBeDefined()
    expect(snapshot.skills).toEqual([expect.objectContaining({
      artifactDirectoryName: 'review-artifact',
      artifactPath,
      outputPath: join(artifactPath, 'output'),
      documentPath: join(artifactPath, 'output', 'SKILL.md'),
      name: 'review',
      description: 'Review changes before delivery.',
      status: 'ready'
    })])
    expect(snapshot.skills[0].targets).toEqual([
      expect.objectContaining({
        id: 'claude:user',
        registrationRoot: join(homeDirectory, '.claude', 'skills'),
        state: 'unbound',
        shared: false
      }),
      expect.objectContaining({
        id: 'pi:user',
        registrationRoot: join(homeDirectory, '.pi', 'agent', 'skills'),
        state: 'unbound',
        shared: false
      }),
      expect.objectContaining({
        id: 'codex:user',
        registrationRoot: join(homeDirectory, '.agents', 'skills'),
        state: 'unbound',
        shared: true
      })
    ])
  })

  it('honors Claude and Pi overrides while keeping Codex on the canonical shared root', async () => {
    const { homeDirectory, repository, service } = await fixture({
      CLAUDE_CONFIG_DIR: '~/custom-claude',
      PI_CODING_AGENT_DIR: '~/custom-pi-agent'
    })
    await writeArtifact(repository, 'review-artifact', skillDocument())

    const snapshot = await service.getSnapshot()
    expect(snapshot.skills[0].targets).toEqual([
      expect.objectContaining({
        id: 'claude:user',
        registrationRoot: join(homeDirectory, 'custom-claude', 'skills')
      }),
      expect.objectContaining({
        id: 'pi:user',
        registrationRoot: join(homeDirectory, 'custom-pi-agent', 'skills')
      }),
      expect.objectContaining({
        id: 'codex:user',
        registrationRoot: join(homeDirectory, '.agents', 'skills'),
        shared: true
      })
    ])
  })

  it('creates an absolute output symlink idempotently and removes only that link', async () => {
    const { homeDirectory, repository, service } = await fixture()
    const artifactPath = await writeArtifact(repository, 'review-artifact', skillDocument())
    const outputPath = join(artifactPath, 'output')
    const bindingPath = join(homeDirectory, '.claude', 'skills', 'review')

    const bound = await service.bind({
      artifactDirectoryName: 'review-artifact',
      targetId: 'claude:user'
    })
    expect((await lstat(bindingPath)).isSymbolicLink()).toBe(true)
    expect(await readlink(bindingPath)).toBe(resolve(outputPath))
    expect(bound.skills[0].targets.find((target) => target.id === 'claude:user')?.state).toBe('bound')

    await service.bind({ artifactDirectoryName: 'review-artifact', targetId: 'claude:user' })
    await writeFile(join(outputPath, 'live.txt'), 'current output', 'utf8')
    expect(await readFile(join(bindingPath, 'live.txt'), 'utf8')).toBe('current output')

    const unbound = await service.unbind({
      artifactDirectoryName: 'review-artifact',
      targetId: 'claude:user'
    })
    await expect(lstat(bindingPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await lstat(outputPath)).isDirectory()).toBe(true)
    expect(unbound.skills[0].targets.find((target) => target.id === 'claude:user')?.state).toBe('unbound')

    await expect(service.unbind({
      artifactDirectoryName: 'review-artifact',
      targetId: 'claude:user'
    })).resolves.toBeDefined()
  })

  it('finds and safely unbinds the old symlink after the Skill name changes or becomes invalid', async () => {
    const { homeDirectory, repository, service } = await fixture()
    const artifactPath = await writeArtifact(repository, 'review-artifact', skillDocument())
    const documentPath = join(artifactPath, 'output', 'SKILL.md')
    const oldBindingPath = join(homeDirectory, '.claude', 'skills', 'review')
    await service.bind({ artifactDirectoryName: 'review-artifact', targetId: 'claude:user' })

    await writeFile(documentPath, skillDocument('renamed-review'), 'utf8')
    let snapshot = await service.getSnapshot()
    expect(snapshot.skills[0].targets.find((target) => target.id === 'claude:user')).toMatchObject({
      state: 'bound',
      bindingPath: oldBindingPath,
      message: expect.stringContaining('名称与 SKILL.md name 不一致')
    })
    await service.unbind({ artifactDirectoryName: 'review-artifact', targetId: 'claude:user' })
    await expect(lstat(oldBindingPath)).rejects.toMatchObject({ code: 'ENOENT' })

    await service.bind({ artifactDirectoryName: 'review-artifact', targetId: 'claude:user' })
    const renamedBindingPath = join(homeDirectory, '.claude', 'skills', 'renamed-review')
    await writeFile(documentPath, skillDocument('Invalid Name'), 'utf8')
    snapshot = await service.getSnapshot()
    expect(snapshot.skills[0]).toMatchObject({ status: 'invalid' })
    expect(snapshot.errors).toEqual([])
    expect(snapshot.skills[0].targets.find((target) => target.id === 'claude:user')).toMatchObject({
      state: 'bound',
      bindingPath: renamedBindingPath
    })
    await service.unbind({ artifactDirectoryName: 'review-artifact', targetId: 'claude:user' })
    await expect(lstat(renamedBindingPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not guess which link to remove when multiple symlinks target one output', async () => {
    const { homeDirectory, repository, service } = await fixture()
    const artifactPath = await writeArtifact(repository, 'review-artifact', skillDocument())
    const registrationRoot = join(homeDirectory, '.claude', 'skills')
    await service.bind({ artifactDirectoryName: 'review-artifact', targetId: 'claude:user' })
    const firstPath = join(registrationRoot, 'review')
    const secondPath = join(registrationRoot, 'review-copy')
    await symlink(join(artifactPath, 'output'), secondPath, 'dir')

    const snapshot = await service.getSnapshot()
    expect(snapshot.skills[0].targets.find((target) => target.id === 'claude:user')).toMatchObject({
      state: 'error',
      message: expect.stringContaining('多个')
    })
    await expect(service.unbind({
      artifactDirectoryName: 'review-artifact',
      targetId: 'claude:user'
    })).rejects.toThrow('多个')
    expect((await lstat(firstPath)).isSymbolicLink()).toBe(true)
    expect((await lstat(secondPath)).isSymbolicLink()).toBe(true)
  })

  it('reports exact-path conflicts and never overwrites or unlinks them', async () => {
    const { homeDirectory, rootPath, repository, service } = await fixture()
    await writeArtifact(repository, 'review-artifact', skillDocument())
    const bindingPath = join(homeDirectory, '.pi', 'agent', 'skills', 'review')
    await write(bindingPath, 'external Skill')

    await expect(service.bind({
      artifactDirectoryName: 'review-artifact',
      targetId: 'pi:user'
    })).rejects.toThrow('不会覆盖')
    expect(await readFile(bindingPath, 'utf8')).toBe('external Skill')
    await expect(service.unbind({
      artifactDirectoryName: 'review-artifact',
      targetId: 'pi:user'
    })).rejects.toThrow('不会覆盖')
    expect(await readFile(bindingPath, 'utf8')).toBe('external Skill')

    await rm(bindingPath)
    const otherTarget = join(rootPath, 'other-skill')
    await mkdir(otherTarget)
    await symlink(otherTarget, bindingPath, 'dir')
    await expect(service.bind({
      artifactDirectoryName: 'review-artifact',
      targetId: 'pi:user'
    })).rejects.toThrow('其他位置')
    await expect(service.unbind({
      artifactDirectoryName: 'review-artifact',
      targetId: 'pi:user'
    })).rejects.toThrow('其他位置')
    expect(await readlink(bindingPath)).toBe(otherTarget)
  })

  it('keeps an incomplete output visible but refuses to bind it', async () => {
    const { repository, service } = await fixture()
    const artifactPath = await writeArtifact(repository, 'incomplete-skill')

    const snapshot = await service.getSnapshot()

    expect(snapshot.skills).toEqual([expect.objectContaining({
      artifactDirectoryName: 'incomplete-skill',
      status: 'invalid',
      issue: expect.stringContaining('缺少普通文件 SKILL.md')
    })])
    await expect(service.getFolderPath('incomplete-skill')).resolves.toBe(
      join(artifactPath, 'output')
    )
    await expect(service.bind({
      artifactDirectoryName: 'incomplete-skill',
      targetId: 'codex:user'
    })).rejects.toThrow('缺少普通文件 SKILL.md')
  })

  it('previews a regular entry document even when its metadata is not injectable', async () => {
    const { repository, service } = await fixture()
    const content = '# Missing frontmatter\n\nStill useful to inspect.\n'
    await writeArtifact(repository, 'invalid-metadata', content)

    const snapshot = await service.getSnapshot()
    expect(snapshot.skills[0]).toMatchObject({ status: 'invalid' })
    await expect(service.readDocument('invalid-metadata')).resolves.toMatchObject({
      artifactDirectoryName: 'invalid-metadata',
      fileName: 'SKILL.md',
      content
    })
  })

  it('rejects arbitrary Artifact and target identifiers', async () => {
    const { repository, service } = await fixture()
    await writeArtifact(repository, 'review-artifact', skillDocument())

    await expect(service.bind({
      artifactDirectoryName: '../outside',
      targetId: 'claude:user'
    })).rejects.toThrow('Artifact 文件夹名称无效')
    await expect(service.bind({
      artifactDirectoryName: 'review-artifact',
      targetId: '/tmp/arbitrary-target'
    })).rejects.toThrow('Skill 绑定目标无效')
  })
})

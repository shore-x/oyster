import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { SkillDiscoveryService } from '../src/main/skills/skill-discovery-service'
import type { DetectionContext } from '../src/main/discovery/model'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )))
})

async function temporaryHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'oyster-skills-'))
  temporaryDirectories.push(directory)
  return directory
}

function context(homeDirectory: string): DetectionContext {
  return {
    homeDirectory,
    environment: {
      CLAUDE_CONFIG_DIR: join(homeDirectory, '.claude'),
      PI_CODING_AGENT_DIR: join(homeDirectory, '.pi', 'agent'),
      CODEX_HOME: join(homeDirectory, '.codex')
    },
    pathEntries: []
  }
}

async function write(path: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

async function writeSkill(
  directory: string,
  name: string,
  description = `${name} description`
): Promise<string> {
  const documentPath = join(directory, 'SKILL.md')
  await write(documentPath, [
    '---',
    `name: ${name}`,
    `description: "${description}"`,
    '---',
    '',
    `# ${name}`,
    '',
    `Instructions for ${name}.`,
    ''
  ].join('\n'))
  return documentPath
}

describe('SkillDiscoveryService', () => {
  it('starts with an empty in-memory snapshot', async () => {
    const homeDirectory = await temporaryHome()
    const service = new SkillDiscoveryService(context(homeDirectory), () => [], join(homeDirectory, 'admin'))

    expect(service.getSnapshot()).toEqual({ skills: [], errors: [] })
  })

  it('discovers native user, project, legacy, admin, and system registrations for all three Agents', async () => {
    const homeDirectory = await temporaryHome()
    const repositoryPath = join(homeDirectory, 'work', 'project')
    const workingDirectory = join(repositoryPath, 'service')
    const adminRoot = join(homeDirectory, 'codex-admin')
    await Promise.all([
      mkdir(join(repositoryPath, '.git'), { recursive: true }),
      mkdir(workingDirectory, { recursive: true }),
      writeSkill(join(homeDirectory, '.claude', 'skills', 'claude-user-folder'), 'claude-user'),
      write(join(homeDirectory, '.claude', 'commands', 'legacy.md'), '# Claude legacy\n'),
      writeSkill(join(repositoryPath, '.claude', 'skills', 'claude-project-folder'), 'claude-project'),
      write(join(workingDirectory, '.claude', 'commands', 'nested', 'deploy.md'), '# Deploy\n'),
      writeSkill(join(homeDirectory, '.pi', 'agent', 'skills', 'group', 'pi-user-folder'), 'pi-user'),
      write(join(homeDirectory, '.pi', 'agent', 'skills', 'quick.md'), '# Pi quick\n'),
      writeSkill(join(homeDirectory, '.agents', 'skills', 'shared-folder'), 'shared-user'),
      writeSkill(join(workingDirectory, '.pi', 'skills', 'pi-project-folder'), 'pi-project'),
      write(join(workingDirectory, '.pi', 'skills', 'local.md'), '# Pi local\n'),
      writeSkill(join(repositoryPath, '.agents', 'skills', 'shared-project-folder'), 'shared-project'),
      writeSkill(join(homeDirectory, '.codex', 'skills', 'codex-user-folder'), 'codex-user'),
      writeSkill(join(homeDirectory, '.codex', 'skills', '.system', 'codex-system-folder'), 'codex-system'),
      writeSkill(join(adminRoot, 'codex-admin-folder'), 'codex-admin')
    ])
    const service = new SkillDiscoveryService(
      context(homeDirectory),
      async () => [workingDirectory, workingDirectory],
      adminRoot
    )

    const snapshot = await service.discover()

    expect(snapshot.errors).toEqual([])
    expect(snapshot.scannedAt).toBeDefined()
    expect(snapshot.skills).toHaveLength(15)
    expect(snapshot.skills.map((skill) => `${skill.agentType}:${skill.name}:${skill.scope}`)).toEqual(
      expect.arrayContaining([
        'claude:claude-user:user',
        'claude:legacy:user',
        'claude:claude-project:project',
        'claude:nested:deploy:project',
        'pi:pi-user:user',
        'pi:quick:user',
        'pi:shared-user:user',
        'pi:pi-project:project',
        'pi:local:project',
        'pi:shared-project:project',
        'codex:shared-user:user',
        'codex:codex-user:user',
        'codex:codex-system:system',
        'codex:codex-admin:admin',
        'codex:shared-project:project'
      ])
    )

    const projectRegistrations = snapshot.skills.filter((skill) => skill.name === 'shared-project')
    expect(projectRegistrations).toHaveLength(2)
    expect(projectRegistrations.map((skill) => skill.agentType).sort()).toEqual(['codex', 'pi'])
    expect(projectRegistrations.every((skill) => skill.projectPath === repositoryPath)).toBe(true)

    const sharedUserRegistrations = snapshot.skills.filter((skill) => skill.name === 'shared-user')
    expect(sharedUserRegistrations.map((skill) => skill.agentType).sort()).toEqual(['codex', 'pi'])
    expect(new Set(sharedUserRegistrations.map((skill) => skill.id)).size).toBe(2)

    const claudeUser = snapshot.skills.find((skill) => skill.name === 'claude-user')!
    expect(claudeUser).toMatchObject({
      agentDisplayName: 'Claude Code',
      description: 'claude-user description',
      documentFileName: 'SKILL.md',
      format: 'agent_skill'
    })
    await expect(service.readDocument(claudeUser.id)).resolves.toMatchObject({
      skillId: claudeUser.id,
      fileName: 'SKILL.md',
      content: expect.stringContaining('# claude-user')
    })
    await expect(service.getSkillFolderPath(claudeUser.id)).resolves.toBe(claudeUser.directoryPath)

    const legacy = snapshot.skills.find((skill) => skill.agentType === 'claude' && skill.name === 'legacy')!
    expect(legacy).toMatchObject({ documentFileName: 'legacy.md', format: 'legacy_markdown' })

    snapshot.skills.length = 0
    expect(service.getSnapshot().skills).toHaveLength(15)
  })

  it('follows directory symlinks while skipping symlinked entry documents and wrong filename casing', async () => {
    const homeDirectory = await temporaryHome()
    const sharedRoot = join(homeDirectory, '.agents', 'skills')
    const targetDirectory = join(homeDirectory, 'external', 'linked-skill')
    await writeSkill(targetDirectory, 'linked-skill')
    await mkdir(sharedRoot, { recursive: true })
    await symlink(targetDirectory, join(sharedRoot, 'linked'), 'dir')

    const symlinkedDocumentTarget = join(homeDirectory, 'external', 'document.md')
    const symlinkedSkill = join(sharedRoot, 'symlinked-document')
    await write(symlinkedDocumentTarget, '# Not a regular entry\n')
    await mkdir(symlinkedSkill, { recursive: true })
    await symlink(symlinkedDocumentTarget, join(symlinkedSkill, 'SKILL.md'), 'file')
    await write(join(sharedRoot, 'wrong-case', 'skill.md'), '# Wrong case\n')
    await write(join(homeDirectory, '.claude', 'commands', 'linked.md'), '# Target\n')
    await symlink(
      join(homeDirectory, '.claude', 'commands', 'linked.md'),
      join(homeDirectory, '.claude', 'commands', 'alias.md'),
      'file'
    )
    const service = new SkillDiscoveryService(context(homeDirectory), () => [], join(homeDirectory, 'admin'))

    const snapshot = await service.discover()

    const linked = snapshot.skills.filter((skill) => skill.name === 'linked-skill')
    expect(linked.map((skill) => skill.agentType).sort()).toEqual(['codex', 'pi'])
    expect(linked.every((skill) => skill.directoryPath === join(sharedRoot, 'linked'))).toBe(true)
    expect(snapshot.skills.some((skill) => skill.directoryPath === symlinkedSkill)).toBe(false)
    expect(snapshot.skills.some((skill) => skill.documentFileName === 'skill.md')).toBe(false)
    expect(snapshot.skills.filter((skill) => skill.agentType === 'claude' && skill.name === 'linked')).toHaveLength(1)
    expect(snapshot.skills.some((skill) => skill.documentFileName === 'alias.md')).toBe(false)
  })

  it('uses Codex direct-child discovery and does not relabel Pi user Skills as project Skills', async () => {
    const homeDirectory = await temporaryHome()
    const projectPath = join(homeDirectory, 'work', 'no-git-project')
    await Promise.all([
      mkdir(projectPath, { recursive: true }),
      writeSkill(join(homeDirectory, '.agents', 'skills', 'user-shared'), 'user-shared'),
      writeSkill(join(projectPath, '.agents', 'skills', 'project-shared'), 'project-shared'),
      writeSkill(join(homeDirectory, '.codex', 'skills', 'category', 'nested'), 'nested-codex-decoy')
    ])
    const service = new SkillDiscoveryService(
      context(homeDirectory),
      () => [projectPath],
      join(homeDirectory, 'admin')
    )

    const snapshot = await service.discover()

    expect(snapshot.skills.filter((skill) => skill.name === 'user-shared')).toMatchObject([
      { agentType: 'pi', scope: 'user' },
      { agentType: 'codex', scope: 'user' }
    ])
    expect(snapshot.skills.some((skill) => (
      skill.name === 'user-shared' && skill.scope === 'project'
    ))).toBe(false)
    expect(snapshot.skills.filter((skill) => skill.name === 'project-shared')).toMatchObject([
      { agentType: 'pi', scope: 'project', projectPath },
      { agentType: 'codex', scope: 'project', projectPath }
    ])
    expect(snapshot.skills.some((skill) => skill.name === 'nested-codex-decoy')).toBe(false)
  })

  it('enforces opaque IDs and the 2 MiB document preview boundary', async () => {
    const homeDirectory = await temporaryHome()
    const skillDirectory = join(homeDirectory, '.claude', 'skills', 'large')
    await write(join(skillDirectory, 'SKILL.md'), Buffer.alloc(2 * 1024 * 1024 + 1, 97))
    const service = new SkillDiscoveryService(context(homeDirectory), () => [], join(homeDirectory, 'admin'))
    const snapshot = await service.discover()
    const skill = snapshot.skills.find((candidate) => candidate.agentType === 'claude')!

    expect(skill.sizeBytes).toBe(2 * 1024 * 1024 + 1)
    await expect(service.readDocument(skill.id)).rejects.toThrow('超过 2 MiB')
    await expect(service.readDocument(skill.documentPath)).rejects.toThrow('Skill ID 无效')
    await expect(service.getSkillFolderPath('skill:00000000000000000000000000000000')).rejects.toThrow(
      '不存在或需要重新发现'
    )
  })

  it('refuses an entry document that was replaced or changed into a symlink after discovery', async () => {
    const homeDirectory = await temporaryHome()
    const skillDirectory = join(homeDirectory, '.claude', 'skills', 'mutable')
    const documentPath = await writeSkill(skillDirectory, 'mutable')
    const originalPath = join(skillDirectory, 'original.md')
    const service = new SkillDiscoveryService(context(homeDirectory), () => [], join(homeDirectory, 'admin'))
    const snapshot = await service.discover()
    const skill = snapshot.skills.find((candidate) => candidate.name === 'mutable')!

    await rename(documentPath, originalPath)
    await symlink(originalPath, documentPath, 'file')
    await expect(service.readDocument(skill.id)).rejects.toThrow('普通文件')

    await rm(documentPath)
    await write(documentPath, '# Replacement\n')
    await expect(service.readDocument(skill.id)).rejects.toThrow('发现后已变化')
  })

  it('atomically replaces the catalog when a later discovery no longer finds a Skill', async () => {
    const homeDirectory = await temporaryHome()
    const skillDirectory = join(homeDirectory, '.claude', 'skills', 'temporary')
    await writeSkill(skillDirectory, 'temporary')
    const service = new SkillDiscoveryService(context(homeDirectory), () => [], join(homeDirectory, 'admin'))
    const first = await service.discover()
    const priorId = first.skills.find((skill) => skill.name === 'temporary')!.id

    await rm(skillDirectory, { recursive: true })
    const second = await service.discover()

    expect(second.skills.some((skill) => skill.id === priorId)).toBe(false)
    await expect(service.readDocument(priorId)).rejects.toThrow('不存在或需要重新发现')
  })
})

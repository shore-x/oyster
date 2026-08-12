import {
  lstat,
  mkdir,
  readdir,
  readlink,
  stat,
  symlink,
  unlink
} from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { ArtifactSkillSummary } from '../../shared/artifacts'
import type { AgentType } from '../../shared/discovery'
import type {
  ManagedSkillBindingInput,
  ManagedSkillDocument,
  ManagedSkillError,
  ManagedSkillSnapshot,
  ManagedSkillSummary,
  SkillBindingTargetSummary
} from '../../shared/skills'
import {
  type ArtifactService,
  resolveArtifactDirectoryPath
} from '../artifacts/artifact-repository'
import { readArtifactSkillDocument } from '../artifacts/skill-artifact'
import type { DetectionContext } from '../discovery/model'
import { validSkillName } from './skill-metadata'

interface BindingTarget {
  id: string
  agentType: AgentType
  agentDisplayName: string
  registrationRoot: string
  shared: boolean
}

interface ManagedArtifact {
  artifactDirectoryName: string
  artifactPath: string
  skill: ArtifactSkillSummary
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function missingPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function configuredRoot(
  value: string | undefined,
  fallback: string,
  homeDirectory: string
): string {
  if (!value) return resolve(fallback)
  if (value === '~') return resolve(homeDirectory)
  if (value.startsWith('~/')) return resolve(homeDirectory, value.slice(2))
  return resolve(value)
}

function bindingTargetDefinitions(context: DetectionContext): BindingTarget[] {
  const claudeConfigRoot = configuredRoot(
    context.environment.CLAUDE_CONFIG_DIR,
    join(context.homeDirectory, '.claude'),
    context.homeDirectory
  )
  const piAgentRoot = configuredRoot(
    context.environment.PI_CODING_AGENT_DIR,
    join(context.homeDirectory, '.pi', 'agent'),
    context.homeDirectory
  )
  return [
    {
      id: 'claude:user',
      agentType: 'claude',
      agentDisplayName: 'Claude Code',
      registrationRoot: join(claudeConfigRoot, 'skills'),
      shared: false
    },
    {
      id: 'pi:user',
      agentType: 'pi',
      agentDisplayName: 'Pi',
      registrationRoot: join(piAgentRoot, 'skills'),
      shared: false
    },
    {
      id: 'codex:user',
      agentType: 'codex',
      agentDisplayName: 'Codex',
      registrationRoot: join(context.homeDirectory, '.agents', 'skills'),
      shared: true
    }
  ]
}

async function skillBindingPaths(
  registrationRoot: string,
  skillPath: string
): Promise<string[]> {
  let entries
  try {
    entries = await readdir(registrationRoot, { withFileTypes: true })
  } catch (error) {
    if (missingPath(error)) return []
    throw error
  }

  const expectedSkillPath = resolve(skillPath)
  const paths: string[] = []
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue
    const entryPath = join(registrationRoot, entry.name)
    try {
      const targetPath = resolve(dirname(entryPath), await readlink(entryPath))
      if (targetPath === expectedSkillPath) paths.push(entryPath)
    } catch (error) {
      // An entry removed during a refresh is simply no longer a binding fact.
      if (!missingPath(error)) throw error
    }
  }
  return paths.sort((left, right) => left.localeCompare(right))
}

async function inspectBindingTarget(
  target: BindingTarget,
  skillPath: string,
  skillName: string | undefined,
  invalidIssue?: string
): Promise<SkillBindingTargetSummary> {
  let existingSkillBindings: string[]
  try {
    existingSkillBindings = await skillBindingPaths(
      target.registrationRoot,
      skillPath
    )
  } catch (error) {
    return {
      ...target,
      scope: 'user',
      state: 'error',
      message: errorMessage(error)
    }
  }
  if (existingSkillBindings.length > 1) {
    return {
      ...target,
      scope: 'user',
      state: 'error',
      message: '发现多个指向当前 Skill Artifact 的 symlink，Oyster 无法安全选择'
    }
  }
  if (existingSkillBindings.length === 1) {
    const bindingPath = existingSkillBindings[0]
    const currentName = validSkillName(skillName) ? skillName : undefined
    return {
      ...target,
      scope: 'user',
      bindingPath,
      state: 'bound',
      ...(currentName && basename(bindingPath) !== currentName
        ? { message: '当前链接名称与 SKILL.md name 不一致；请先解绑再重新绑定' }
        : {})
    }
  }

  if (!validSkillName(skillName)) {
    return {
      ...target,
      scope: 'user',
      state: 'error',
      message: invalidIssue || 'Skill 没有可用于注册目录的有效 name'
    }
  }

  const bindingPath = join(target.registrationRoot, skillName)
  let details
  try {
    details = await lstat(bindingPath)
  } catch (error) {
    if (missingPath(error)) {
      return { ...target, scope: 'user', bindingPath, state: 'unbound' }
    }
    return {
      ...target,
      scope: 'user',
      bindingPath,
      state: 'error',
      message: errorMessage(error)
    }
  }

  if (!details.isSymbolicLink()) {
    return {
      ...target,
      scope: 'user',
      bindingPath,
      state: 'conflict',
      message: '目标位置已有文件或真实目录，Oyster 不会覆盖'
    }
  }

  try {
    const targetPath = resolve(dirname(bindingPath), await readlink(bindingPath))
    if (targetPath === resolve(skillPath)) {
      return { ...target, scope: 'user', bindingPath, state: 'bound' }
    }
    return {
      ...target,
      scope: 'user',
      bindingPath,
      state: 'conflict',
      message: `目标位置已有指向其他位置的 symlink：${targetPath}`
    }
  } catch (error) {
    return {
      ...target,
      scope: 'user',
      bindingPath,
      state: 'error',
      message: errorMessage(error)
    }
  }
}

export class ManagedSkillService {
  constructor(
    private readonly repository: ArtifactService,
    private readonly context: DetectionContext
  ) {}

  private targets(): BindingTarget[] {
    return bindingTargetDefinitions(this.context)
  }

  private requireTarget(targetId: string): BindingTarget {
    if (typeof targetId !== 'string') throw new Error('Skill 绑定目标无效')
    const target = this.targets().find((candidate) => candidate.id === targetId)
    if (!target) throw new Error('Skill 绑定目标无效')
    return target
  }

  private async requireManagedArtifact(
    artifactDirectoryName: string
  ): Promise<ManagedArtifact> {
    const artifactPath = resolveArtifactDirectoryPath(
      this.repository.artifactsPath,
      artifactDirectoryName
    )
    const snapshot = await this.repository.refresh()
    const artifact = snapshot.artifacts.find(
      (candidate) => candidate.directoryName === artifactDirectoryName
    )
    if (!artifact) throw new Error('Artifact 不存在或需要刷新')
    if (!artifact.skill) throw new Error('该 Artifact 不是 Skill Artifact')
    return {
      artifactDirectoryName,
      artifactPath,
      skill: artifact.skill
    }
  }

  async getSnapshot(): Promise<ManagedSkillSnapshot> {
    const artifactSnapshot = await this.repository.refresh()
    const errors: ManagedSkillError[] = []
    const skills = await Promise.all(artifactSnapshot.artifacts.flatMap((artifact) => {
      if (!artifact.skill) return []
      const artifactPath = resolveArtifactDirectoryPath(
        this.repository.artifactsPath,
        artifact.directoryName
      )
      return [Promise.all(this.targets().map(async (target) => {
        const summary = await inspectBindingTarget(
          target,
          artifact.skill!.skillPath,
          artifact.skill!.name,
          artifact.skill!.issue
        )
        if (summary.state === 'error' && artifact.skill!.status === 'ready') {
          errors.push({
            artifactDirectoryName: artifact.directoryName,
            targetId: target.id,
            message: summary.message || '无法读取 Skill 绑定状态'
          })
        }
        return summary
      })).then((targets): ManagedSkillSummary => ({
        artifactDirectoryName: artifact.directoryName,
        artifactPath,
        ...artifact.skill!,
        targets
      }))]
    }))

    return {
      skills,
      errors: errors.sort((left, right) => (
        (left.artifactDirectoryName || '').localeCompare(right.artifactDirectoryName || '')
        || (left.targetId || '').localeCompare(right.targetId || '')
      )),
      scannedAt: new Date().toISOString()
    }
  }

  async readDocument(artifactDirectoryName: string): Promise<ManagedSkillDocument> {
    const artifact = await this.requireManagedArtifact(artifactDirectoryName)
    const document = await readArtifactSkillDocument(artifact.artifactPath)
    return {
      artifactDirectoryName,
      documentPath: document.documentPath,
      fileName: 'SKILL.md',
      content: document.content,
      sizeBytes: document.sizeBytes,
      modifiedAt: document.modifiedAt
    }
  }

  async getFolderPath(artifactDirectoryName: string): Promise<string> {
    const artifact = await this.requireManagedArtifact(artifactDirectoryName)
    let details
    try {
      details = await lstat(artifact.skill.skillPath)
    } catch (error) {
      if (missingPath(error)) throw new Error('Skill Artifact 已不存在')
      throw error
    }
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new Error('Skill Artifact 不再是可打开的真实目录')
    }
    return artifact.skill.skillPath
  }

  async bind(input: ManagedSkillBindingInput): Promise<ManagedSkillSnapshot> {
    const target = this.requireTarget(input?.targetId)
    const artifact = await this.requireManagedArtifact(input?.artifactDirectoryName)
    if (
      artifact.skill.status !== 'ready'
      || !validSkillName(artifact.skill.name)
      || !artifact.skill.documentPath
    ) {
      throw new Error(artifact.skill.issue || 'Skill Artifact 当前不能注入')
    }

    await mkdir(target.registrationRoot, { recursive: true })
    const rootDetails = await stat(target.registrationRoot)
    if (!rootDetails.isDirectory()) throw new Error('目标 Agent 的 Skill 注册根不是目录')

    const current = await inspectBindingTarget(
      target,
      artifact.skill.skillPath,
      artifact.skill.name
    )
    if (current.state === 'bound') return this.getSnapshot()
    if (current.state !== 'unbound') {
      throw new Error(current.message || '目标 Skill 位置存在冲突')
    }

    try {
      await symlink(
        resolve(artifact.skill.skillPath),
        current.bindingPath!,
        'dir'
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const afterConflict = await inspectBindingTarget(
        target,
        artifact.skill.skillPath,
        artifact.skill.name
      )
      if (afterConflict.state !== 'bound') {
        throw new Error(afterConflict.message || '目标 Skill 位置存在冲突')
      }
    }
    return this.getSnapshot()
  }

  async unbind(input: ManagedSkillBindingInput): Promise<ManagedSkillSnapshot> {
    const target = this.requireTarget(input?.targetId)
    const artifact = await this.requireManagedArtifact(input?.artifactDirectoryName)
    const current = await inspectBindingTarget(
      target,
      artifact.skill.skillPath,
      artifact.skill.name,
      artifact.skill.issue
    )
    if (current.state === 'unbound') return this.getSnapshot()
    if (current.state !== 'bound' || !current.bindingPath) {
      throw new Error(current.message || '目标位置不是 Oyster 可以解绑的 symlink')
    }

    const bindingPath = current.bindingPath
    let before
    try {
      before = await lstat(bindingPath)
    } catch (error) {
      if (missingPath(error)) return this.getSnapshot()
      throw error
    }
    if (!before.isSymbolicLink()) {
      throw new Error('目标位置不是 Oyster 可以解绑的 symlink')
    }

    const expectedSkillPath = resolve(artifact.skill.skillPath)
    let linkedPath
    try {
      linkedPath = resolve(dirname(bindingPath), await readlink(bindingPath))
    } catch (error) {
      if (missingPath(error)) return this.getSnapshot()
      throw error
    }
    if (linkedPath !== expectedSkillPath) {
      throw new Error('目标 symlink 已指向其他位置，Oyster 不会删除')
    }

    // Recheck the directory entry immediately before unlink. This cannot turn a
    // same-user filesystem into an isolation boundary, but avoids acting on an
    // entry that visibly changed during the operation.
    let after
    try {
      after = await lstat(bindingPath)
    } catch (error) {
      if (missingPath(error)) return this.getSnapshot()
      throw error
    }
    let linkedPathAfter
    try {
      linkedPathAfter = after.isSymbolicLink()
        ? resolve(dirname(bindingPath), await readlink(bindingPath))
        : undefined
    } catch (error) {
      if (missingPath(error)) return this.getSnapshot()
      throw error
    }
    if (
      !after.isSymbolicLink()
      || after.dev !== before.dev
      || after.ino !== before.ino
      || linkedPathAfter !== expectedSkillPath
    ) {
      throw new Error('目标 symlink 在解绑过程中发生变化，未删除任何内容')
    }

    try {
      await unlink(bindingPath)
    } catch (error) {
      if (!missingPath(error)) throw error
    }
    return this.getSnapshot()
  }
}

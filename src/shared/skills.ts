import type { AgentType } from './discovery'
import type { ArtifactSkillSummary } from './artifacts'

export const SKILL_SCOPES = ['user', 'project', 'admin', 'system', 'other'] as const

export type SkillScope = (typeof SKILL_SCOPES)[number]
export type SkillFormat = 'agent_skill' | 'legacy_markdown'

/** One filesystem-backed Skill registration discovered for one Agent. */
export interface DiscoveredSkill {
  id: string
  agentType: AgentType
  agentDisplayName: string
  name: string
  description?: string
  scope: SkillScope
  /** Directory whose project-level registration root contains this Skill. */
  projectPath?: string
  /** Logical registration directory shown to the user and opened on request. */
  directoryPath: string
  /** Absolute path of the Markdown entry document. */
  documentPath: string
  documentFileName: string
  format: SkillFormat
  sizeBytes: number
  modifiedAt: string
}

export interface SkillDiscoveryError {
  agentType: AgentType
  path: string
  message: string
}

export interface SkillDiscoverySnapshot {
  skills: DiscoveredSkill[]
  errors: SkillDiscoveryError[]
  scannedAt?: string
}

export interface SkillDocument {
  skillId: string
  documentPath: string
  fileName: string
  content: string
  sizeBytes: number
  modifiedAt: string
}

export type SkillBindingTargetState = 'unbound' | 'bound' | 'conflict' | 'error'

/** One application-controlled registration target for an Oyster-managed Skill. */
export interface SkillBindingTargetSummary {
  id: string
  agentType: AgentType
  agentDisplayName: string
  scope: 'user'
  registrationRoot: string
  bindingPath?: string
  state: SkillBindingTargetState
  /** Shared roots can make a binding visible to Agents other than the named target. */
  shared: boolean
  message?: string
}

/** A Skill Artifact projected into the dedicated Skill management application. */
export interface ManagedSkillSummary extends ArtifactSkillSummary {
  artifactDirectoryName: string
  artifactPath: string
  targets: SkillBindingTargetSummary[]
}

export interface ManagedSkillError {
  artifactDirectoryName?: string
  targetId?: string
  message: string
}

export interface ManagedSkillSnapshot {
  skills: ManagedSkillSummary[]
  errors: ManagedSkillError[]
  scannedAt?: string
}

export interface ManagedSkillDocument {
  artifactDirectoryName: string
  documentPath: string
  fileName: 'SKILL.md'
  content: string
  sizeBytes: number
  modifiedAt: string
}

export interface ManagedSkillBindingInput {
  artifactDirectoryName: string
  targetId: string
}

export interface SkillApi {
  getDiscoverySnapshot(): Promise<SkillDiscoverySnapshot>
  discover(): Promise<SkillDiscoverySnapshot>
  readDiscoveredDocument(skillId: string): Promise<SkillDocument>
  openDiscoveredFolder(skillId: string): Promise<void>
  getManagedSnapshot(): Promise<ManagedSkillSnapshot>
  readManagedDocument(artifactDirectoryName: string): Promise<ManagedSkillDocument>
  openManagedFolder(artifactDirectoryName: string): Promise<void>
  bindManagedSkill(input: ManagedSkillBindingInput): Promise<ManagedSkillSnapshot>
  unbindManagedSkill(input: ManagedSkillBindingInput): Promise<ManagedSkillSnapshot>
}

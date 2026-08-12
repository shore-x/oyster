/** Skill-specific application view declared by a standard root SKILL.md. */
export interface ArtifactSkillSummary {
  /** The Artifact root, which is also the standard Agent Skill directory. */
  skillPath: string
  documentPath: string
  name?: string
  description?: string
  status: 'ready' | 'invalid'
  issue?: string
}

export interface ArtifactSummary {
  /** The first-level directory name and the Artifact identity in the MVP. */
  directoryName: string
  /** Absolute path supplied to the generic folder browser. */
  directoryPath: string
  /** Complete Markdown content of the Artifact's root AGENTS.md. */
  attention: string
  /** Last modification time of the root AGENTS.md. */
  modifiedAt: string
  /** Present when this Artifact declares Skill intent with a root SKILL.md. */
  skill?: ArtifactSkillSummary
}

export interface ArtifactSnapshot {
  /** Absolute path to the one application-managed Oyster Repository. */
  repositoryPath: string
  artifacts: ArtifactSummary[]
  /** Visible first-level directories that do not contain a regular root AGENTS.md file. */
  invalidDirectories: string[]
}

export interface ArtifactApi {
  getSnapshot(): Promise<ArtifactSnapshot>
  refresh(): Promise<ArtifactSnapshot>
}

export interface ArtifactSummary {
  /** The first-level directory name and the Artifact identity in the MVP. */
  directoryName: string
  /** Complete Markdown content of the Artifact's root AGENTS.md. */
  attention: string
  /** Last modification time of the root AGENTS.md. */
  modifiedAt: string
}

export interface ArtifactSnapshot {
  /** Absolute path to the application-managed Artifact Repository. */
  repositoryPath: string
  artifacts: ArtifactSummary[]
  /** Visible first-level directories that do not contain a regular root AGENTS.md file. */
  invalidDirectories: string[]
}

export interface CreateArtifactInput {
  directoryName: string
  attention: string
}

export interface ArtifactApi {
  getSnapshot(): Promise<ArtifactSnapshot>
  refresh(): Promise<ArtifactSnapshot>
  createArtifact(input: CreateArtifactInput): Promise<ArtifactSnapshot>
  openRepository(): Promise<void>
  openArtifact(directoryName: string): Promise<void>
}

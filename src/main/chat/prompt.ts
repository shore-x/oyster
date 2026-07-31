export const DEFAULT_CHAT_AGENT_SYSTEM_PROMPT = `You are Oyster's general Agent.

Oyster's Knowledge Store contains Knowledge Statements. Each Statement has a canonical title naming an independently searchable subject and a self-explaining free-text body. Statement bodies may reference related Statements as [[canonical title]].`

export function chatAgentSystemPrompt(
  instructions: string,
  artifactRepositoryPath: string
): string {
  return `${instructions.trim()}

Oyster's Artifact Repository is located at:
${artifactRepositoryPath}

Filesystem and shell relative paths start from this directory. It is a standard Git Repository. Each visible first-level directory containing a root AGENTS.md file is an Artifact, and that file contains the Artifact's persistent Attention. Other internal structure is arbitrary. No Artifact is preselected.`
}

export const DEFAULT_CHAT_AGENT_SYSTEM_PROMPT = `You are Oyster's general Agent.

Work directly with Oyster's global Knowledge and Artifact layers. A Knowledge Statement has a canonical-title H1 naming an independently searchable subject and a self-explaining Markdown body. Statement bodies may reference related Statements as [[canonical title]].`

export function chatAgentSystemPrompt(
  instructions: string,
  repositoryPath: string
): string {
  return `${instructions.trim()}

Oyster's one Git Repository is located at:
${repositoryPath}

Filesystem and shell relative paths start from this directory. knowledge/**/*.md is the global Knowledge layer. artifacts/<artifact>/ is the global Artifact layer; each Artifact root AGENTS.md contains its persistent Attention and its other internal structure is arbitrary. runs/<run-id>/ contains Agent work history and never owns copies of Knowledge or Artifacts.`
}

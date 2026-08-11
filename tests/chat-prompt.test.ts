import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CHAT_AGENT_SYSTEM_PROMPT,
  chatAgentSystemPrompt
} from '../src/main/chat/prompt'

describe('general Agent prompt', () => {
  it('adds the three global repository layers to the configured instructions', () => {
    const repositoryPath = '/application-data/repository'

    expect(chatAgentSystemPrompt('  Custom general instructions.  ', repositoryPath)).toBe(
      `Custom general instructions.

Oyster's one Git Repository is located at:
/application-data/repository

Filesystem and shell relative paths start from this directory. knowledge/**/*.md is the global Knowledge layer. artifacts/<artifact>/ is the global Artifact layer; each Artifact root AGENTS.md contains its persistent Attention and local maintenance contract, while its other internal structure is arbitrary. tasks/<task-id>/ contains isolated Knowledge Processing Task workspaces and history, including task and input files, but never owns copies of Knowledge or Artifacts.`
    )
  })

  it('keeps the built-in instructions focused on the general identity and data model', () => {
    expect(DEFAULT_CHAT_AGENT_SYSTEM_PROMPT).toBe(
      `You are Oyster's general Agent.

Work directly with Oyster's global Knowledge and Artifact layers. A Knowledge Statement has a canonical-title H1 naming an independently searchable subject and a self-explaining Markdown body. Statement bodies may reference related Statements as [[canonical title]].`
    )
  })
})

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CHAT_AGENT_SYSTEM_PROMPT,
  chatAgentSystemPrompt
} from '../src/main/chat/prompt'

describe('general Agent prompt', () => {
  it('adds only the shared Artifact Repository facts to the configured instructions', () => {
    const repositoryPath = '/application-data/artifacts'

    expect(chatAgentSystemPrompt('  Custom general instructions.  ', repositoryPath)).toBe(
      `Custom general instructions.

Oyster's Artifact Repository is located at:
/application-data/artifacts

Filesystem and shell relative paths start from this directory. It is a standard Git Repository. Each visible first-level directory containing a root AGENTS.md file is an Artifact, and that file contains the Artifact's persistent Attention. Other internal structure is arbitrary. No Artifact is preselected.`
    )
  })

  it('keeps the built-in instructions focused on the general identity and data model', () => {
    expect(DEFAULT_CHAT_AGENT_SYSTEM_PROMPT).toBe(
      `You are Oyster's general Agent.

Oyster's Knowledge Store contains Knowledge Statements. Each Statement has a canonical title naming an independently searchable subject and a self-explaining free-text body. Statement bodies may reference related Statements as [[canonical title]].`
    )
  })
})

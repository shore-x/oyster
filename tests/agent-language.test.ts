import { describe, expect, it } from 'vitest'
import {
  agentLanguageInstruction,
  withAgentLanguage
} from '../src/main/agent-runtime/agent-language'

describe('Agent application language', () => {
  it('adds the selected language after the unchanged configured prompt', () => {
    const configuredPrompt = 'Preserve this configured prompt exactly.'
    const prompt = withAgentLanguage(configuredPrompt, 'en-US')

    expect(prompt).toBe(`${configuredPrompt}\n\n${agentLanguageInstruction('en-US')}`)
    expect(prompt).toContain('Agent output language: English.')
    expect(prompt).toContain('natural-language repository content')
  })

  it('uses Simplified Chinese without changing repository language constraints', () => {
    const instruction = agentLanguageInstruction('zh-CN')

    expect(instruction).toContain('Agent output language: Simplified Chinese.')
    expect(instruction).toContain('any language explicitly required by the repository or the task')
  })
})

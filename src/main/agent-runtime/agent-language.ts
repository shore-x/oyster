import type { AppLanguage } from '../../shared/app-settings'

export function agentLanguageInstruction(language: AppLanguage): string {
  const name = language === 'en-US' ? 'English' : 'Simplified Chinese'
  return `Application language: ${name}.

Use ${name} for user-facing replies and for natural-language repository content that you create or update. Preserve code identifiers, commands, paths, structured file formats, quoted source text, and any language explicitly required by the repository or the task. This language instruction applies to communication and repository maintenance; it does not change evidence boundaries or other task requirements.`
}

export function withAgentLanguage(prompt: string, language: AppLanguage): string {
  return `${prompt.trim()}\n\n${agentLanguageInstruction(language)}`
}

export function processingAgentDisplayName(agentId: string): string {
  if (agentId === 'knowledge_maintainer') return 'Maintainer'
  if (agentId === 'knowledge_reviewer') return 'Reviewer'
  return agentId
}

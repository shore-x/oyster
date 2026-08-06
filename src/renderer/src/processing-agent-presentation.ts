export function processingAgentDisplayName(agentId: string): string {
  if (agentId === 'knowledge_maintenance_agent') return 'Maintainer'
  if (agentId === 'knowledge_reviewer_agent') return 'Reviewer'
  return agentId
}

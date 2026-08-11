import { Type } from '@earendil-works/pi-ai'
import { createCodingTools } from '@earendil-works/pi-coding-agent'
import type { AgentToolDefinitionView } from '../../shared/knowledge-processing'
import { AGENT_TODO_TOOL_CATALOG } from '../agent-runtime/agent-todos'

export const spawnAgentParameters = Type.Object({
  instruction: Type.String({
    minLength: 1,
    description: 'The complete instruction for a new Agent Invocation. Include any context the new Agent needs.'
  })
}, { additionalProperties: false })

const CHAT_AGENT_TOOL_CATALOG = [
  {
    name: 'spawn_agent',
    label: '创建子 Agent',
    description: 'Invoke a delegated general Agent with an independent conversation context. The new Agent does not see the current conversation; required context must be included in the instruction. Returns its final response.',
    parameters: spawnAgentParameters
  },
  ...AGENT_TODO_TOOL_CATALOG
] as const

export type ChatAgentToolName = (typeof CHAT_AGENT_TOOL_CATALOG)[number]['name']

export function chatAgentToolDefinition<TName extends ChatAgentToolName>(name: TName): Extract<
  (typeof CHAT_AGENT_TOOL_CATALOG)[number],
  { name: TName }
> {
  const definition = CHAT_AGENT_TOOL_CATALOG.find((tool) => tool.name === name)
  if (!definition) throw new Error(`未知的对话 Agent 工具：${name}`)
  return definition as Extract<(typeof CHAT_AGENT_TOOL_CATALOG)[number], { name: TName }>
}

function serializableParameters(parameters: object): AgentToolDefinitionView['parameters'] {
  return JSON.parse(JSON.stringify(parameters)) as AgentToolDefinitionView['parameters']
}

export function chatAgentToolViews(repositoryPath: string): readonly AgentToolDefinitionView[] {
  return [
    ...createCodingTools(repositoryPath).map((tool) => ({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: serializableParameters(tool.parameters)
    })),
    ...CHAT_AGENT_TOOL_CATALOG.map((tool) => ({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: serializableParameters(tool.parameters)
    }))
  ]
}

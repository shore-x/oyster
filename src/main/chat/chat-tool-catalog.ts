import { Type } from '@earendil-works/pi-ai'
import { createCodingTools } from '@earendil-works/pi-coding-agent'
import {
  MAX_KNOWLEDGE_STATEMENT_CONTENT_LENGTH,
  MAX_KNOWLEDGE_STATEMENT_TITLE_LENGTH
} from '../../shared/knowledge'
import type { ProcessingToolView } from '../../shared/knowledge-processing'
import {
  knowledgeMaintenanceToolDefinition,
  readKnowledgeParameters,
  searchKnowledgeParameters
} from '../knowledge-processing/knowledge-maintenance-tool-catalog'

export const upsertKnowledgeParameters = Type.Object({
  statements: Type.Array(Type.Object({
    title: Type.String({
      minLength: 1,
      maxLength: MAX_KNOWLEDGE_STATEMENT_TITLE_LENGTH,
      description: 'The exact canonical title of one independently searchable named subject.'
    }),
    content: Type.String({
      minLength: 1,
      maxLength: MAX_KNOWLEDGE_STATEMENT_CONTENT_LENGTH,
      description: 'The complete self-explaining free-text body. Relationships may use [[canonical title]] references.'
    })
  }, { additionalProperties: false }), { minItems: 1 })
}, { additionalProperties: false })

export const spawnAgentParameters = Type.Object({
  task: Type.String({
    minLength: 1,
    description: 'The complete task to run in a new Agent context. Include any context the new Agent needs.'
  })
}, { additionalProperties: false })

const searchKnowledgeDefinition = knowledgeMaintenanceToolDefinition('search_knowledge')
const readKnowledgeDefinition = knowledgeMaintenanceToolDefinition('read_knowledge')

const CHAT_AGENT_TOOL_CATALOG = [
  {
    ...searchKnowledgeDefinition,
    parameters: searchKnowledgeParameters
  },
  {
    ...readKnowledgeDefinition,
    parameters: readKnowledgeParameters
  },
  {
    name: 'upsert_knowledge',
    label: '写入 Knowledge Statements',
    description: 'Atomically create or replace one or more Statements in the authoritative Knowledge Store. A canonical title is the identity key; existing content is replaced in full.',
    parameters: upsertKnowledgeParameters
  },
  {
    name: 'spawn_agent',
    label: '创建子 Agent',
    description: 'Run a delegated task in a new general Agent with an independent conversation context. The new Agent does not see the current conversation; required context must be included in the task. Returns its final response.',
    parameters: spawnAgentParameters
  }
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

function serializableParameters(parameters: object): ProcessingToolView['parameters'] {
  return JSON.parse(JSON.stringify(parameters)) as ProcessingToolView['parameters']
}

export function chatAgentToolViews(artifactRepositoryPath: string): readonly ProcessingToolView[] {
  return [
    ...createCodingTools(artifactRepositoryPath).map((tool) => ({
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

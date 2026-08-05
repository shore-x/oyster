import { Type } from '@earendil-works/pi-ai'
import {
  MAX_KNOWLEDGE_STATEMENT_CONTENT_LENGTH,
  MAX_KNOWLEDGE_STATEMENT_TITLE_LENGTH
} from '../../shared/knowledge'
import type { ProcessingToolView } from '../../shared/knowledge-processing'
import { AGENT_TODO_TOOL_CATALOG } from '../agent-runtime/agent-todos'

export const MAX_KNOWLEDGE_SEARCH_RESULTS = 20
export const MAX_KNOWLEDGE_WORKSPACE_LIST_RESULTS = 100

export const searchKnowledgeParameters = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 1_024 }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_KNOWLEDGE_SEARCH_RESULTS })),
  offset: Type.Optional(Type.Integer({ minimum: 0 }))
}, { additionalProperties: false })

export const readKnowledgeParameters = Type.Object({
  title: Type.String({ minLength: 1, maxLength: MAX_KNOWLEDGE_STATEMENT_TITLE_LENGTH })
}, { additionalProperties: false })

export const readEvidenceParameters = Type.Object({
  line: Type.Integer({ minimum: 1 }),
  offset: Type.Integer({ minimum: 0 }),
  limit: Type.Integer({ minimum: 2 })
}, { additionalProperties: false })

export const contributionStatementParameters = Type.Object({
  title: Type.String({
    minLength: 1,
    maxLength: MAX_KNOWLEDGE_STATEMENT_TITLE_LENGTH,
    description: 'The established proper name, term, or natural noun phrase that identifies this Statement subject. Put scenarios, attributes, and relationships in content instead of turning them into a topic-style title.'
  }),
  content: Type.String({
    minLength: 1,
    maxLength: MAX_KNOWLEDGE_STATEMENT_CONTENT_LENGTH,
    description: 'The self-explaining free-text knowledge about the named subject, including its scope, properties, constraints, and natural-language relationships to [[other Statements]].'
  })
}, { additionalProperties: false })

export const readContributionStatementParameters = Type.Object({
  title: Type.String({ minLength: 1, maxLength: MAX_KNOWLEDGE_STATEMENT_TITLE_LENGTH })
}, { additionalProperties: false })

export const listContributionStatementsParameters = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_KNOWLEDGE_WORKSPACE_LIST_RESULTS })),
  offset: Type.Optional(Type.Integer({ minimum: 0 }))
}, { additionalProperties: false })

export const removeContributionStatementParameters = Type.Object({
  title: Type.String({ minLength: 1, maxLength: MAX_KNOWLEDGE_STATEMENT_TITLE_LENGTH })
}, { additionalProperties: false })

/**
 * Runtime tool definitions are the single source for both Pi AgentTool construction
 * and the read-only developer view. Keep parameter schemas here, beside metadata,
 * so the UI cannot silently drift from what the model actually receives.
 */
export const KNOWLEDGE_MAINTENANCE_TOOL_CATALOG = [
  {
    name: 'search_knowledge',
    label: '搜索已有知识',
    description: '按标题和正文文本搜索当前 Knowledge Statement，返回有界的候选列表；结果给出 Next offset 时可用相同 query 继续读取。',
    parameters: searchKnowledgeParameters
  },
  {
    name: 'read_knowledge',
    label: '读取 Knowledge Statement',
    description: '按完整 canonical title 精确读取当前 Knowledge Statement。正文中的 [[canonical title]] 引用可用同一工具继续展开。',
    parameters: readKnowledgeParameters
  },
  {
    name: 'upsert_contribution_statement',
    label: '写入 Contribution 草稿',
    description: 'Stage or replace one free-text Statement in the run-local Contribution Draft. The title names one searchable subject; its context, attributes, and relationships belong in the body. This does not write to the knowledge Store.',
    parameters: contributionStatementParameters
  },
  {
    name: 'read_contribution_statement',
    label: '读取 Contribution 草稿',
    description: '按 canonical title 读取本次运行中已经暂存的完整 Statement 草稿。',
    parameters: readContributionStatementParameters
  },
  {
    name: 'list_contribution_statements',
    label: '查看 Contribution 草稿',
    description: '分页查看本次运行已经暂存的 Statement 标题和正文预览。',
    parameters: listContributionStatementsParameters
  },
  {
    name: 'remove_contribution_statement',
    label: '移除 Contribution 草稿',
    description: '从本次运行的 Contribution Draft 移除一条尚未提交的 Statement。',
    parameters: removeContributionStatementParameters
  },
  {
    name: 'read_evidence',
    label: '读取原始观察证据',
    description: '从 Todo 中记录的原始行与行内 offset 开始读取有界 Observation；offset 和 limit 使用 UTF-16 code unit，limit 至少为 2，并在需要时直接使用返回的 Next 位置续读。',
    parameters: readEvidenceParameters
  },
  ...AGENT_TODO_TOOL_CATALOG
] as const

export type KnowledgeMaintenanceToolName = (typeof KNOWLEDGE_MAINTENANCE_TOOL_CATALOG)[number]['name']

type KnowledgeMaintenanceToolDefinition<TName extends KnowledgeMaintenanceToolName> = Extract<
  (typeof KNOWLEDGE_MAINTENANCE_TOOL_CATALOG)[number],
  { name: TName }
>

export function knowledgeMaintenanceToolDefinition<TName extends KnowledgeMaintenanceToolName>(
  name: TName
): KnowledgeMaintenanceToolDefinition<TName> {
  const definition = KNOWLEDGE_MAINTENANCE_TOOL_CATALOG.find((tool) => tool.name === name)
  if (!definition) throw new Error(`未知的 Knowledge Maintenance Agent 工具：${name}`)
  return definition as KnowledgeMaintenanceToolDefinition<TName>
}

function serializableParameters(parameters: object): ProcessingToolView['parameters'] {
  return JSON.parse(JSON.stringify(parameters)) as ProcessingToolView['parameters']
}

/** Only JSON-safe data crosses the main/renderer boundary. */
export const KNOWLEDGE_MAINTENANCE_TOOL_VIEWS: readonly ProcessingToolView[] =
  KNOWLEDGE_MAINTENANCE_TOOL_CATALOG.map((tool) => ({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: serializableParameters(tool.parameters)
  }))

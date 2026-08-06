import { Type } from '@earendil-works/pi-ai'
import { createCodingTools } from '@earendil-works/pi-coding-agent'
import type { ProcessingToolView } from '../../shared/knowledge-processing'

export const readEvidenceParameters = Type.Object({
  line: Type.Integer({ minimum: 1 }),
  offset: Type.Integer({ minimum: 0 }),
  limit: Type.Integer({ minimum: 2 })
}, { additionalProperties: false })

export const readActivityParameters = Type.Object({
  activity: Type.Integer({ minimum: 1 }),
  offset: Type.Integer({ minimum: 0 }),
  limit: Type.Integer({ minimum: 1 })
}, { additionalProperties: false })

export const readActivityAttachmentParameters = Type.Object({
  id: Type.String({ pattern: '^ATT[0-9]{6}$' })
}, { additionalProperties: false })

export const KNOWLEDGE_MAINTENANCE_TOOL_CATALOG = [
  {
    name: 'read_activity',
    label: '读取规范活动',
    description: '从工作清单指定的 Canonical Activity 与行内 offset 开始读取确定性、可回查的有界活动视图。',
    parameters: readActivityParameters
  },
  {
    name: 'read_activity_attachment',
    label: '读取活动附件',
    description: '按 Canonical Activity 中的 Attachment ID 把二进制图片作为真正的模型图片输入读取。',
    parameters: readActivityAttachmentParameters
  },
  {
    name: 'read_evidence',
    label: '读取原始观察证据',
    description: '按 Canonical Activity 给出的 Raw source locator 回查有界原始 Observation。',
    parameters: readEvidenceParameters
  }
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

function view(tool: {
  name: string
  label: string
  description: string
  parameters: object
}): ProcessingToolView {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: JSON.parse(JSON.stringify(tool.parameters)) as ProcessingToolView['parameters']
  }
}

const CODING_TOOL_VIEWS = createCodingTools('.').map(view)

export const KNOWLEDGE_MAINTENANCE_TOOL_VIEWS: readonly ProcessingToolView[] = [
  ...CODING_TOOL_VIEWS,
  ...KNOWLEDGE_MAINTENANCE_TOOL_CATALOG.map(view)
]

export const KNOWLEDGE_REVIEWER_TOOL_VIEWS: readonly ProcessingToolView[] = CODING_TOOL_VIEWS

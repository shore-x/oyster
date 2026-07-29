import type { ProcessingToolView } from '../../shared/knowledge-processing'

export const KNOWLEDGE_MAINTENANCE_TOOL_CATALOG = [
  {
    name: 'search_knowledge',
    label: '搜索已有知识',
    description: '按标题和正文文本搜索当前 Knowledge Statement，返回有界的候选列表；结果给出 Next offset 时可用相同 query 继续读取。'
  },
  {
    name: 'read_knowledge_statement',
    label: '读取 Knowledge Statement',
    description: '按完整 canonical title 精确读取当前 Knowledge Statement。正文中的 [[canonical title]] 引用可用同一工具继续展开。'
  },
  {
    name: 'list_statement_candidates',
    label: '查看 Statement 候选',
    description: '分页读取 Host 持有的开放调查清单。候选不是拟定的 canonical title，也不与 Statement 一一对应。'
  },
  {
    name: 'add_statement_candidates',
    label: '补充 Statement 候选',
    description: '把调查中新发现的名称、指代或必要背景问题加入开放清单；这不会创建 Knowledge Statement。'
  },
  {
    name: 'resolve_statement_candidates',
    label: '裁决 Statement 候选',
    description: '批量记录候选已经过调查及其自由文本处置结论；它不自动写入或更新 Statement。'
  },
  {
    name: 'upsert_contribution_statement',
    label: '写入 Contribution 草稿',
    description: 'Stage or replace one free-text Statement in the run-local Contribution Draft. The title names one searchable subject; its context, attributes, and relationships belong in the body. This does not write to the knowledge Store.'
  },
  {
    name: 'read_contribution_statement',
    label: '读取 Contribution 草稿',
    description: '按 canonical title 读取本次运行中已经暂存的完整 Statement 草稿。'
  },
  {
    name: 'list_contribution_statements',
    label: '查看 Contribution 草稿',
    description: '分页查看本次运行已经暂存的 Statement 标题和正文预览。'
  },
  {
    name: 'remove_contribution_statement',
    label: '移除 Contribution 草稿',
    description: '从本次运行的 Contribution Draft 移除一条尚未提交的 Statement。'
  },
  {
    name: 'read_evidence',
    label: '读取原始观察证据',
    description: '从候选提供的原始行与行内 offset 开始读取有界 Observation；offset 和 limit 使用 UTF-16 code unit，limit 至少为 2，并在需要时直接使用返回的 Next 位置续读。'
  },
  {
    name: 'submit_knowledge_contribution',
    label: '提交 Knowledge Contribution',
    description: '在所有 Statement 候选均已明确处置后，原子提交当前 Contribution Draft；开放候选仍存在时不会结束 Agent。'
  }
] as const satisfies readonly ProcessingToolView[]

export type KnowledgeMaintenanceToolName = (typeof KNOWLEDGE_MAINTENANCE_TOOL_CATALOG)[number]['name']

export function knowledgeMaintenanceToolMetadata<TName extends KnowledgeMaintenanceToolName>(
  name: TName
): ProcessingToolView & { name: TName } {
  const metadata = KNOWLEDGE_MAINTENANCE_TOOL_CATALOG.find((tool) => tool.name === name)
  if (!metadata) throw new Error(`未知的 Knowledge Maintenance Agent 工具：${name}`)
  return metadata as ProcessingToolView & { name: TName }
}

import { describe, expect, it } from 'vitest'
import {
  KNOWLEDGE_MAINTENANCE_TOOL_CATALOG,
  KNOWLEDGE_MAINTENANCE_TOOL_VIEWS,
  KNOWLEDGE_REVIEWER_TOOL_VIEWS,
  knowledgeMaintenanceToolDefinition,
  readActivityParameters,
  readEvidenceParameters
} from '../src/main/knowledge-processing/knowledge-maintenance-tool-catalog'
import { AGENT_TODO_TOOL_CATALOG } from '../src/main/agent-runtime/agent-todos'

describe('Knowledge collaboration tool catalog', () => {
  it('adds observation tools only to the Maintainer coding-tool surface', () => {
    expect(KNOWLEDGE_MAINTENANCE_TOOL_VIEWS.map((tool) => tool.name)).toEqual([
      'read', 'bash', 'edit', 'write',
      'read_activity', 'read_activity_attachment', 'read_evidence'
    ])
    expect(KNOWLEDGE_REVIEWER_TOOL_VIEWS.map((tool) => tool.name)).toEqual([
      'read', 'bash', 'edit', 'write'
    ])
    expect(KNOWLEDGE_MAINTENANCE_TOOL_VIEWS.slice(-3)).toEqual(
      KNOWLEDGE_MAINTENANCE_TOOL_CATALOG.map((tool) => ({
        name: tool.name,
        label: tool.label,
        description: tool.description,
        parameters: JSON.parse(JSON.stringify(tool.parameters))
      }))
    )
    expect(structuredClone(KNOWLEDGE_MAINTENANCE_TOOL_VIEWS))
      .toEqual(KNOWLEDGE_MAINTENANCE_TOOL_VIEWS)
  })

  it('uses the catalog schema itself when constructing observation tools', () => {
    expect(knowledgeMaintenanceToolDefinition('read_activity').parameters)
      .toBe(readActivityParameters)
    expect(knowledgeMaintenanceToolDefinition('read_evidence').parameters)
      .toBe(readEvidenceParameters)
  })

  it('keeps Todo implementation available without installing it in either Agent', () => {
    const todoNames = AGENT_TODO_TOOL_CATALOG.map((tool) => tool.name)
    const installedNames = [
      ...KNOWLEDGE_MAINTENANCE_TOOL_VIEWS,
      ...KNOWLEDGE_REVIEWER_TOOL_VIEWS
    ].map((tool) => tool.name)

    expect(todoNames).toEqual(['add_todos', 'complete_todos', 'list_todos'])
    expect(installedNames.filter((name) => todoNames.includes(name as never))).toEqual([])
  })

  it('retains deterministic location constraints in projected schemas', () => {
    expect(knowledgeMaintenanceToolDefinition('read_activity').parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['activity', 'offset', 'limit'],
      properties: {
        activity: { type: 'integer', minimum: 1 },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1 }
      }
    })
    expect(knowledgeMaintenanceToolDefinition('read_evidence').parameters).toMatchObject({
      required: ['line', 'offset', 'limit'],
      properties: {
        line: { type: 'integer', minimum: 1 },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 2 }
      }
    })
  })
})

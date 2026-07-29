import { describe, expect, it } from 'vitest'
import {
  KNOWLEDGE_MAINTENANCE_TOOL_CATALOG,
  KNOWLEDGE_MAINTENANCE_TOOL_VIEWS,
  addStatementCandidatesParameters,
  knowledgeMaintenanceToolDefinition,
  searchKnowledgeParameters
} from '../src/main/knowledge-processing/knowledge-maintenance-tool-catalog'

describe('Knowledge Maintenance tool catalog', () => {
  it('projects the runtime parameter schemas into JSON-safe developer views', () => {
    expect(KNOWLEDGE_MAINTENANCE_TOOL_VIEWS).toEqual(
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

  it('uses the catalog schema itself when constructing a runtime tool', () => {
    expect(knowledgeMaintenanceToolDefinition('search_knowledge').parameters)
      .toBe(searchKnowledgeParameters)
    expect(knowledgeMaintenanceToolDefinition('add_statement_candidates').parameters)
      .toBe(addStatementCandidatesParameters)
  })

  it('retains required fields, nested objects, and constraints', () => {
    const searchView = KNOWLEDGE_MAINTENANCE_TOOL_VIEWS.find(
      (tool) => tool.name === 'search_knowledge'
    )
    expect(searchView?.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 1_024 },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
        offset: { type: 'integer', minimum: 0 }
      }
    })

    const candidatesView = KNOWLEDGE_MAINTENANCE_TOOL_VIEWS.find(
      (tool) => tool.name === 'add_statement_candidates'
    )
    expect(candidatesView?.parameters).toMatchObject({
      required: ['candidates'],
      properties: {
        candidates: {
          type: 'array',
          items: {
            required: ['expression', 'question'],
            properties: {
              expression: { type: 'string', minLength: 1, maxLength: 512 },
              question: { type: 'string', minLength: 1, maxLength: 16 * 1_024 },
              locations: {
                type: 'array',
                items: {
                  required: ['line', 'offset'],
                  properties: {
                    line: { type: 'integer', minimum: 1 },
                    offset: { type: 'integer', minimum: 0 }
                  }
                }
              }
            }
          }
        }
      }
    })
  })
})

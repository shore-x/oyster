import { describe, expect, it } from 'vitest'
import {
  KNOWLEDGE_MAINTENANCE_TOOL_CATALOG,
  KNOWLEDGE_MAINTENANCE_TOOL_VIEWS,
  knowledgeMaintenanceToolDefinition,
  searchKnowledgeParameters
} from '../src/main/knowledge-processing/knowledge-maintenance-tool-catalog'
import { addTodosParameters } from '../src/main/agent-runtime/agent-todos'
import { chatAgentToolViews } from '../src/main/chat/chat-tool-catalog'

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
    expect(knowledgeMaintenanceToolDefinition('add_todos').parameters)
      .toBe(addTodosParameters)
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

    const todosView = KNOWLEDGE_MAINTENANCE_TOOL_VIEWS.find(
      (tool) => tool.name === 'add_todos'
    )
    expect(todosView?.parameters).toMatchObject({
      required: ['todos'],
      properties: {
        todos: {
          type: 'array',
          items: { type: 'string', minLength: 1, maxLength: 64 * 1_024 }
        }
      }
    })
  })

  it('exposes the same three general Todo tools from every built-in Agent', () => {
    const todoNames = ['add_todos', 'complete_todos', 'list_todos']
    const knowledgeNames = KNOWLEDGE_MAINTENANCE_TOOL_VIEWS.map((tool) => tool.name)
    const chatNames = chatAgentToolViews('/tmp/oyster-artifacts').map((tool) => tool.name)

    expect(knowledgeNames.filter((name) => todoNames.includes(name))).toEqual(todoNames)
    expect(chatNames.filter((name) => todoNames.includes(name))).toEqual(todoNames)
  })
})

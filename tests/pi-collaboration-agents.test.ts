import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
  type FauxResponseStep
} from '@earendil-works/pi-ai'
import type { SelectedModelStream } from '../src/main/ai-backends/model'
import {
  PiKnowledgeMaintainerAgent,
  PiKnowledgeReviewerAgent
} from '../src/main/knowledge-processing/pi-collaboration-agents'
import {
  KnowledgeTaskWorkspaceRepository,
  type KnowledgeTaskWorkspace
} from '../src/main/knowledge-processing/knowledge-task-workspace-repository'
import { planKnowledgeTaskWorkspace } from '../src/main/knowledge-processing/task-workspace'

const temporaryDirectories: string[] = []

async function taskWorkspace(): Promise<KnowledgeTaskWorkspace> {
  const repositoryPath = await mkdtemp(join(tmpdir(), 'oyster-pi-collaboration-'))
  temporaryDirectories.push(repositoryPath)
  const workspacePath = join(repositoryPath, 'tasks', 'workspace-test')
  const inputPath = join(workspacePath, 'inputs')
  await mkdir(inputPath, { recursive: true })
  await writeFile(join(workspacePath, 'BRIEF.md'), '# Brief\n\nWorkspace-specific instruction.\n')
  await writeFile(join(workspacePath, 'PROGRESS.md'), '# Progress\n')
  return {
    taskId: 'workspace-test',
    repositoryPath,
    workspacePath,
    briefPath: join(workspacePath, 'BRIEF.md'),
    progressPath: join(workspacePath, 'PROGRESS.md'),
    inputPath,
    workspaceRevision: 'd'.repeat(64),
    targetBranch: 'main',
    branchName: 'knowledge-task/workspace-test',
    baseRepositoryRevision: 'a'.repeat(40)
  }
}

function fauxModelStream(responses: FauxResponseStep[], image = false): SelectedModelStream {
  const faux = fauxProvider()
  faux.setResponses(responses)
  const models = createModels()
  models.setProvider(faux.provider)
  return {
    model: {
      ...faux.getModel(),
      contextWindow: 128_000,
      ...(image ? { input: ['text', 'image'] as const } : {})
    },
    streamFn: (model, context, options) => models.streamSimple(model, context, options)
  }
}

function contextText(context: Context): string {
  return JSON.stringify(context.messages)
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => rm(directory, { recursive: true, force: true })
  ))
})

describe('Pi collaboration Agents', () => {
  it('gives the Maintainer only ordinary tools rooted in its Task workspace', async () => {
    const workspace = await taskWorkspace()
    const modelStream = fauxModelStream([
      (context) => {
        expect(context.tools?.map((tool) => tool.name)).toEqual([
          'read', 'bash', 'edit', 'write'
        ])
        expect(contextText(context)).toContain('current working directory')
        expect(contextText(context)).toContain('BRIEF.md and PROGRESS.md')
        expect(contextText(context)).not.toContain('canonical activity')
        expect(contextText(context)).not.toContain('read_evidence')
        expect(contextText(context)).not.toContain('list_todos')
        return fauxAssistantMessage(
          fauxToolCall('read', { path: 'BRIEF.md' }),
          { stopReason: 'toolUse' }
        )
      },
      (context) => {
        expect(contextText(context)).toContain('Workspace-specific instruction.')
        return fauxAssistantMessage('Maintainer handoff committed.')
      }
    ])

    const result = await new PiKnowledgeMaintainerAgent().invoke({
      modelStream,
      systemPrompt: 'Maintain the collaboration tree.',
      workspace,
      previousRepositoryRevision: workspace.baseRepositoryRevision,
      invocationId: 'maintainer-invocation',
      signal: new AbortController().signal
    })

    expect(result.toolCalls).toEqual(['read'])
  })

  it('gives the Reviewer the same ordinary tools without injecting Observation content', async () => {
    const workspace = await taskWorkspace()
    const modelStream = fauxModelStream([
      (context) => {
        expect(context.tools?.map((tool) => tool.name)).toEqual([
          'read', 'bash', 'edit', 'write'
        ])
        expect(contextText(context)).toContain('latest Maintainer handoff in PROGRESS.md')
        expect(contextText(context)).not.toContain('read_evidence')
        expect(contextText(context)).not.toContain('Raw Evidence format')
        expect(contextText(context)).not.toContain('list_todos')
        return fauxAssistantMessage('Reviewer approved the exact revision.')
      }
    ])

    const result = await new PiKnowledgeReviewerAgent().invoke({
      modelStream,
      systemPrompt: 'Review the collaboration tree without reading inputs/.',
      workspace,
      reviewedRepositoryRevision: 'c'.repeat(40),
      invocationId: 'reviewer-invocation',
      signal: new AbortController().signal
    })

    expect(result.toolCalls).toEqual([])
  })

  it('uses the ordinary read tool to send a materialized image to the model', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'oyster-pi-image-workspace-'))
    temporaryDirectories.push(repositoryPath)
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z0Z8AAAAASUVORK5CYII=',
      'base64'
    )
    const workspacePlan = planKnowledgeTaskWorkspace({
      rawEvidence: {
        formatVersion: 'test-raw-v1',
        lines: ['image'],
        skillHints: []
      },
      canonicalActivity: {
        formatVersion: 'test-activity-v1',
        items: [{
          kind: 'attachment',
          content: 'image',
          rawRanges: [{ start: { line: 1, offset: 0 }, end: { line: 1, offset: 5 } }],
          attachmentId: 'ATT000001'
        }],
        attachments: [{
          id: 'ATT000001',
          mimeType: 'image/png',
          data: png.toString('base64'),
          byteLength: png.byteLength,
          sha256: createHash('sha256').update(png).digest('hex'),
          rawRange: { start: { line: 1, offset: 0 }, end: { line: 1, offset: 5 } }
        }]
      }
    }, 'raw:image@fixture', 100)
    const workspace = await new KnowledgeTaskWorkspaceRepository(repositoryPath).createWorkspace({
      taskId: 'image-workspace',
      sourceRef: 'raw:image@fixture',
      workspace: workspacePlan
    })
    const modelStream = fauxModelStream([
      () => fauxAssistantMessage(
        fauxToolCall('read', { path: 'inputs/attachments/ATT000001.png' }),
        { stopReason: 'toolUse' }
      ),
      (context) => {
        const last = context.messages.at(-1)
        if (last?.role !== 'toolResult' || !last.content.some((item) => item.type === 'image')) {
          throw new Error(`Unexpected image tool result: ${JSON.stringify(last)}`)
        }
        return fauxAssistantMessage('Image inspected.')
      }
    ], true)

    const result = await new PiKnowledgeMaintainerAgent().invoke({
      modelStream,
      systemPrompt: 'Maintain the collaboration tree.',
      workspace,
      previousRepositoryRevision: workspace.baseRepositoryRevision,
      invocationId: 'maintainer-image-invocation',
      signal: new AbortController().signal
    })

    expect(result.toolCalls).toEqual(['read'])
  })
})

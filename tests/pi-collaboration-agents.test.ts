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
import type { ModelRuntime } from '../src/main/ai-backends/model'
import {
  PiKnowledgeMaintainerAgent,
  PiKnowledgeReviewerAgent
} from '../src/main/knowledge-processing/pi-collaboration-agents'
import {
  ProcessingRepository,
  type ProcessingRun
} from '../src/main/knowledge-processing/processing-repository'
import { planKnowledgeRunWorkspace } from '../src/main/knowledge-processing/run-workspace'

const temporaryDirectories: string[] = []

async function processingRun(): Promise<ProcessingRun> {
  const repositoryPath = await mkdtemp(join(tmpdir(), 'oyster-pi-collaboration-'))
  temporaryDirectories.push(repositoryPath)
  const runPath = join(repositoryPath, 'runs', 'workspace-test')
  const inputPath = join(runPath, 'inputs')
  await mkdir(inputPath, { recursive: true })
  await writeFile(join(runPath, 'TASK.md'), '# Task\n\nWorkspace-specific instruction.\n')
  await writeFile(join(runPath, 'WORK.md'), '# Work\n')
  return {
    id: 'workspace-test',
    repositoryPath,
    runPath,
    taskPath: join(runPath, 'TASK.md'),
    workPath: join(runPath, 'WORK.md'),
    inputPath,
    workspaceRevision: 'd'.repeat(64),
    targetBranch: 'main',
    branchName: 'processing/test',
    baseRevision: 'a'.repeat(40)
  }
}

function fauxRuntime(responses: FauxResponseStep[], image = false): ModelRuntime {
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
  it('gives the Maintainer only ordinary tools rooted in its Run workspace', async () => {
    const run = await processingRun()
    const runtime = fauxRuntime([
      (context) => {
        expect(context.tools?.map((tool) => tool.name)).toEqual([
          'read', 'bash', 'edit', 'write'
        ])
        expect(contextText(context)).toContain('current working directory')
        expect(contextText(context)).toContain('TASK.md and WORK.md')
        expect(contextText(context)).not.toContain('canonical activity')
        expect(contextText(context)).not.toContain('read_evidence')
        expect(contextText(context)).not.toContain('list_todos')
        return fauxAssistantMessage(
          fauxToolCall('read', { path: 'TASK.md' }),
          { stopReason: 'toolUse' }
        )
      },
      (context) => {
        expect(contextText(context)).toContain('Workspace-specific instruction.')
        return fauxAssistantMessage('Maintainer handoff committed.')
      }
    ])

    const result = await new PiKnowledgeMaintainerAgent().run({
      runtime,
      systemPrompt: 'Maintain the collaboration tree.',
      run,
      previousRevision: run.baseRevision,
      runId: 'maintainer-run',
      signal: new AbortController().signal
    })

    expect(result.toolCalls).toEqual(['read'])
  })

  it('gives the Reviewer the same ordinary tools without injecting Observation content', async () => {
    const run = await processingRun()
    const runtime = fauxRuntime([
      (context) => {
        expect(context.tools?.map((tool) => tool.name)).toEqual([
          'read', 'bash', 'edit', 'write'
        ])
        expect(contextText(context)).toContain('latest Maintainer handoff in WORK.md')
        expect(contextText(context)).not.toContain('read_evidence')
        expect(contextText(context)).not.toContain('Raw Evidence format')
        expect(contextText(context)).not.toContain('list_todos')
        return fauxAssistantMessage('Reviewer approved the exact revision.')
      }
    ])

    const result = await new PiKnowledgeReviewerAgent().run({
      runtime,
      systemPrompt: 'Review the collaboration tree without reading inputs/.',
      run,
      reviewedRevision: 'c'.repeat(40),
      runId: 'reviewer-run',
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
    const workspace = planKnowledgeRunWorkspace({
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
    const run = await new ProcessingRepository(repositoryPath).createRun({
      id: 'image-workspace',
      sourceRef: 'raw:image@fixture',
      workspace
    })
    const runtime = fauxRuntime([
      () => fauxAssistantMessage(
        fauxToolCall('read', { path: 'inputs/attachments/ATT000001.png' }),
        { stopReason: 'toolUse' }
      ),
      (context) => {
        expect(contextText(context)).toContain('"type":"image"')
        return fauxAssistantMessage('Image inspected.')
      }
    ], true)

    const result = await new PiKnowledgeMaintainerAgent().run({
      runtime,
      systemPrompt: 'Maintain the collaboration tree.',
      run,
      previousRevision: run.baseRevision,
      runId: 'maintainer-image-run',
      signal: new AbortController().signal
    })

    expect(result.toolCalls).toEqual(['read'])
  })
})

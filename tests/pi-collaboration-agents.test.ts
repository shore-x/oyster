import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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
  KnowledgeTaskGitRepository,
  TASK_FILE_NAME,
  type KnowledgeTaskWorktree
} from '../src/main/knowledge-processing/knowledge-task-git-repository'
import { planKnowledgeTaskInput } from '../src/main/knowledge-processing/task-input'
import { runArtifactGit } from '../src/main/artifacts/git-runtime'

const temporaryDirectories: string[] = []

async function taskWorktree(): Promise<KnowledgeTaskWorktree> {
  const repositoryPath = await mkdtemp(join(tmpdir(), 'oyster-pi-collaboration-'))
  temporaryDirectories.push(repositoryPath)
  const taskPath = join(repositoryPath, 'tasks', 'worktree-test')
  const inputPath = join(taskPath, 'inputs')
  await mkdir(inputPath, { recursive: true })
  await writeFile(join(taskPath, 'TASK.md'), '# Task\n\nWorktree-specific instruction.\n')
  return {
    taskId: 'worktree-test',
    repositoryPath,
    worktreePath: repositoryPath,
    runtimePath: join(repositoryPath, '.runtime'),
    taskPath,
    inputPath,
    targetBranch: 'main',
    branchName: 'task/worktree-test',
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
  it('gives the Maintainer only ordinary tools rooted in its Task worktree', async () => {
    const worktree = await taskWorktree()
    const modelStream = fauxModelStream([
      (context) => {
        expect(context.tools?.map((tool) => tool.name)).toEqual([
          'read', 'bash', 'edit', 'write'
        ])
        expect(contextText(context)).toContain('current working directory')
        expect(contextText(context)).toContain('tasks/worktree-test/TASK.md')
        expect(contextText(context)).not.toContain('canonical activity')
        expect(contextText(context)).not.toContain('read_evidence')
        expect(contextText(context)).not.toContain('list_todos')
        return fauxAssistantMessage(
          fauxToolCall('read', { path: 'tasks/worktree-test/TASK.md' }),
          { stopReason: 'toolUse' }
        )
      },
      (context) => {
        expect(contextText(context)).toContain('Worktree-specific instruction.')
        return fauxAssistantMessage('Maintainer handoff committed.')
      }
    ])

    const result = await new PiKnowledgeMaintainerAgent().invoke({
      modelStream,
      systemPrompt: 'Maintain the collaboration tree.',
      worktree,
      validateHandoff: async () => undefined,
      previousRepositoryRevision: worktree.baseRepositoryRevision,
      sourceRef: 'raw:fixture@sha256:test',
      invocationId: 'maintainer-invocation',
      signal: new AbortController().signal
    })

    expect(result.toolCalls).toEqual(['read'])
  })

  it('gives the Reviewer the same ordinary tools without injecting Observation content', async () => {
    const worktree = await taskWorktree()
    const modelStream = fauxModelStream([
      (context) => {
        expect(context.tools?.map((tool) => tool.name)).toEqual([
          'read', 'bash', 'edit', 'write'
        ])
        expect(context.systemPrompt).toContain('Agent output language: English.')
        expect(contextText(context)).toContain(`Review exact Task revision ${'c'.repeat(40)}`)
        expect(contextText(context)).toContain(`clean target checkout used for final integration is \\"${worktree.repositoryPath}\\"`)
        expect(contextText(context)).toContain(`Task branch is \\"${worktree.branchName}\\"`)
        expect(contextText(context)).not.toContain('read_evidence')
        expect(contextText(context)).not.toContain('Raw Evidence format')
        expect(contextText(context)).not.toContain('list_todos')
        return fauxAssistantMessage('Reviewer approved the exact revision.')
      }
    ])

    const result = await new PiKnowledgeReviewerAgent(undefined, () => 'en-US').invoke({
      modelStream,
      systemPrompt: 'Review the collaboration tree without reading inputs/.',
      worktree,
      validateHandoff: async () => undefined,
      reviewedRepositoryRevision: 'c'.repeat(40),
      invocationId: 'reviewer-invocation',
      signal: new AbortController().signal
    })

    expect(result.toolCalls).toEqual([])
  })

  it('returns a failed Maintainer handoff to the same Pi Session before completing', async () => {
    const worktree = await taskWorktree()
    let checks = 0
    const modelStream = fauxModelStream([
      () => fauxAssistantMessage('The handoff is ready.'),
      (context) => {
        expect(contextText(context)).toContain('The Host rejected this handoff')
        expect(contextText(context)).toContain('Task worktree is dirty')
        expect(contextText(context)).toContain('handoff feedback 1 of 2')
        return fauxAssistantMessage('The handoff is now corrected.')
      }
    ])

    const result = await new PiKnowledgeMaintainerAgent().invoke({
      modelStream,
      systemPrompt: 'Maintain the collaboration tree.',
      worktree,
      validateHandoff: async () => {
        checks += 1
        if (checks === 1) throw new Error('Task worktree is dirty')
      },
      previousRepositoryRevision: worktree.baseRepositoryRevision,
      sourceRef: 'raw:fixture@sha256:test',
      invocationId: 'maintainer-handoff-feedback',
      signal: new AbortController().signal
    })

    expect(checks).toBe(2)
    expect(result.modelCallCount).toBe(2)
  })

  it('bounds Reviewer handoff feedback without requiring a finish tool', async () => {
    const worktree = await taskWorktree()
    let checks = 0
    const modelStream = fauxModelStream([
      () => fauxAssistantMessage('Approved.'),
      (context) => {
        expect(contextText(context)).toContain('handoff feedback 1 of 2')
        return fauxAssistantMessage('Promotion corrected once.')
      },
      (context) => {
        expect(contextText(context)).toContain('handoff feedback 2 of 2')
        return fauxAssistantMessage('Promotion corrected twice.')
      }
    ])

    await expect(new PiKnowledgeReviewerAgent().invoke({
      modelStream,
      systemPrompt: 'Review the collaboration tree.',
      worktree,
      validateHandoff: async () => {
        checks += 1
        throw new Error('main does not contain the exact Task revision')
      },
      reviewedRepositoryRevision: 'c'.repeat(40),
      invocationId: 'reviewer-handoff-feedback-limit',
      signal: new AbortController().signal
    })).rejects.toThrow('2 次 Host 反馈后仍未通过')

    expect(checks).toBe(3)
  })

  it('lets the Reviewer repair a rejected real Git promotion in the same Pi Session', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'oyster-pi-review-handoff-'))
    temporaryDirectories.push(rootPath)
    const repository = new KnowledgeTaskGitRepository(join(rootPath, 'repository'))
    const taskId = 'reviewer-repairs-promotion'
    const worktree = await repository.createWorktree({
      taskId,
      kind: 'task',
      taskDefinition: {
        formatVersion: 3,
        taskId,
        startedAt: '2026-08-13T00:00:00.000Z',
        input: { sourceConversationId: 'source-1' },
        sourceRef: 'raw:source@revision',
        configuration: {
          maintainer: { connectionId: 'connection', modelId: 'model' },
          reviewer: { connectionId: 'connection', modelId: 'model' }
        }
      },
      plan: {
        files: [{ relativePath: 'inputs/activity.md', content: '# Activity\n' }],
        items: ['Maintain the candidate.']
      }
    })
    const taskFilePath = join(worktree.taskPath, TASK_FILE_NAME)
    await writeFile(
      taskFilePath,
      (await readFile(taskFilePath, 'utf8')).replaceAll('- [ ]', '- [x]')
    )
    await writeFile(
      join(worktree.worktreePath, 'knowledge', 'reviewed.md'),
      '# Reviewed\n\nReady for promotion.\n'
    )
    await runArtifactGit(['add', '-A'], worktree.worktreePath)
    await runArtifactGit([
      'commit', '--quiet', '--no-gpg-sign', '-m', 'maintainer: prepare reviewed candidate'
    ], worktree.worktreePath)
    const reviewed = (await repository.inspectAgentCommit(
      worktree,
      worktree.baseRepositoryRevision
    )).candidateRepositoryRevision
    const targetRevisionBeforeReview = await repository.currentRevision()
    let checks = 0
    const promotionCommand = [
      'git merge --quiet --no-edit main',
      `git -C ${JSON.stringify(worktree.repositoryPath)} merge --ff-only ${JSON.stringify(worktree.branchName)}`
    ].join(' && ')
    const modelStream = fauxModelStream([
      () => fauxAssistantMessage('Approved without promotion.'),
      (context) => {
        expect(contextText(context)).toContain('Reviewer 批准后必须将精确 Task revision 快进合并到目标分支')
        return fauxAssistantMessage(
          fauxToolCall('bash', { command: promotionCommand }),
          { stopReason: 'toolUse' }
        )
      },
      () => fauxAssistantMessage('The exact Task revision is now promoted.')
    ])

    const result = await new PiKnowledgeReviewerAgent().invoke({
      modelStream,
      systemPrompt: 'Review the collaboration tree.',
      worktree,
      validateHandoff: async () => {
        checks += 1
        await repository.inspectReview(worktree, reviewed, targetRevisionBeforeReview)
      },
      reviewedRepositoryRevision: reviewed,
      invocationId: 'reviewer-real-git-handoff',
      signal: new AbortController().signal
    })

    expect(checks).toBe(2)
    expect(result.modelCallCount).toBe(3)
    expect(await repository.currentRevision()).toBe(reviewed)
  })

  it('uses the ordinary read tool to send a materialized image to the model', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'oyster-pi-image-worktree-'))
    temporaryDirectories.push(rootPath)
    const repositoryPath = join(rootPath, 'repository')
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z0Z8AAAAASUVORK5CYII=',
      'base64'
    )
    const inputPlan = planKnowledgeTaskInput({
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
    })
    const worktree = await new KnowledgeTaskGitRepository(repositoryPath).createWorktree({
      taskId: 'image-worktree',
      plan: inputPlan
    })
    const modelStream = fauxModelStream([
      () => fauxAssistantMessage(
        fauxToolCall('read', { path: 'tasks/image-worktree/inputs/attachments/ATT000001.png' }),
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
      worktree,
      validateHandoff: async () => undefined,
      previousRepositoryRevision: worktree.baseRepositoryRevision,
      sourceRef: 'raw:image@fixture',
      invocationId: 'maintainer-image-invocation',
      signal: new AbortController().signal
    })

    expect(result.toolCalls).toEqual(['read'])
  })
})

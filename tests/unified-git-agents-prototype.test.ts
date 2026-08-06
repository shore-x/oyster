import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Api,
  type Context,
  type FauxResponseStep,
  type Model
} from '@earendil-works/pi-ai'
import type { ModelRuntime } from '../src/main/ai-backends/model'
import {
  ARTIFACT_GIT_BINARY_PATH,
  createArtifactGitEnvironment
} from '../src/main/artifacts/git-runtime'
import {
  PROTOTYPE_MAINTAINER_PROMPT,
  PROTOTYPE_REVIEWER_PROMPT,
  PrototypeKnowledgeMaintainer,
  PrototypeRepositoryReviewer
} from '../prototypes/unified-git-repository/unified-git-agents'
import {
  REVIEW_MARKER_COMMENT,
  REVIEW_MARKER_END,
  REVIEW_MARKER_START,
  UnifiedGitRepositoryPrototype
} from '../prototypes/unified-git-repository/unified-git-repository'

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []

async function prototypeRepository(): Promise<{
  repositoryPath: string
  repository: UnifiedGitRepositoryPrototype
}> {
  const parentPath = await mkdtemp(join(tmpdir(), 'unified-git-agent-'))
  temporaryDirectories.push(parentPath)
  const repositoryPath = join(parentPath, 'repository')
  const repository = new UnifiedGitRepositoryPrototype(repositoryPath)
  await repository.initialize()
  return { repositoryPath, repository }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(ARTIFACT_GIT_BINARY_PATH, args, {
    cwd,
    env: createArtifactGitEnvironment()
  })
  return stdout.trim()
}

function fauxRuntime(responses: FauxResponseStep[]): ModelRuntime {
  const faux = fauxProvider()
  faux.setResponses(responses)
  const models = createModels()
  models.setProvider(faux.provider)
  return {
    model: faux.getModel() as Model<Api>,
    streamFn: (model, context, options) => models.streamSimple(model, context, options)
  }
}

function contextText(context: Context): string {
  return JSON.stringify(context.messages)
}

function lastToolResultText(context: Context): string {
  for (let index = context.messages.length - 1; index >= 0; index--) {
    const result = context.messages[index]
    if (result.role !== 'toolResult') continue
    return result.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('\n')
  }
  throw new Error('Expected a tool result')
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => (
    rm(path, { recursive: true, force: true })
  )))
})

describe('unified Git Agent collaboration prototype', () => {
  it('hands work back and forth through incremental commits and lets Reviewer merge', async () => {
    const { repositoryPath, repository } = await prototypeRepository()
    const workspace = await repository.createCollaboration()
    const maintainer = new PrototypeKnowledgeMaintainer(repository)
    const reviewer = new PrototypeRepositoryReviewer(repository)
    const evidence = 'The repository keeps Knowledge and Artifact changes in one history.'

    const firstMaintenance = await maintainer.run({
      workspace,
      previousRevision: workspace.baseRevision,
      runtime: fauxRuntime([
        (context) => {
          expect(context.tools?.map((tool) => tool.name)).toEqual([
            'read',
            'bash',
            'edit',
            'write',
            'read_evidence',
            'add_todos',
            'complete_todos',
            'list_todos'
          ])
          expect(contextText(context)).not.toContain(evidence)
          return fauxAssistantMessage(fauxToolCall('list_todos', {}), { stopReason: 'toolUse' })
        },
        fauxAssistantMessage(
          fauxToolCall('read_evidence', { line: 1, offset: 0, limit: 1_000 }),
          { stopReason: 'toolUse' }
        ),
        (context) => {
          expect(lastToolResultText(context)).toContain(evidence)
          return fauxAssistantMessage(fauxToolCall('write', {
            path: 'knowledge/repository.md',
            content: '# Repository\n\nIt keeps Knowledge and Artifact changes together.\n'
          }), { stopReason: 'toolUse' })
        },
        fauxAssistantMessage(fauxToolCall('write', {
          path: 'artifacts/revision-guide/AGENTS.md',
          content: '# Attention\n\nExplain collaboration revisions.\n'
        }), { stopReason: 'toolUse' }),
        fauxAssistantMessage(fauxToolCall('complete_todos', {
          ids: ['T000001']
        }), { stopReason: 'toolUse' }),
        fauxAssistantMessage(fauxToolCall('bash', {
          command: 'git add -A && git commit --no-gpg-sign -m "maintain: add repository model"'
        }), { stopReason: 'toolUse' }),
        fauxAssistantMessage('Committed the Maintainer handoff.')
      ]),
      evidenceLines: [evidence],
      evidenceFormatVersion: 'test-v1',
      sourceRef: 'observation:test:collaboration',
      initialTodos: ['Read the complete Evidence segment at L000001:C0.'],
      signal: new AbortController().signal
    })

    expect(firstMaintenance.handoff.changedPaths).toEqual([
      'artifacts/revision-guide/AGENTS.md',
      'knowledge/repository.md'
    ])

    const markerBlock = [
      REVIEW_MARKER_START,
      'It keeps Knowledge and Artifact changes together.',
      REVIEW_MARKER_COMMENT,
      'Replace “It” with the canonical subject so the Statement is self-explaining.',
      REVIEW_MARKER_END
    ].join('\n')
    const requested = await reviewer.run({
      workspace,
      reviewedRevision: firstMaintenance.handoff.revision,
      runtime: fauxRuntime([
        (context) => {
          expect(context.tools?.map((tool) => tool.name)).toEqual([
            'read',
            'bash',
            'edit',
            'write'
          ])
          expect(context.tools?.map((tool) => tool.name)).not.toContain('submit_review')
          expect(context.tools?.map((tool) => tool.name)).not.toContain('read_evidence')
          return fauxAssistantMessage(
            fauxToolCall('read', { path: 'knowledge/repository.md' }),
            { stopReason: 'toolUse' }
          )
        },
        fauxAssistantMessage(fauxToolCall('edit', {
          path: 'knowledge/repository.md',
          edits: [{
            oldText: 'It keeps Knowledge and Artifact changes together.',
            newText: markerBlock
          }]
        }), { stopReason: 'toolUse' }),
        fauxAssistantMessage(fauxToolCall('bash', {
          command: 'git add -A && git commit --no-gpg-sign -m "review: mark unresolved subject"'
        }), { stopReason: 'toolUse' }),
        fauxAssistantMessage('Committed inline Review feedback.')
      ]),
      signal: new AbortController().signal
    })

    expect(requested.outcome).toMatchObject({
      kind: 'changes_requested',
      reviewedRevision: firstMaintenance.handoff.revision,
      markerPaths: ['knowledge/repository.md']
    })
    if (requested.outcome.kind !== 'changes_requested') throw new Error('Expected review feedback')

    const secondMaintenance = await maintainer.run({
      workspace,
      previousRevision: requested.outcome.revision,
      runtime: fauxRuntime([
        fauxAssistantMessage(fauxToolCall('list_todos', {}), { stopReason: 'toolUse' }),
        fauxAssistantMessage(
          fauxToolCall('read', { path: 'knowledge/repository.md' }),
          { stopReason: 'toolUse' }
        ),
        (context) => {
          expect(lastToolResultText(context)).toContain(REVIEW_MARKER_START)
          expect(lastToolResultText(context)).toContain(REVIEW_MARKER_COMMENT)
          return fauxAssistantMessage(fauxToolCall('edit', {
            path: 'knowledge/repository.md',
            edits: [{
              oldText: markerBlock,
              newText: 'Repository keeps Knowledge and Artifact changes together.'
            }]
          }), { stopReason: 'toolUse' })
        },
        fauxAssistantMessage(fauxToolCall('complete_todos', {
          ids: ['T000001']
        }), { stopReason: 'toolUse' }),
        fauxAssistantMessage(fauxToolCall('bash', {
          command: 'git add -A && git commit --no-gpg-sign -m "maintain: resolve review subject"'
        }), { stopReason: 'toolUse' }),
        fauxAssistantMessage('Committed the resolved content.')
      ]),
      evidenceLines: [],
      evidenceFormatVersion: 'test-v1',
      sourceRef: 'review-follow-up:test',
      initialTodos: ['Resolve every REVIEW marker in the current branch.'],
      signal: new AbortController().signal
    })

    const mergeCommand = [
      `git -C ${JSON.stringify(repositoryPath)}`,
      'merge --no-ff --no-gpg-sign',
      '-m "review: approve collaboration"',
      JSON.stringify(workspace.branchName)
    ].join(' ')
    const accepted = await reviewer.run({
      workspace,
      reviewedRevision: secondMaintenance.handoff.revision,
      runtime: fauxRuntime([
        (context) => {
          expect(contextText(context)).toContain(secondMaintenance.handoff.revision)
          expect(contextText(context)).not.toContain('submit_review')
          return fauxAssistantMessage(fauxToolCall('bash', {
            command: `rg -n '${REVIEW_MARKER_START}' knowledge artifacts || true`
          }), { stopReason: 'toolUse' })
        },
        fauxAssistantMessage(
          fauxToolCall('bash', { command: mergeCommand }),
          { stopReason: 'toolUse' }
        ),
        fauxAssistantMessage('Merged the exact reviewed revision.')
      ]),
      signal: new AbortController().signal
    })

    expect(accepted.outcome).toMatchObject({
      kind: 'accepted',
      reviewedRevision: secondMaintenance.handoff.revision,
      targetBranch: 'main'
    })
    expect(await git(repositoryPath, ['merge-base', '--is-ancestor', requested.outcome.revision, 'main']))
      .toBe('')
    expect(await readFile(join(repositoryPath, 'knowledge/repository.md'), 'utf8'))
      .toContain('Repository keeps Knowledge and Artifact changes together.')
    expect(await readFile(join(repositoryPath, 'knowledge/repository.md'), 'utf8'))
      .not.toContain(REVIEW_MARKER_START)
  })

  it('uses only generic REVIEW marker names', () => {
    expect(PROTOTYPE_MAINTAINER_PROMPT).toContain(REVIEW_MARKER_START)
    expect(PROTOTYPE_REVIEWER_PROMPT).toContain(REVIEW_MARKER_COMMENT)
    expect(PROTOTYPE_REVIEWER_PROMPT).toContain(REVIEW_MARKER_END)
    expect(PROTOTYPE_MAINTAINER_PROMPT).not.toContain('OYSTER REVIEW')
    expect(PROTOTYPE_REVIEWER_PROMPT).not.toContain('OYSTER REVIEW')
  })

  it('rejects a Reviewer that neither commits feedback nor merges', async () => {
    const { repository } = await prototypeRepository()
    const workspace = await repository.createCollaboration()
    await repository.writeKnowledgeStatement(workspace, 'subject.md', {
      title: 'Subject',
      content: 'A complete subject.'
    })
    await git(workspace.worktreePath, ['add', '-A'])
    await git(workspace.worktreePath, [
      'commit',
      '--quiet',
      '--no-gpg-sign',
      '-m',
      'maintain: add subject'
    ])
    const maintained = await repository.recordMaintainerHandoff(workspace, workspace.baseRevision)

    await expect(new PrototypeRepositoryReviewer(repository).run({
      workspace,
      reviewedRevision: maintained.revision,
      runtime: fauxRuntime([fauxAssistantMessage('Finished without a Git handoff.')]),
      signal: new AbortController().signal
    })).rejects.toThrow('既没有提交问题标记，也没有合并协作分支')
  })
})

import { renderToString } from 'solid-js/web'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactSnapshot } from '../src/shared/artifacts'

const controller = vi.hoisted(() => ({
  snapshot: vi.fn(),
  busy: vi.fn(),
  error: vi.fn(),
  refresh: vi.fn(),
  createArtifact: vi.fn(),
  openRepository: vi.fn(),
  openArtifact: vi.fn()
}))

vi.mock('../src/renderer/src/artifacts-controller', () => ({
  createArtifactsController: () => controller
}))

import { ArtifactsPage } from '../src/renderer/src/components/ArtifactsPage'

beforeEach(() => {
  vi.clearAllMocks()
  controller.snapshot.mockReturnValue(undefined)
  controller.busy.mockReturnValue(undefined)
  controller.error.mockReturnValue(undefined)
})

describe('ArtifactsPage', () => {
  it('does not present a failed initial load as an empty Repository', () => {
    controller.error.mockReturnValue('无法读取 Artifact Repository')

    const html = renderToString(() => ArtifactsPage())

    expect(html).toContain('无法读取 Artifact')
    expect(html).not.toContain('还没有 Artifact')
    expect(html).toMatch(/data-testid="create-artifact"[^>]*disabled/)
  })

  it('labels the AGENTS.md modification time and renders its Markdown', () => {
    const snapshot: ArtifactSnapshot = {
      repositoryPath: '/app-data/artifacts',
      artifacts: [{
        directoryName: 'agent-memory-tracking',
        attention: '# Attention\n\nTrack agent memory research.',
        modifiedAt: '2026-07-30T09:00:00.000Z'
      }],
      invalidDirectories: []
    }
    controller.snapshot.mockReturnValue(snapshot)

    const html = renderToString(() => ArtifactsPage())

    expect(html).toContain('agent-memory-tracking')
    expect(html).toContain('AGENTS.md 更新于')
    expect(html).toContain('<h1>Attention</h1>')
    expect(html).toContain('Track agent memory research.')
  })
})

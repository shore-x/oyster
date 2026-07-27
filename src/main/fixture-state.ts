import type { DiscoveryStateData } from './discovery/model'

export const FIXTURE_SESSION_CONTENT = [
  '{"type":"user","message":"我希望知识加工链路保持简洁，并且每条知识都能回溯到原始证据。"}',
  '{"type":"assistant","message":"可以使用可丢弃的 Evidence Map，再由 Agent 按需展开原始观察。"}',
  '{"type":"user","message":"测试写入必须与正式知识库隔离，且可以随时重复运行。"}'
].join('\n')

export const FIXTURE_SESSION_ARTIFACT_ID = 'fixture-session-001'

export function createFixtureState(): DiscoveryStateData {
  return {
    sources: [
      {
        id: 'source:claude',
        agentType: 'claude',
        displayName: 'Claude Code',
        rootPath: '/Users/demo/.claude/projects',
        executablePath: '/usr/local/bin/claude',
        discoveryState: 'found',
        scanState: 'ready',
        fileCount: 42,
        sessionCount: 36,
        instructionFileCount: 4,
        totalBytes: 8_808_038,
        invalidFileCount: 2,
        oldestSessionAt: '2026-05-02T08:20:00.000Z',
        latestSessionAt: '2026-07-21T13:42:00.000Z',
        lastDetectedAt: '2026-07-22T04:00:00.000Z',
        lastScannedAt: '2026-07-22T04:01:00.000Z'
      },
      {
        id: 'source:pi',
        agentType: 'pi',
        displayName: 'Pi',
        rootPath: '/Users/demo/.pi/agent/sessions',
        discoveryState: 'found',
        scanState: 'scanning',
        fileCount: 22,
        sessionCount: 20,
        instructionFileCount: 2,
        totalBytes: 4_194_304,
        invalidFileCount: 0,
        oldestSessionAt: '2026-06-11T09:00:00.000Z',
        latestSessionAt: '2026-07-22T02:18:00.000Z',
        lastDetectedAt: '2026-07-22T04:00:00.000Z',
        lastScannedAt: '2026-07-22T04:01:00.000Z'
      },
      {
        id: 'source:codex',
        agentType: 'codex',
        displayName: 'Codex',
        rootPath: '/Users/demo/.codex',
        executablePath: '/opt/homebrew/bin/codex',
        discoveryState: 'needs_permission',
        scanState: 'idle',
        fileCount: 0,
        sessionCount: 0,
        instructionFileCount: 0,
        totalBytes: 0,
        invalidFileCount: 0,
        lastDetectedAt: '2026-07-22T04:00:00.000Z',
        errorMessage: '无法读取历史记录目录'
      }
    ],
    artifacts: [{
      id: FIXTURE_SESSION_ARTIFACT_ID,
      sourceId: 'source:claude',
      kind: 'conversation',
      externalId: 'fixture-session-2026-07-21',
      relativePath: 'fixture/session.jsonl',
      title: '知识加工 Sandbox 设计讨论',
      projectPath: '/Users/demo/projects/oyster',
      startedAt: '2026-07-21T13:10:00.000Z',
      endedAt: '2026-07-21T13:42:00.000Z',
      updatedAt: '2026-07-21T13:42:00.000Z',
      messageCount: 3,
      sizeBytes: Buffer.byteLength(FIXTURE_SESSION_CONTENT),
      modifiedAt: '2026-07-21T13:42:00.000Z',
      fingerprint: 'a'.repeat(64)
    }],
    runs: [
      {
        id: 'fixture-running-scan',
        sourceId: 'source:pi',
        state: 'running',
        totalFiles: 14,
        processedFiles: 5,
        totalBytes: 2_873_098,
        processedBytes: 1_809_051,
        invalidFiles: 0,
        startedAt: '2026-07-22T04:02:00.000Z'
      }
    ]
  }
}

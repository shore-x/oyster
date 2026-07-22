import type { DiscoveryStateData } from './discovery/model'

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
        syncedBytes: 7_438_254,
        syncedSessionCount: 31,
        syncedInstructionFileCount: 4,
        oldestSessionAt: '2026-05-02T08:20:00.000Z',
        latestSessionAt: '2026-07-21T13:42:00.000Z',
        lastDetectedAt: '2026-07-22T04:00:00.000Z',
        lastScannedAt: '2026-07-22T04:01:00.000Z',
        lastSyncedAt: '2026-07-22T04:02:00.000Z'
      },
      {
        id: 'source:pi',
        agentType: 'pi',
        displayName: 'Pi',
        rootPath: '/Users/demo/.pi/agent/sessions',
        discoveryState: 'found',
        scanState: 'ready',
        fileCount: 22,
        sessionCount: 20,
        instructionFileCount: 2,
        totalBytes: 4_194_304,
        invalidFileCount: 0,
        syncedBytes: 1_321_206,
        syncedSessionCount: 7,
        syncedInstructionFileCount: 1,
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
        syncedBytes: 0,
        syncedSessionCount: 0,
        syncedInstructionFileCount: 0,
        lastDetectedAt: '2026-07-22T04:00:00.000Z',
        errorMessage: '无法读取历史记录目录'
      }
    ],
    artifacts: [],
    runs: [
      {
        id: 'fixture-running-import',
        sourceId: 'source:pi',
        kind: 'import',
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

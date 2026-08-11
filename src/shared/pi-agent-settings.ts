export const PI_AGENT_TRANSPORTS = [
  'auto',
  'sse',
  'websocket',
  'websocket-cached'
] as const

export type PiAgentTransport = typeof PI_AGENT_TRANSPORTS[number]

export const DEFAULT_PI_AGENT_SETTINGS = {
  autoCompactionEnabled: true,
  transport: 'auto' as const,
  httpIdleTimeoutMs: 300_000
}

export interface PiAgentSettingsView {
  settingsPath: string
  autoCompactionEnabled: boolean
  compactionReserveTokens: number
  compactionKeepRecentTokens: number
  transport: PiAgentTransport
  httpIdleTimeoutMs: number
  error?: string
}

export interface SavePiAgentSettingsInput {
  autoCompactionEnabled: boolean
  transport: PiAgentTransport
  httpIdleTimeoutMs: number
}

export interface PiAgentSettingsApi {
  getSettings(): Promise<PiAgentSettingsView>
  saveSettings(input: SavePiAgentSettingsInput): Promise<PiAgentSettingsView>
}

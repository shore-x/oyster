import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import type { AiConnection } from '../../shared/ai-backends'
import type { CodexAccountDiscovery as CodexAccountDiscoveryPort } from './model'
import {
  CodexAppServerClient,
  type CodexAccountClient,
  type CodexAccountReadResult
} from './codex-app-server-client'

export const CODEX_CONNECTION_ID = 'runtime:codex'

type AccountClientFactory = (executablePath: string) => CodexAccountClient

async function executable(candidates: string[]): Promise<string | undefined> {
  for (const candidate of [...new Set(candidates)]) {
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // Keep checking the bounded list of official runtime locations.
    }
  }
  return undefined
}

function codexConnection(
  status: AiConnection['status'],
  fields: Partial<AiConnection> = {}
): AiConnection {
  return {
    id: CODEX_CONNECTION_ID,
    adapterId: 'codex',
    backendKind: 'coding_plan',
    providerId: 'openai_codex',
    displayName: 'OpenAI Codex',
    credentialMode: 'provider_runtime',
    status,
    models: [],
    ...fields
  }
}

/** Read-only discovery of an installed Codex Runtime and its current account. */
export class CodexAccountDiscovery implements CodexAccountDiscoveryPort {
  private client?: CodexAccountClient

  constructor(
    private readonly homeDirectory: string,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly createClient: AccountClientFactory = (path) => new CodexAppServerClient(path)
  ) {}

  private async findExecutable(): Promise<string | undefined> {
    const pathEntries = (this.environment.PATH || '')
      .split(delimiter)
      .filter((entry) => entry && isAbsolute(entry))
    return executable([
      ...pathEntries.map((entry) => join(entry, 'codex')),
      join(this.homeDirectory, '.local', 'bin', 'codex'),
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex'
    ])
  }

  private disposeClient(): void {
    this.client?.dispose()
    this.client = undefined
  }

  private fromAccount(
    executablePath: string,
    result: CodexAccountReadResult
  ): AiConnection {
    const common = { executablePath, lastCheckedAt: new Date().toISOString() }
    if (result.account?.type === 'chatgpt') {
      return codexConnection('ready', {
        ...common,
        accountLabel: result.account.email ?? undefined,
        planType: result.account.planType
      })
    }
    if (!result.account) {
      return codexConnection(result.requiresOpenaiAuth ? 'needs_auth' : 'unsupported', {
        ...common,
        errorMessage: result.requiresOpenaiAuth ? undefined : '当前 Codex Runtime 不是 OpenAI 托管认证'
      })
    }
    return codexConnection('unsupported', {
      ...common,
      errorMessage: '当前 Codex 使用 API Key，不会消耗 Coding Plan 额度'
    })
  }

  async inspect(): Promise<AiConnection> {
    const executablePath = await this.findExecutable()
    if (!executablePath) {
      this.disposeClient()
      return codexConnection('not_found', { lastCheckedAt: new Date().toISOString() })
    }
    try {
      this.disposeClient()
      this.client = this.createClient(executablePath)
      const account = await this.client.readAccount()
      return this.fromAccount(executablePath, account)
    } catch (error) {
      this.disposeClient()
      return codexConnection('unavailable', {
        executablePath,
        errorMessage: error instanceof Error ? error.message : String(error),
        lastCheckedAt: new Date().toISOString()
      })
    }
  }

  dispose(): void {
    this.disposeClient()
  }
}

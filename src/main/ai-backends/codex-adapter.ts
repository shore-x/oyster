import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { AiConnection } from '../../shared/ai-backends'
import type { AgentBackendAdapter, AgentTaskRequest, AgentTaskResult } from './model'
import {
  CodexAppServerClient,
  type CodexAccountClient,
  type CodexAccountReadResult
} from './codex-app-server-client'
import { codexProcessEnvironment } from './codex-process-environment'

const CODEX_CONNECTION_ID = 'runtime:codex'
const TASK_TIMEOUT_MS = 120_000
const AUTHENTICATION_TIMEOUT_MS = 5 * 60_000
const PROBE_CONFIG = [
  'approval_policy="never"',
  'forced_login_method="chatgpt"',
  'project_doc_max_bytes=0',
  'features.shell_tool=false',
  'web_search="disabled"',
  'agents.enabled=false',
  'apps._default.enabled=false',
  'tools.view_image=false',
  'features.remote_plugin=false'
] as const

export interface CodexTaskRunner {
  run(executablePath: string, request: AgentTaskRequest): Promise<AgentTaskResult>
  dispose?(): void
}

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

function consumeJsonLines(
  chunk: string,
  buffer: { value: string },
  consume: (value: Record<string, unknown>) => void
): void {
  buffer.value += chunk
  const lines = buffer.value.split(/\r?\n/)
  buffer.value = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    const value = JSON.parse(line)
    if (value && typeof value === 'object') consume(value as Record<string, unknown>)
  }
}

function stopProcess(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.killed) return
  child.kill('SIGTERM')
  const forceTimer = setTimeout(() => child.kill('SIGKILL'), 2_000)
  forceTimer.unref()
}

export class CodexExecTaskRunner implements CodexTaskRunner {
  private readonly processes = new Set<ChildProcessWithoutNullStreams>()

  constructor(private readonly spawnProcess: typeof spawn = spawn) {}

  async run(executablePath: string, request: AgentTaskRequest): Promise<AgentTaskResult> {
    request.signal?.throwIfAborted()
    const args = [
      'exec',
      '--json',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--sandbox',
      'read-only',
      ...PROBE_CONFIG.flatMap((value) => ['--config', value]),
      '--cd',
      request.workspacePath,
      '--skip-git-repo-check',
      '-'
    ]
    request.signal?.throwIfAborted()
    const child = this.spawnProcess(executablePath, args, {
      shell: false,
      env: codexProcessEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.processes.add(child)
    child.stdout.setEncoding('utf8')
    child.stderr.resume()

    return new Promise((resolve, reject) => {
      const buffer = { value: '' }
      let lastMessage: string | undefined
      let completed = false
      let protocolError: Error | undefined
      const timer = setTimeout(() => {
        stopProcess(child)
        reject(new Error('Codex 测试任务超时'))
      }, TASK_TIMEOUT_MS)
      const abort = (): void => {
        stopProcess(child)
        reject(new Error('Codex 测试已取消'))
      }
      request.signal?.addEventListener('abort', abort, { once: true })

      child.stdout.on('data', (chunk: string) => {
        try {
          consumeJsonLines(chunk, buffer, (event) => {
            if (event.type === 'turn.completed') completed = true
            if (event.type === 'turn.failed' || event.type === 'error') {
              protocolError = new Error('Codex 任务执行失败')
            }
            if (event.type !== 'item.completed' || !event.item || typeof event.item !== 'object') return
            const item = event.item as Record<string, unknown>
            if (item.type === 'agent_message' && typeof item.text === 'string') lastMessage = item.text
          })
        } catch {
          protocolError = new Error('Codex 任务返回了无效协议消息')
        }
      })

      child.once('error', (error) => {
        this.processes.delete(child)
        clearTimeout(timer)
        request.signal?.removeEventListener('abort', abort)
        reject(new Error(`无法启动 Codex 任务：${error.message}`))
      })
      child.once('exit', (code) => {
        this.processes.delete(child)
        clearTimeout(timer)
        request.signal?.removeEventListener('abort', abort)
        if (protocolError) return reject(protocolError)
        if (code !== 0 || !completed || !lastMessage) return reject(new Error('Codex 任务未正常完成'))
        resolve({ text: lastMessage })
      })

      child.stdin.end(request.prompt)
    })
  }

  dispose(): void {
    for (const child of this.processes) stopProcess(child)
    this.processes.clear()
  }
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

export class CodexAgentAdapter implements AgentBackendAdapter {
  readonly id = 'codex' as const
  private executablePath?: string
  private client?: CodexAccountClient
  private unsubscribeClient?: () => void
  private authentication?: {
    loginId?: string
    timer: ReturnType<typeof setTimeout>
  }
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly homeDirectory: string,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly createClient: AccountClientFactory = (path) => new CodexAppServerClient(path),
    private readonly taskRunner: CodexTaskRunner = new CodexExecTaskRunner()
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

  private accountClient(path: string): CodexAccountClient {
    if (this.client) return this.client
    const client = this.createClient(path)
    this.client = client
    this.unsubscribeClient = client.subscribe((method, params) => {
      if (method !== 'account/login/completed') return
      if (
        this.authentication?.loginId
        && typeof params.loginId === 'string'
        && params.loginId !== this.authentication.loginId
      ) return
      this.clearAuthentication()
      if (params.success !== true) this.disposeClient()
      this.emit()
    })
    return client
  }

  private disposeClient(): void {
    this.clearAuthentication()
    this.unsubscribeClient?.()
    this.unsubscribeClient = undefined
    this.client?.dispose()
    this.client = undefined
  }

  private clearAuthentication(): void {
    if (this.authentication) clearTimeout(this.authentication.timer)
    this.authentication = undefined
  }

  private beginAuthentication(loginId?: string): void {
    this.clearAuthentication()
    const timer = setTimeout(() => {
      this.authentication = undefined
      this.disposeClient()
      this.emit()
    }, AUTHENTICATION_TIMEOUT_MS)
    timer.unref()
    this.authentication = { loginId, timer }
  }

  private fromAccount(result: CodexAccountReadResult): AiConnection {
    const checked = new Date().toISOString()
    const common = { executablePath: this.executablePath, lastCheckedAt: checked }
    if (result.account?.type === 'chatgpt') {
      this.clearAuthentication()
      return codexConnection('ready', {
        ...common,
        accountLabel: result.account.email ?? undefined,
        planType: result.account.planType
      })
    }
    if (this.authentication) return codexConnection('authenticating', common)
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
    this.executablePath = await this.findExecutable()
    if (!this.executablePath) {
      this.disposeClient()
      return codexConnection('not_found', { lastCheckedAt: new Date().toISOString() })
    }
    try {
      const account = await this.accountClient(this.executablePath).readAccount()
      return this.fromAccount(account)
    } catch (error) {
      this.disposeClient()
      return codexConnection('unavailable', {
        executablePath: this.executablePath,
        errorMessage: error instanceof Error ? error.message : String(error),
        lastCheckedAt: new Date().toISOString()
      })
    }
  }

  async connect(): Promise<{ url: string } | undefined> {
    if (this.authentication) this.disposeClient()
    this.executablePath = await this.findExecutable()
    if (!this.executablePath) throw new Error('未找到 Codex Runtime')
    const result = await this.accountClient(this.executablePath).startChatGptLogin()
    if (result.type !== 'chatgpt' || !result.authUrl) throw new Error('Codex Runtime 未返回登录地址')
    const url = new URL(result.authUrl)
    if (url.protocol !== 'https:') throw new Error('Codex Runtime 返回了不安全的登录地址')
    this.beginAuthentication(result.loginId)
    this.emit()
    return { url: url.toString() }
  }

  cancelConnect(): void {
    this.disposeClient()
    this.emit()
  }

  async runTask(request: AgentTaskRequest): Promise<AgentTaskResult> {
    request.signal?.throwIfAborted()
    const connection = await this.inspect()
    if (connection.status !== 'ready' || !this.executablePath) {
      throw new Error('Codex Coding Plan 尚未就绪')
    }
    request.signal?.throwIfAborted()
    return this.taskRunner.run(this.executablePath, request)
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }

  dispose(): void {
    this.disposeClient()
    this.taskRunner.dispose?.()
    this.listeners.clear()
  }
}

export { CODEX_CONNECTION_ID }

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { codexProcessEnvironment } from './codex-process-environment'

type JsonRecord = Record<string, unknown>

export interface CodexAccount {
  type: 'chatgpt' | 'apiKey' | 'amazonBedrock' | string
  email?: string | null
  planType?: string
}

export interface CodexAccountReadResult {
  account: CodexAccount | null
  requiresOpenaiAuth: boolean
}

export interface CodexLoginStartResult {
  type: string
  loginId?: string
  authUrl?: string
}

export interface CodexAccountClient {
  readAccount(): Promise<CodexAccountReadResult>
  startChatGptLogin(): Promise<CodexLoginStartResult>
  subscribe(listener: (method: string, params: JsonRecord) => void): () => void
  dispose(): void
}

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' ? value as JsonRecord : undefined
}

function errorMessage(value: unknown): string {
  const record = asRecord(value)
  return typeof record?.message === 'string' ? record.message : 'Codex App Server 请求失败'
}

export class CodexAppServerClient implements CodexAccountClient {
  private process?: ChildProcessWithoutNullStreams
  private startPromise?: Promise<void>
  private nextId = 1
  private stdoutBuffer = ''
  private readonly pending = new Map<number, PendingRequest>()
  private readonly listeners = new Set<(method: string, params: JsonRecord) => void>()

  constructor(
    private readonly executablePath: string,
    private readonly requestTimeoutMs = 10_000
  ) {}

  private async ensureStarted(): Promise<void> {
    if (!this.startPromise) this.startPromise = this.start()
    return this.startPromise
  }

  private async start(): Promise<void> {
    const child = spawn(this.executablePath, ['app-server', '--listen', 'stdio://'], {
      shell: false,
      env: codexProcessEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.process = child
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.handleStdout(chunk))
    child.stderr.resume()
    child.once('error', (error) => this.failAll(new Error(`无法启动 Codex Runtime：${error.message}`)))
    child.once('exit', () => {
      this.process = undefined
      this.startPromise = undefined
      this.failAll(new Error('Codex Runtime 已退出'))
    })

    await this.requestRaw('initialize', {
      clientInfo: { name: 'oyster', title: 'Oyster', version: '0.1.0' },
      capabilities: { experimentalApi: false, requestAttestation: false }
    })
    this.notify('initialized')
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk
    const lines = this.stdoutBuffer.split(/\r?\n/)
    this.stdoutBuffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      let message: JsonRecord
      try {
        message = JSON.parse(line) as JsonRecord
      } catch {
        this.failAll(new Error('Codex Runtime 返回了无效协议消息'))
        continue
      }

      if (typeof message.id === 'number') {
        const request = this.pending.get(message.id)
        if (!request) continue
        clearTimeout(request.timer)
        this.pending.delete(message.id)
        if (message.error !== undefined) request.reject(new Error(errorMessage(message.error)))
        else request.resolve(message.result)
        continue
      }

      if (typeof message.method === 'string') {
        const params = asRecord(message.params) ?? {}
        for (const listener of this.listeners) listener(message.method, params)
      }
    }
  }

  private requestRaw(method: string, params: unknown): Promise<unknown> {
    const child = this.process
    if (!child || !child.stdin.writable) return Promise.reject(new Error('Codex Runtime 未运行'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex Runtime 请求超时：${method}`))
      }, this.requestTimeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      child.stdin.write(`${JSON.stringify({ method, id, params })}\n`)
    })
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    await this.ensureStarted()
    return this.requestRaw(method, params)
  }

  private notify(method: string): void {
    const child = this.process
    if (!child || !child.stdin.writable) throw new Error('Codex Runtime 未运行')
    child.stdin.write(`${JSON.stringify({ method })}\n`)
  }

  private failAll(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
  }

  async readAccount(): Promise<CodexAccountReadResult> {
    return await this.request('account/read', { refreshToken: false }) as CodexAccountReadResult
  }

  async startChatGptLogin(): Promise<CodexLoginStartResult> {
    return await this.request('account/login/start', { type: 'chatgpt' }) as CodexLoginStartResult
  }

  subscribe(listener: (method: string, params: JsonRecord) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.failAll(new Error('Codex Runtime 已关闭'))
    this.process?.kill()
    this.process = undefined
    this.startPromise = undefined
  }
}

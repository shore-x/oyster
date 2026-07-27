import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CodexAgentAdapter,
  CodexExecTaskRunner,
  type CodexTaskRunner
} from '../src/main/ai-backends/codex-adapter'
import { CodexAppServerClient, type CodexAccountClient } from '../src/main/ai-backends/codex-app-server-client'
import { codexProcessEnvironment } from '../src/main/ai-backends/codex-process-environment'
import type { AgentTaskRequest } from '../src/main/ai-backends/model'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

class FakeAccountClient implements CodexAccountClient {
  loginStarted = false
  constructor(private account: Awaited<ReturnType<CodexAccountClient['readAccount']>>) {}
  async readAccount() { return this.account }
  setAccount(account: Awaited<ReturnType<CodexAccountClient['readAccount']>>): void {
    this.account = account
  }
  async startChatGptLogin() {
    this.loginStarted = true
    return { type: 'chatgpt', loginId: 'login', authUrl: 'https://chatgpt.com/auth' }
  }
  subscribe(_listener: (method: string, params: Record<string, unknown>) => void): () => void { return () => undefined }
  dispose(): void {}
}

class FakeTaskRunner implements CodexTaskRunner {
  request?: AgentTaskRequest
  async run(_path: string, request: AgentTaskRequest) {
    this.request = request
    return { text: 'OYSTER' }
  }
}

async function executableHome(): Promise<{ home: string; executable: string }> {
  const home = await mkdtemp(join(tmpdir(), 'oyster-codex-adapter-'))
  temporaryDirectories.push(home)
  const executable = join(home, '.local', 'bin', 'codex')
  await mkdir(join(home, '.local', 'bin'), { recursive: true })
  await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  return { home, executable }
}

describe('CodexAgentAdapter', () => {
  it('recognizes ChatGPT plan auth without reading credentials', async () => {
    const { home, executable } = await executableHome()
    const client = new FakeAccountClient({
      account: { type: 'chatgpt', email: 'user@example.com', planType: 'plus' },
      requiresOpenaiAuth: true
    })
    const adapter = new CodexAgentAdapter(home, { PATH: '' }, () => client, new FakeTaskRunner())
    await expect(adapter.inspect()).resolves.toMatchObject({
      backendKind: 'coding_plan',
      providerId: 'openai_codex',
      status: 'ready',
      models: [],
      executablePath: executable,
      accountLabel: 'user@example.com',
      planType: 'plus'
    })
  })

  it('does not mislabel API-key auth as coding-plan usage', async () => {
    const { home } = await executableHome()
    const client = new FakeAccountClient({ account: { type: 'apiKey' }, requiresOpenaiAuth: true })
    const adapter = new CodexAgentAdapter(home, { PATH: '' }, () => client, new FakeTaskRunner())
    await expect(adapter.inspect()).resolves.toMatchObject({ status: 'unsupported' })
  })

  it('starts official browser login only when connect is called', async () => {
    const { home } = await executableHome()
    const client = new FakeAccountClient({ account: null, requiresOpenaiAuth: true })
    const adapter = new CodexAgentAdapter(home, { PATH: '' }, () => client, new FakeTaskRunner())
    await adapter.inspect()
    expect(client.loginStarted).toBe(false)
    await expect(adapter.connect()).resolves.toEqual({ url: 'https://chatgpt.com/auth' })
    expect(client.loginStarted).toBe(true)
  })

  it('recognizes a completed account even when the login notification was missed', async () => {
    const { home } = await executableHome()
    const client = new FakeAccountClient({ account: null, requiresOpenaiAuth: true })
    const adapter = new CodexAgentAdapter(home, { PATH: '' }, () => client, new FakeTaskRunner())
    await adapter.connect()
    client.setAccount({
      account: { type: 'chatgpt', email: 'user@example.com', planType: 'plus' },
      requiresOpenaiAuth: true
    })
    await expect(adapter.inspect()).resolves.toMatchObject({ status: 'ready', planType: 'plus' })
  })

  it('can clear a pending login so the user is not left in an authenticating state', async () => {
    const { home } = await executableHome()
    const client = new FakeAccountClient({ account: null, requiresOpenaiAuth: true })
    const adapter = new CodexAgentAdapter(home, { PATH: '' }, () => client, new FakeTaskRunner())
    await adapter.connect()
    await expect(adapter.inspect()).resolves.toMatchObject({ status: 'authenticating' })
    adapter.cancelConnect()
    await expect(adapter.inspect()).resolves.toMatchObject({ status: 'needs_auth' })
  })

  it('runs tasks through the separate agent contract', async () => {
    const { home } = await executableHome()
    const client = new FakeAccountClient({ account: { type: 'chatgpt', planType: 'pro' }, requiresOpenaiAuth: true })
    const runner = new FakeTaskRunner()
    const adapter = new CodexAgentAdapter(home, { PATH: '' }, () => client, runner)
    await expect(adapter.runTask({ prompt: 'task', workspacePath: '/tmp/workspace' })).resolves.toEqual({ text: 'OYSTER' })
    expect(runner.request).toMatchObject({ prompt: 'task', workspacePath: '/tmp/workspace' })
  })
})

describe('Codex CLI protocol', () => {
  it('does not forward unrelated provider credentials to the runtime', () => {
    expect(codexProcessEnvironment({
      HOME: '/Users/demo',
      PATH: '/usr/bin',
      CODEX_HOME: '/Users/demo/.codex',
      OPENAI_API_KEY: 'must-not-leak',
      GITHUB_TOKEN: 'must-not-leak'
    })).toEqual({
      HOME: '/Users/demo',
      PATH: '/usr/bin',
      CODEX_HOME: '/Users/demo/.codex'
    })
  })

  it('does not spawn Codex when cancellation already happened', async () => {
    const controller = new AbortController()
    controller.abort()
    let spawned = false
    const runner = new CodexExecTaskRunner((() => {
      spawned = true
      throw new Error('spawn must not run')
    }) as typeof import('node:child_process').spawn)

    await expect(runner.run('/usr/bin/codex', {
      prompt: 'private prompt',
      workspacePath: '/tmp/oyster-test-workspace',
      signal: controller.signal
    })).rejects.toThrow()
    expect(spawned).toBe(false)
  })

  it('speaks App Server JSONL and keeps task prompts on stdin', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oyster-fake-codex-'))
    temporaryDirectories.push(directory)
    const executable = join(directory, 'codex')
    await writeFile(executable, `#!/usr/bin/env node
const args = process.argv.slice(2)
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { input += chunk })
if (args[0] === 'app-server') {
  let buffer = ''
  process.stdin.on('data', chunk => {
    buffer += chunk
    const lines = buffer.split(/\\r?\\n/)
    buffer = lines.pop() || ''
    for (const line of lines) {
      const message = JSON.parse(line)
      if (message.method === 'initialize') process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: 'fake' } }) + '\\n')
      if (message.method === 'account/read') process.stdout.write(JSON.stringify({ id: message.id, result: { account: { type: 'chatgpt', planType: 'plus' }, requiresOpenaiAuth: true } }) + '\\n')
    }
  })
} else if (args[0] === 'exec') {
  process.stdin.on('end', () => {
    if (args.includes(input)) process.exit(4)
    const requiredConfig = [
      'forced_login_method="chatgpt"',
      'project_doc_max_bytes=0',
      'features.shell_tool=false',
      'web_search="disabled"',
      'agents.enabled=false',
      'apps._default.enabled=false',
      'tools.view_image=false',
      'features.remote_plugin=false'
    ]
    if (requiredConfig.some(value => !args.includes(value))) process.exit(5)
    process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'OYSTER' } }) + '\\n')
    process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n')
  })
}
`, 'utf8')
    await chmod(executable, 0o700)

    const client = new CodexAppServerClient(executable, 2_000)
    await expect(client.readAccount()).resolves.toMatchObject({ account: { type: 'chatgpt', planType: 'plus' } })
    client.dispose()

    await expect(new CodexExecTaskRunner().run(executable, {
      prompt: 'private prompt',
      workspacePath: directory
    })).resolves.toEqual({ text: 'OYSTER' })
  })
})

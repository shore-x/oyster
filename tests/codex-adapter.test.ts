import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexAccountDiscovery } from '../src/main/ai-backends/codex-adapter'
import {
  CodexAppServerClient,
  type CodexAccountClient
} from '../src/main/ai-backends/codex-app-server-client'
import { codexProcessEnvironment } from '../src/main/ai-backends/codex-process-environment'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )))
})

class FakeAccountClient implements CodexAccountClient {
  constructor(private readonly account: Awaited<ReturnType<CodexAccountClient['readAccount']>>) {}
  async readAccount() { return this.account }
  dispose(): void {}
}

async function executableHome(): Promise<{ home: string; executable: string }> {
  const home = await mkdtemp(join(tmpdir(), 'oyster-codex-adapter-'))
  temporaryDirectories.push(home)
  const executable = join(home, '.local', 'bin', 'codex')
  await mkdir(join(home, '.local', 'bin'), { recursive: true })
  await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  return { home, executable }
}

describe('CodexAccountDiscovery', () => {
  it('recognizes ChatGPT plan auth without reading credentials', async () => {
    const { home, executable } = await executableHome()
    const client = new FakeAccountClient({
      account: { type: 'chatgpt', email: 'user@example.com', planType: 'plus' },
      requiresOpenaiAuth: true
    })
    const discovery = new CodexAccountDiscovery(home, { PATH: '' }, () => client)
    await expect(discovery.inspect()).resolves.toMatchObject({
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
    const discovery = new CodexAccountDiscovery(home, { PATH: '' }, () => client)
    await expect(discovery.inspect()).resolves.toMatchObject({ status: 'unsupported' })
  })

  it('reports an installed account that still requires authentication', async () => {
    const { home } = await executableHome()
    const client = new FakeAccountClient({ account: null, requiresOpenaiAuth: true })
    const discovery = new CodexAccountDiscovery(home, { PATH: '' }, () => client)
    await expect(discovery.inspect()).resolves.toMatchObject({ status: 'needs_auth' })
  })
})

describe('Codex account protocol', () => {
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

  it('speaks only the App Server account/read protocol', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oyster-fake-codex-'))
    temporaryDirectories.push(directory)
    const executable = join(directory, 'codex')
    await writeFile(executable, `#!/usr/bin/env node
if (process.argv[2] !== 'app-server') process.exit(5)
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  const lines = buffer.split(/\\r?\\n/)
  buffer = lines.pop() || ''
  for (const line of lines) {
    const message = JSON.parse(line)
    if (message.method === 'initialize') process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: 'fake' } }) + '\\n')
    if (message.method === 'account/read') process.stdout.write(JSON.stringify({ id: message.id, result: { account: { type: 'chatgpt', planType: 'plus' }, requiresOpenaiAuth: true } }) + '\\n')
    if (message.method === 'account/login/start') process.exit(6)
  }
})
`, 'utf8')
    await chmod(executable, 0o700)

    const client = new CodexAppServerClient(executable, 2_000)
    await expect(client.readAccount()).resolves.toMatchObject({
      account: { type: 'chatgpt', planType: 'plus' }
    })
    client.dispose()
  })
})

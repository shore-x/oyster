import { describe, expect, it } from 'vitest'
import type { Credential } from '@earendil-works/pi-ai'
import type { CredentialStore } from '../src/main/ai-backends/model'
import {
  PiKeychainCredentialStore,
  piCredentialReferences
} from '../src/main/ai-backends/pi-credential-store'

class MemoryStringStore implements CredentialStore {
  readonly values = new Map<string, string>()
  readonly gets: string[] = []

  async get(reference: string): Promise<string | undefined> {
    this.gets.push(reference)
    return this.values.get(reference)
  }

  async set(reference: string, secret: string): Promise<void> {
    this.values.set(reference, secret)
  }

  async delete(reference: string): Promise<void> {
    this.values.delete(reference)
  }
}

function oauth(access = 'access-1'): Credential {
  return {
    type: 'oauth',
    access,
    refresh: 'refresh-1',
    expires: 2_000_000_000_000,
    accountId: 'account-1'
  }
}

describe('PiKeychainCredentialStore', () => {
  it('persists a validated OAuth credential and lists only non-secret metadata', async () => {
    const strings = new MemoryStringStore()
    const store = new PiKeychainCredentialStore(strings)

    await expect(store.modify('openai-codex', async () => oauth())).resolves.toEqual(oauth())
    await expect(store.read('openai-codex')).resolves.toEqual(oauth())

    strings.gets.length = 0
    await expect(store.list()).resolves.toEqual([{ providerId: 'openai-codex', type: 'oauth' }])
    expect(strings.gets).toEqual([piCredentialReferences.metadata('openai-codex')])
    expect(strings.values.get(piCredentialReferences.metadata('openai-codex'))).toBe('oauth')
    expect(strings.values.get(piCredentialReferences.credential('openai-codex'))).toContain('access-1')
  })

  it('strictly rejects malformed or unsupported stored credentials', async () => {
    const strings = new MemoryStringStore()
    const store = new PiKeychainCredentialStore(strings)
    const reference = piCredentialReferences.credential('openai-codex')

    strings.values.set(reference, '{invalid')
    await expect(store.read('openai-codex')).rejects.toThrow('valid JSON')

    strings.values.set(reference, JSON.stringify({ type: 'oauth', access: 'token' }))
    await expect(store.read('openai-codex')).rejects.toThrow('refresh token')

    strings.values.delete(reference)
    await expect(store.modify('openai-codex', async () => ({
      type: 'api_key',
      key: 'key',
      unexpected: true
    } as unknown as Credential))).rejects.toThrow('unsupported fields')
    expect(strings.values.has(reference)).toBe(false)
  })

  it('serializes modify calls per provider and passes the latest credential forward', async () => {
    const strings = new MemoryStringStore()
    const store = new PiKeychainCredentialStore(strings)
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    let firstEntered!: () => void
    const firstStarted = new Promise<void>((resolve) => { firstEntered = resolve })
    let active = 0
    let maximumActive = 0

    const first = store.modify('openai-codex', async () => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      firstEntered()
      await firstGate
      active -= 1
      return oauth('first')
    })
    await firstStarted
    const second = store.modify('openai-codex', async (current) => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      expect(current).toMatchObject({ type: 'oauth', access: 'first' })
      active -= 1
      return oauth('second')
    })

    await Promise.resolve()
    expect(maximumActive).toBe(1)
    releaseFirst()
    await Promise.all([first, second])
    expect(maximumActive).toBe(1)
    await expect(store.read('openai-codex')).resolves.toMatchObject({ access: 'second' })
  })

  it('preserves the current value when modify returns undefined and deletes both entries', async () => {
    const strings = new MemoryStringStore()
    const store = new PiKeychainCredentialStore(strings)
    await store.modify('openai-codex', async () => oauth())

    const preserved = await store.modify('openai-codex', async (current) => {
      if (current?.type === 'oauth') current.access = 'mutated-copy'
      return undefined
    })
    expect(preserved).toMatchObject({ access: 'access-1' })
    await expect(store.read('openai-codex')).resolves.toMatchObject({ access: 'access-1' })

    await store.delete('openai-codex')
    await expect(store.read('openai-codex')).resolves.toBeUndefined()
    await expect(store.list()).resolves.toEqual([])
  })
})

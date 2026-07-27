import { AsyncEntry } from '@napi-rs/keyring'
import type { CredentialStore } from './model'

const KEYCHAIN_SERVICE = 'com.oyster.ai-backends'

function validateReference(reference: string): void {
  if (!/^[a-zA-Z0-9:_-]{1,160}$/.test(reference)) {
    throw new Error('Invalid credential reference')
  }
}

export class KeychainCredentialStore implements CredentialStore {
  private entry(reference: string): AsyncEntry {
    validateReference(reference)
    return new AsyncEntry(KEYCHAIN_SERVICE, reference)
  }

  async get(reference: string): Promise<string | undefined> {
    return (await this.entry(reference).getPassword()) ?? undefined
  }

  async set(reference: string, secret: string): Promise<void> {
    if (!secret) throw new Error('API Key cannot be empty')
    await this.entry(reference).setPassword(secret)
  }

  async delete(reference: string): Promise<void> {
    await this.entry(reference).deleteCredential()
  }
}

export class MemoryCredentialStore implements CredentialStore {
  readonly values = new Map<string, string>()

  async get(reference: string): Promise<string | undefined> {
    return this.values.get(reference)
  }

  async set(reference: string, secret: string): Promise<void> {
    this.values.set(reference, secret)
  }

  async delete(reference: string): Promise<void> {
    this.values.delete(reference)
  }
}

import type {
  ApiKeyCredential,
  Credential,
  CredentialInfo,
  CredentialStore as PiCredentialStoreContract,
  OAuthCredential
} from '@earendil-works/pi-ai'
import type { CredentialStore as StringCredentialStore } from './model'

const DEFAULT_PROVIDER_IDS = ['openai-codex'] as const
const MAX_SERIALIZED_CREDENTIAL_BYTES = 256 * 1_024
const PROVIDER_ID = /^[a-zA-Z0-9._-]{1,100}$/

function assertProviderId(providerId: string): void {
  if (!PROVIDER_ID.test(providerId)) throw new Error('Pi credential provider ID is invalid')
}

function credentialReference(providerId: string): string {
  return `pi-credential:${providerId}`
}

function metadataReference(providerId: string): string {
  return `pi-credential-meta:${providerId}`
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isProviderEnvironment(value: unknown): value is Record<string, string> {
  return isPlainRecord(value)
    && Object.entries(value).every(([key, item]) => Boolean(key) && typeof item === 'string')
}

function validateApiKeyCredential(value: Record<string, unknown>): ApiKeyCredential {
  const keys = Object.keys(value)
  if (keys.some((key) => key !== 'type' && key !== 'key' && key !== 'env')) {
    throw new Error('Stored Pi API-key credential contains unsupported fields')
  }
  if (value.key !== undefined && (typeof value.key !== 'string' || !value.key)) {
    throw new Error('Stored Pi API-key credential has an invalid key')
  }
  if (value.env !== undefined && !isProviderEnvironment(value.env)) {
    throw new Error('Stored Pi API-key credential has an invalid environment')
  }
  if (value.key === undefined && value.env === undefined) {
    throw new Error('Stored Pi API-key credential is empty')
  }
  return structuredClone(value) as unknown as ApiKeyCredential
}

function validateOAuthCredential(value: Record<string, unknown>): OAuthCredential {
  const keys = Object.keys(value)
  if (keys.some((key) => !['type', 'access', 'refresh', 'expires', 'accountId'].includes(key))) {
    throw new Error('Stored Pi OAuth credential contains unsupported fields')
  }
  if (typeof value.access !== 'string' || !value.access) {
    throw new Error('Stored Pi OAuth credential has an invalid access token')
  }
  if (typeof value.refresh !== 'string' || !value.refresh) {
    throw new Error('Stored Pi OAuth credential has an invalid refresh token')
  }
  if (
    typeof value.expires !== 'number'
    || !Number.isFinite(value.expires)
    || value.expires < 0
  ) {
    throw new Error('Stored Pi OAuth credential has an invalid expiry')
  }
  if (
    value.accountId !== undefined
    && (typeof value.accountId !== 'string' || !value.accountId)
  ) {
    throw new Error('Stored Pi OAuth credential has an invalid account ID')
  }
  return structuredClone(value) as unknown as OAuthCredential
}

function validateCredential(value: unknown): Credential {
  if (!isPlainRecord(value)) throw new Error('Stored Pi credential must be an object')
  if (value.type === 'api_key') return validateApiKeyCredential(value)
  if (value.type === 'oauth') return validateOAuthCredential(value)
  throw new Error('Stored Pi credential has an unsupported type')
}

function parseCredential(serialized: string): Credential {
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SERIALIZED_CREDENTIAL_BYTES) {
    throw new Error('Stored Pi credential is too large')
  }
  let value: unknown
  try {
    value = JSON.parse(serialized) as unknown
  } catch {
    throw new Error('Stored Pi credential is not valid JSON')
  }
  return validateCredential(value)
}

function serializeCredential(credential: Credential): string {
  const serialized = JSON.stringify(validateCredential(credential))
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SERIALIZED_CREDENTIAL_BYTES) {
    throw new Error('Pi credential is too large to persist')
  }
  return serialized
}

function parseCredentialType(value: string): Credential['type'] {
  if (value === 'api_key' || value === 'oauth') return value
  throw new Error('Stored Pi credential metadata has an unsupported type')
}

/**
 * Adapts Oyster's string-only secret store to Pi's structured credential contract.
 * Credential bodies and non-secret enumeration metadata use separate Keychain entries,
 * so `list()` never needs to load an access token.
 */
export class PiKeychainCredentialStore implements PiCredentialStoreContract {
  private readonly providerIds: Set<string>
  private readonly queues = new Map<string, Promise<void>>()

  constructor(
    private readonly secrets: StringCredentialStore,
    providerIds: readonly string[] = DEFAULT_PROVIDER_IDS
  ) {
    for (const providerId of providerIds) assertProviderId(providerId)
    this.providerIds = new Set(providerIds)
  }

  private enqueue<T>(providerId: string, operation: () => Promise<T>): Promise<T> {
    assertProviderId(providerId)
    this.providerIds.add(providerId)
    const previous = this.queues.get(providerId) ?? Promise.resolve()
    const result = previous.then(operation, operation)
    const tail = result.then(() => undefined, () => undefined)
    this.queues.set(providerId, tail)
    void tail.finally(() => {
      if (this.queues.get(providerId) === tail) this.queues.delete(providerId)
    })
    return result
  }

  private async readUnlocked(providerId: string): Promise<Credential | undefined> {
    const serialized = await this.secrets.get(credentialReference(providerId))
    return serialized === undefined ? undefined : parseCredential(serialized)
  }

  async read(providerId: string): Promise<Credential | undefined> {
    assertProviderId(providerId)
    const credential = await this.readUnlocked(providerId)
    return credential ? structuredClone(credential) : undefined
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const entries = await Promise.all([...this.providerIds].sort().map(async (providerId) => {
      const type = await this.secrets.get(metadataReference(providerId))
      return type === undefined
        ? undefined
        : { providerId, type: parseCredentialType(type) }
    }))
    return entries.filter((entry): entry is CredentialInfo => entry !== undefined)
  }

  modify(
    providerId: string,
    update: (current: Credential | undefined) => Promise<Credential | undefined>
  ): Promise<Credential | undefined> {
    return this.enqueue(providerId, async () => {
      const previousSerialized = await this.secrets.get(credentialReference(providerId))
      const current = previousSerialized === undefined
        ? undefined
        : parseCredential(previousSerialized)
      const candidate = await update(current ? structuredClone(current) : undefined)
      if (candidate === undefined) return current ? structuredClone(current) : undefined

      const next = validateCredential(candidate)
      const serialized = serializeCredential(next)
      await this.secrets.set(credentialReference(providerId), serialized)
      try {
        await this.secrets.set(metadataReference(providerId), next.type)
      } catch (error) {
        if (previousSerialized === undefined) {
          await this.secrets.delete(credentialReference(providerId)).catch(() => undefined)
        } else {
          await this.secrets.set(credentialReference(providerId), previousSerialized).catch(() => undefined)
        }
        throw error
      }
      return structuredClone(next)
    })
  }

  delete(providerId: string): Promise<void> {
    return this.enqueue(providerId, async () => {
      await this.secrets.delete(credentialReference(providerId)).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })
      await this.secrets.delete(metadataReference(providerId)).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })
    })
  }
}

export const piCredentialReferences = {
  credential: credentialReference,
  metadata: metadataReference
} as const

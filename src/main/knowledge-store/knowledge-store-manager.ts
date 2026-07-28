import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { SqliteKnowledgeStore, type SqliteKnowledgeStoreOptions } from './sqlite-knowledge-store'

const SANDBOX_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface KnowledgeSandbox {
  id: string
  databasePath: string
  baselineCreatedAt: string
  store: SqliteKnowledgeStore
}

export interface KnowledgeSandboxSummary {
  id: string
  databasePath: string
  createdAt: string
}

export interface SqliteKnowledgeStoreManagerOptions extends SqliteKnowledgeStoreOptions {
  sandboxIdFactory?: () => string
}

/**
 * Owns one authoritative Store and physically isolated, disposable snapshots.
 * Callers bind a run to a Store instance; the Agent never chooses the target.
 */
export class SqliteKnowledgeStoreManager {
  readonly production: SqliteKnowledgeStore
  private readonly sandboxesPath: string
  private readonly openSandboxes = new Map<string, SqliteKnowledgeStore>()
  private readonly sandboxIdFactory: () => string
  private readonly storeOptions: SqliteKnowledgeStoreOptions
  private closed = false

  private constructor(
    readonly rootPath: string,
    options: SqliteKnowledgeStoreManagerOptions
  ) {
    this.sandboxesPath = join(rootPath, 'sandboxes')
    this.sandboxIdFactory = options.sandboxIdFactory ?? randomUUID
    this.storeOptions = { clock: options.clock }
    this.production = new SqliteKnowledgeStore(join(rootPath, 'knowledge.sqlite'), this.storeOptions)
  }

  static async open(
    rootPath: string,
    options: SqliteKnowledgeStoreManagerOptions = {}
  ): Promise<SqliteKnowledgeStoreManager> {
    await mkdir(join(rootPath, 'sandboxes'), { recursive: true })
    return new SqliteKnowledgeStoreManager(rootPath, options)
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Knowledge Store Manager 已关闭')
  }

  private validateSandboxId(sandboxId: string): string {
    if (!SANDBOX_ID.test(sandboxId)) throw new Error('Sandbox ID 无效')
    return sandboxId
  }

  private sandboxDatabasePath(sandboxId: string): string {
    return join(this.sandboxesPath, this.validateSandboxId(sandboxId), 'knowledge.sqlite')
  }

  async createSandbox(): Promise<KnowledgeSandbox> {
    this.assertOpen()
    const id = this.validateSandboxId(this.sandboxIdFactory())
    const directoryPath = join(this.sandboxesPath, id)
    const databasePath = join(directoryPath, 'knowledge.sqlite')
    await mkdir(directoryPath, { recursive: false })
    try {
      await this.production.snapshotTo(databasePath)
      const store = new SqliteKnowledgeStore(databasePath, this.storeOptions)
      this.openSandboxes.set(id, store)
      return {
        id,
        databasePath,
        baselineCreatedAt: new Date().toISOString(),
        store
      }
    } catch (error) {
      await rm(directoryPath, { recursive: true, force: true })
      throw error
    }
  }

  async openSandbox(sandboxId: string): Promise<SqliteKnowledgeStore> {
    this.assertOpen()
    const id = this.validateSandboxId(sandboxId)
    const opened = this.openSandboxes.get(id)
    if (opened) return opened
    const databasePath = this.sandboxDatabasePath(id)
    await stat(databasePath)
    const store = new SqliteKnowledgeStore(databasePath, this.storeOptions)
    this.openSandboxes.set(id, store)
    return store
  }

  async listSandboxes(): Promise<KnowledgeSandboxSummary[]> {
    this.assertOpen()
    const entries = await readdir(this.sandboxesPath, { withFileTypes: true })
    const summaries = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && SANDBOX_ID.test(entry.name))
      .map(async (entry): Promise<KnowledgeSandboxSummary | undefined> => {
        const databasePath = this.sandboxDatabasePath(entry.name)
        try {
          const details = await stat(databasePath)
          return {
            id: entry.name,
            databasePath,
            createdAt: details.birthtime.toISOString()
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
          throw error
        }
      }))
    return summaries
      .filter((summary): summary is KnowledgeSandboxSummary => Boolean(summary))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  async discardSandbox(sandboxId: string): Promise<void> {
    this.assertOpen()
    const id = this.validateSandboxId(sandboxId)
    this.openSandboxes.get(id)?.close()
    this.openSandboxes.delete(id)
    await rm(join(this.sandboxesPath, id), { recursive: true, force: true })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const store of this.openSandboxes.values()) store.close()
    this.openSandboxes.clear()
    this.production.close()
  }
}

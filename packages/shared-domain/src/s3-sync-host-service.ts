import type {
  CloudSyncBootstrapConflict,
  CloudSyncRunSummary
} from '@zennotes/bridge-contract/cloud-sync'
import type {
  S3SyncConflictChoice,
  S3SyncConflictSummary,
  S3SyncRunResult,
  S3SyncSettingsInput,
  S3SyncStatus
} from '@zennotes/bridge-contract/s3-sync'
import type { CloudSyncCoordinator, CloudSyncRemote } from './cloud-sync-coordinator'
import type { CloudSyncState } from './cloud-sync-engine'
import {
  createS3HttpObjectStore,
  S3RequestError,
  type S3Credentials,
  type S3ObjectStore
} from './s3-object-store'
import { createS3SyncRemote, ensureS3SyncVault, S3SyncError } from './s3-sync-remote'

/**
 * S3 sync for a local vault, the same on every host: the desktop app keeps
 * its settings in a file and its key in the OS keychain, the phones keep
 * both through the portable host (Capacitor storage and the iOS Keychain or
 * Android Keystore). Each host hands this service its storage, its secret
 * store and a way to build the sync engine over the vault's files; the
 * bucket format, the checks on what a person types, the conflict choices and
 * the error sentences are shared, so a Mac and a phone always agree on what
 * is in the bucket.
 *
 * A vault is named by a key the host derives from where the vault lives (the
 * desktop hashes the folder path, the phones hash the vault's sync key), so
 * settings and engine state follow the vault, not the window.
 */

export interface S3SyncSecrets {
  get(id: string): Promise<string | null>
  /** False when the system has nowhere safe to keep it. */
  set(id: string, secret: string): Promise<boolean>
  delete(id: string): Promise<void>
  canStore(): boolean
}

export interface S3SyncConnection {
  bucket: string
  region: string
  endpoint: string | null
  forcePathStyle: boolean
  credentials: S3Credentials
}

/** The vault a call is about: the host's stable key and how it names the vault. */
export interface S3SyncVaultRef {
  key: string
  /** The folder path on desktop, the vault's sync key on a phone. Kept in
   *  the settings so a person reading the file can tell vaults apart. */
  root: string
}

export interface S3SyncVaultSettings {
  root: string
  bucket: string
  region: string
  endpoint: string | null
  prefix: string
  forcePathStyle: boolean
  accessKeyId: string
  vaultName: string
  vaultId: string
  lastSyncedAt: number | null
  lastError: string | null
  /** First-sync clashes from the last run. The engine reports them per run,
   *  so they are kept here for the settings page between runs. */
  bootstrapConflicts: CloudSyncBootstrapConflict[]
}

export interface S3SyncSettingsFile {
  version: 1
  vaults: Record<string, S3SyncVaultSettings>
}

export interface S3SyncHostPersistence {
  /** The settings file's contents, or null when there is none yet. */
  loadSettings(): Promise<unknown>
  saveSettings(file: S3SyncSettingsFile): Promise<void>
  /** The engine's saved state for this vault, for its pending conflicts. */
  loadState(vault: S3SyncVaultRef, vaultId: string): Promise<CloudSyncState | null>
  /** Forget the engine state once the vault stops syncing; `vaultId` is
   *  the bucket vault it synced with. */
  clearState(vault: S3SyncVaultRef, vaultId: string | null): Promise<void>
}

/** The words a host uses for itself in sentences: "computer", "iPhone". */
export interface S3SyncHostWords {
  device: string
}

export interface S3SyncHostServiceDependencies {
  persistence: S3SyncHostPersistence
  secrets: S3SyncSecrets
  /** Builds the sync engine over this vault's files for a remote. */
  createCoordinator(input: {
    vault: S3SyncVaultRef
    settings: S3SyncVaultSettings
    remote: CloudSyncRemote
    name: string
  }): CloudSyncCoordinator | Promise<CloudSyncCoordinator>
  /** Defaults to signed requests over `fetch` (or `fetchImplementation`).
   *  Tests pass an in-memory bucket. */
  createStore?(connection: S3SyncConnection): S3ObjectStore
  /** The phones send S3 requests through their native HTTP, outside CORS. */
  fetchImplementation?: typeof fetch
  /** Why this vault already syncs elsewhere (Cloud, iCloud), or null. */
  syncsElsewhere?(vault: S3SyncVaultRef): Promise<string | null>
  /** Wraps a run, e.g. to save drafts in other windows first. */
  withRun?(vault: S3SyncVaultRef, run: () => Promise<CloudSyncRunSummary>): Promise<CloudSyncRunSummary>
  /** After a run or a conflict choice changed files, so the app reloads them. */
  afterChange?(vault: S3SyncVaultRef): Promise<void>
  words?: S3SyncHostWords
  now?: () => number
}

const DEFAULT_PREFIX = 'zotly/'

export class S3SyncInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'S3SyncInputError'
  }
}

export class S3SyncHostService {
  private readonly runs = new Map<string, Promise<S3SyncRunResult>>()
  private readonly operations = new Map<string, Promise<unknown>>()
  private settingsWrite: Promise<unknown> = Promise.resolve()
  private settingsCache: S3SyncSettingsFile | null = null
  private readonly now: () => number
  private readonly device: string

  constructor(private readonly dependencies: S3SyncHostServiceDependencies) {
    this.now = dependencies.now ?? Date.now
    this.device = dependencies.words?.device ?? 'computer'
  }

  // --- Status ------------------------------------------------------------

  async status(vault: S3SyncVaultRef): Promise<S3SyncStatus> {
    const elsewhere = await this.dependencies.syncsElsewhere?.(vault).catch(() => null)
    const settings = elsewhere ? null : await this.vaultSettings(vault)
    const hasSecretKey = settings
      ? !!(await this.dependencies.secrets.get(vault.key).catch(() => null))
      : false
    let conflicts: S3SyncConflictSummary[] = []
    if (settings) {
      conflicts = [
        ...settings.bootstrapConflicts.map((conflict) => ({
          id: `first-sync:${conflict.item_id}`,
          path: conflict.path,
          kind: 'first-sync' as const
        })),
        ...(await this.pendingConflicts(vault, settings).catch(() => []))
      ]
    }
    return {
      available: !elsewhere,
      unavailableReason: elsewhere ?? null,
      configured: !!settings,
      bucket: settings?.bucket ?? null,
      region: settings?.region ?? null,
      endpoint: settings?.endpoint ?? null,
      prefix: settings?.prefix ?? null,
      forcePathStyle: settings?.forcePathStyle ?? false,
      accessKeyId: settings?.accessKeyId ?? null,
      vaultName: settings?.vaultName ?? null,
      hasSecretKey,
      canStoreSecurely: this.dependencies.secrets.canStore(),
      device: this.device,
      lastSyncedAt: settings?.lastSyncedAt ?? null,
      lastError: settings?.lastError ?? null,
      syncing: this.runs.has(vault.key),
      conflicts
    }
  }

  // --- Turning it on and off --------------------------------------------

  /**
   * Check the bucket with the given keys, keep them, then run the first sync.
   * Nothing is saved when the bucket refuses, so a typo never leaves a
   * half-set-up vault behind.
   */
  async save(vault: S3SyncVaultRef, raw: unknown): Promise<S3SyncRunResult> {
    const elsewhere = await this.dependencies.syncsElsewhere?.(vault)
    if (elsewhere) throw new S3SyncInputError(elsewhere)
    const input = normalizeS3SyncInput(raw)
    const current = await this.vaultSettings(vault)
    const secretAccessKey = input.secretAccessKey ?? (await this.dependencies.secrets.get(vault.key))
    if (!secretAccessKey) throw new S3SyncInputError('Paste the secret access key for this access key ID.')
    if (current && current.accessKeyId !== input.accessKeyId && !input.secretAccessKey) {
      throw new S3SyncInputError('A new access key ID needs its own secret access key.')
    }
    const vaultId = s3VaultIdFor(input.vaultName)
    if (current && current.vaultId !== vaultId) {
      // Pointing a vault that has synced at another bucket vault would read
      // every file there as a change against this one.
      throw new S3SyncInputError(
        'Disconnect S3 sync first to point this vault at a different vault in the bucket.'
      )
    }
    if (input.secretAccessKey && !this.dependencies.secrets.canStore()) {
      // Say so before touching the bucket, not after writing vault.json.
      throw new S3SyncInputError(
        `This ${this.device} has no secure place to keep the secret key, so it was not saved.`
      )
    }
    const store = this.store({ ...input, credentials: { accessKeyId: input.accessKeyId, secretAccessKey } })
    try {
      await ensureS3SyncVault(store, { prefix: input.prefix, vaultId, name: input.vaultName })
    } catch (error) {
      throw new Error(describeS3SyncError(error, input.bucket))
    }
    if (input.secretAccessKey) {
      const stored = await this.dependencies.secrets.set(vault.key, input.secretAccessKey)
      if (!stored) {
        throw new S3SyncInputError(
          `This ${this.device} has no secure place to keep the secret key, so it was not saved.`
        )
      }
    }
    await this.updateSettings(vault, () => ({
      root: vault.root,
      bucket: input.bucket,
      region: input.region,
      endpoint: input.endpoint,
      prefix: input.prefix,
      forcePathStyle: input.forcePathStyle,
      accessKeyId: input.accessKeyId,
      vaultName: input.vaultName,
      vaultId,
      lastSyncedAt: current?.lastSyncedAt ?? null,
      lastError: null,
      bootstrapConflicts: current?.bootstrapConflicts ?? []
    }))
    return await this.sync(vault)
  }

  /** Stop syncing this vault. The bucket and the notes here both stay as they are. */
  async disconnect(vault: S3SyncVaultRef): Promise<void> {
    await this.exclusive(vault.key, async () => {
      const vaultId = (await this.vaultSettings(vault))?.vaultId ?? null
      await this.updateSettings(vault, () => null)
      await this.dependencies.secrets.delete(vault.key)
      await this.dependencies.persistence.clearState(vault, vaultId)
    })
  }

  async isConfigured(vault: S3SyncVaultRef): Promise<boolean> {
    return !!(await this.vaultSettings(vault))
  }

  // --- Sync --------------------------------------------------------------

  sync(vault: S3SyncVaultRef): Promise<S3SyncRunResult> {
    const existing = this.runs.get(vault.key)
    if (existing) return existing
    const run = async (): Promise<CloudSyncRunSummary> => {
      // Checked on every run, not only on save: a vault can start syncing
      // another way later, and two syncs on one folder fight over every file.
      const elsewhere = await this.dependencies.syncsElsewhere?.(vault)
      if (elsewhere) throw new S3SyncInputError(elsewhere)
      const settings = await this.requireSettings(vault)
      return await this.exclusive(vault.key, () => this.runOnce(vault, settings))
    }
    const running = (this.dependencies.withRun ? this.dependencies.withRun(vault, run) : run())
      .then((summary) => ({
        pulled: summary.pulled,
        pushed: summary.pushed,
        conflicts: (summary.pending_conflicts?.length ?? 0) + summary.bootstrap_conflicts.length
      }))
      .finally(() => this.runs.delete(vault.key))
    this.runs.set(vault.key, running)
    return running
  }

  private async runOnce(vault: S3SyncVaultRef, settings: S3SyncVaultSettings): Promise<CloudSyncRunSummary> {
    const coordinator = await this.coordinator(vault, settings)
    try {
      const result = await coordinator.sync()
      await this.updateSettings(vault, (current) =>
        current
          ? { ...current, lastSyncedAt: this.now(), lastError: null, bootstrapConflicts: result.bootstrapConflicts }
          : null
      )
      return {
        cursor: result.state.cursor,
        pulled: result.pulled,
        pushed: result.pushed,
        conflicts: result.conflicts,
        bootstrap_conflicts: result.bootstrapConflicts,
        local_conflicts: result.localConflicts,
        pending_conflicts: result.pendingConflicts,
        legacy_conflict_copies: result.legacyConflictCopies,
        refused_paths: result.refusedPaths
      }
    } catch (error) {
      const message = describeS3SyncError(error, settings.bucket)
      await this.updateSettings(vault, (current) => (current ? { ...current, lastError: message } : null))
      throw new Error(message)
    } finally {
      await this.dependencies.afterChange?.(vault).catch(() => undefined)
    }
  }

  // --- Conflicts ----------------------------------------------------------

  async resolveConflict(vault: S3SyncVaultRef, conflictId: unknown, choice: unknown): Promise<void> {
    if (typeof conflictId !== 'string' || !conflictId || conflictId.length > 200) {
      throw new S3SyncInputError('That conflict is not one this vault has.')
    }
    if (choice !== 'local' && choice !== 'remote' && choice !== 'both') {
      throw new S3SyncInputError(`Choose this ${this.device}’s version, the bucket’s, or both.`)
    }
    const settings = await this.requireSettings(vault)
    await this.exclusive(vault.key, async () => {
      const coordinator = await this.coordinator(vault, settings)
      try {
        if (conflictId.startsWith('first-sync:')) {
          const itemId = conflictId.slice('first-sync:'.length)
          const conflict = settings.bootstrapConflicts.find((candidate) => candidate.item_id === itemId)
          if (!conflict) throw new S3SyncInputError('That conflict was already settled.')
          await coordinator.resolveBootstrapConflict({
            conflict,
            choice: choice === 'remote' ? 'cloud' : choice,
            ...(choice === 'both' ? { keep_both_path: s3KeepBothPath(conflict.path, this.device) } : {})
          })
          await this.updateSettings(vault, (current) =>
            current
              ? {
                  ...current,
                  bootstrapConflicts: current.bootstrapConflicts.filter((candidate) => candidate.item_id !== itemId)
                }
              : null
          )
          return
        }
        const details = await coordinator.getConflict(conflictId)
        await coordinator.resolveConflict({
          conflict_id: conflictId,
          choice: choice === 'remote' ? 'cloud' : choice,
          expected_local_sha256: details.local.sha256,
          expected_cloud_revision: details.cloud.revision,
          ...(choice === 'both'
            ? { keep_both_path: s3KeepBothPath(details.local.path ?? details.conflict.path, this.device) }
            : {})
        })
      } catch (error) {
        if (error instanceof S3SyncInputError) throw error
        throw new Error(describeS3SyncError(error, settings.bucket))
      } finally {
        await this.dependencies.afterChange?.(vault).catch(() => undefined)
      }
    })
  }

  private async pendingConflicts(
    vault: S3SyncVaultRef,
    settings: S3SyncVaultSettings
  ): Promise<S3SyncConflictSummary[]> {
    const state = await this.dependencies.persistence.loadState(vault, settings.vaultId)
    return Object.values(state?.pending_conflicts ?? {}).map((conflict) => ({
      id: conflict.id,
      path: conflict.local.path ?? conflict.cloud.path ?? conflict.base.path ?? '',
      kind: 'edit' as const
    }))
  }

  // --- Plumbing ----------------------------------------------------------

  private store(connection: S3SyncConnection): S3ObjectStore {
    if (this.dependencies.createStore) return this.dependencies.createStore(connection)
    return createS3HttpObjectStore({
      bucket: connection.bucket,
      region: connection.region,
      credentials: connection.credentials,
      ...(connection.endpoint ? { endpoint: connection.endpoint } : {}),
      forcePathStyle: connection.forcePathStyle,
      ...(this.dependencies.fetchImplementation ? { fetchImplementation: this.dependencies.fetchImplementation } : {})
    })
  }

  private async coordinator(vault: S3SyncVaultRef, settings: S3SyncVaultSettings): Promise<CloudSyncCoordinator> {
    const secretAccessKey = await this.dependencies.secrets.get(vault.key)
    if (!secretAccessKey) {
      throw new S3SyncInputError(
        `The secret access key is missing from this ${this.device}. Paste it again in Settings.`
      )
    }
    const store = this.store({
      bucket: settings.bucket,
      region: settings.region,
      endpoint: settings.endpoint,
      forcePathStyle: settings.forcePathStyle,
      credentials: { accessKeyId: settings.accessKeyId, secretAccessKey }
    })
    const remote = createS3SyncRemote({ store, prefix: settings.prefix })
    return await this.dependencies.createCoordinator({ vault, settings, remote, name: `S3 (${settings.bucket})` })
  }

  private async requireSettings(vault: S3SyncVaultRef): Promise<S3SyncVaultSettings> {
    const settings = await this.vaultSettings(vault)
    if (!settings) throw new S3SyncInputError('This vault does not sync with S3.')
    return settings
  }

  private async vaultSettings(vault: S3SyncVaultRef): Promise<S3SyncVaultSettings | null> {
    return (await this.readSettings()).vaults[vault.key] ?? null
  }

  private async readSettings(): Promise<S3SyncSettingsFile> {
    if (this.settingsCache) return this.settingsCache
    let parsed: unknown = null
    try {
      parsed = await this.dependencies.persistence.loadSettings()
    } catch {
      // Damaged: no vault syncs with S3.
    }
    const file = parsed as Partial<S3SyncSettingsFile> | null
    if (file && file.version === 1 && file.vaults && typeof file.vaults === 'object') {
      this.settingsCache = file as S3SyncSettingsFile
      return this.settingsCache
    }
    this.settingsCache = { version: 1, vaults: {} }
    return this.settingsCache
  }

  private updateSettings(
    vault: S3SyncVaultRef,
    update: (current: S3SyncVaultSettings | null) => S3SyncVaultSettings | null
  ): Promise<S3SyncVaultSettings | null> {
    const write = this.settingsWrite.catch(() => undefined).then(async () => {
      const settings = await this.readSettings()
      const next = update(settings.vaults[vault.key] ?? null)
      const vaults = { ...settings.vaults }
      if (next) vaults[vault.key] = next
      else delete vaults[vault.key]
      const file: S3SyncSettingsFile = { version: 1, vaults }
      await this.dependencies.persistence.saveSettings(file)
      this.settingsCache = file
      return next
    })
    this.settingsWrite = write
    return write
  }

  private exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(key)
    let current!: Promise<T>
    current = (previous ? previous.catch(() => undefined) : Promise.resolve())
      .then(operation)
      .finally(() => {
        if (this.operations.get(key) === current) this.operations.delete(key)
      })
    this.operations.set(key, current)
    return current
  }
}

// --- Input ---------------------------------------------------------------

export interface NormalizedS3SyncInput {
  bucket: string
  region: string
  endpoint: string | null
  prefix: string
  forcePathStyle: boolean
  accessKeyId: string
  secretAccessKey: string | null
  vaultName: string
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

export function normalizeS3SyncInput(raw: unknown): NormalizedS3SyncInput {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof S3SyncSettingsInput, unknown>>
  const bucket = text(input.bucket, 100)
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new S3SyncInputError('Bucket names are 3 to 63 lowercase letters, numbers, dots and hyphens.')
  }
  const region = text(input.region, 40) || 'us-east-1'
  if (!/^[a-z0-9-]{2,32}$/.test(region)) throw new S3SyncInputError('That region does not look right, e.g. us-east-1.')
  const endpoint = normalizeEndpoint(text(input.endpoint, 300))
  const accessKeyId = text(input.accessKeyId, 128)
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(accessKeyId)) throw new S3SyncInputError('Paste the access key ID.')
  const secretAccessKey = text(input.secretAccessKey, 256) || null
  const vaultName = text(input.vaultName, 80)
  if (!vaultName) throw new S3SyncInputError('Name the vault in the bucket, e.g. Notes.')
  s3VaultIdFor(vaultName)
  return {
    bucket,
    region,
    endpoint,
    prefix: normalizeS3Prefix(typeof input.prefix === 'string' ? input.prefix : DEFAULT_PREFIX),
    forcePathStyle: input.forcePathStyle === true || endpoint !== null,
    accessKeyId,
    secretAccessKey,
    vaultName
  }
}

function normalizeEndpoint(value: string): string | null {
  if (!value) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new S3SyncInputError('The endpoint must be a full address, e.g. https://example.r2.cloudflarestorage.com.')
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new S3SyncInputError('The endpoint must use https, except for a store on this computer.')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new S3SyncInputError('The endpoint is just the service address, without a query or sign-in.')
  }
  return url.toString().replace(/\/+$/, '')
}

export function normalizeS3Prefix(value: string): string {
  const trimmed = value.trim().replace(/^\/+/, '').replace(/\/{2,}/g, '/')
  if (!trimmed) return ''
  if (!/^[A-Za-z0-9!_.*'()\/-]{1,200}$/.test(trimmed) || trimmed.split('/').includes('..')) {
    throw new S3SyncInputError('The folder in the bucket can use letters, numbers and - _ . / only.')
  }
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`
}

/** The vault's folder name in the bucket: the same name on every device. */
export function s3VaultIdFor(name: string): string {
  const id = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  if (!id) throw new S3SyncInputError('Use at least one letter or number in the vault name.')
  return id
}

/** `Inbox/plan.md` becomes `Inbox/plan (this computer).md`. */
export function s3KeepBothPath(relativePath: string, device = 'computer'): string {
  const slash = relativePath.lastIndexOf('/')
  const dot = relativePath.lastIndexOf('.')
  const extension = dot > slash + 1 ? relativePath.slice(dot) : ''
  const base = extension ? relativePath.slice(0, -extension.length) : relativePath
  return `${base} (this ${device})${extension}`
}

/** Words for the settings page. Never includes keys: S3 errors name only the bucket. */
export function describeS3SyncError(error: unknown, bucket: string): string {
  if (error instanceof S3SyncInputError) return error.message
  if (error instanceof S3RequestError) {
    if (error.status === 403 || error.code === 'AccessDenied' || error.code === 'SignatureDoesNotMatch' ||
      error.code === 'InvalidAccessKeyId') {
      return `The bucket ${bucket} refused these keys. Check the access key, the secret and the bucket policy.`
    }
    if (error.status === 404 || error.code === 'NoSuchBucket') return `There is no bucket named ${bucket} in that region.`
    if (error.code === 'PermanentRedirect' || error.code === 'AuthorizationHeaderMalformed') {
      return `The bucket ${bucket} is in a different region. Check the region.`
    }
    return `The bucket ${bucket} answered with an error (${error.code ?? error.status}).`
  }
  if (error instanceof S3SyncError) {
    if (error.code === 'SYNC_BUSY') return 'Another device is syncing this vault right now. Try again in a moment.'
    if (error.code === 'SYNC_ENCRYPTION_UNSUPPORTED') return 'End-to-end encrypted vaults cannot sync with S3 yet.'
    return error.message
  }
  if (error instanceof TypeError) return `ZenNotes could not reach the bucket ${bucket}. Check the connection and the endpoint.`
  return error instanceof Error ? error.message : String(error)
}

import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
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
import type { CloudSyncCoordinator } from '@zennotes/shared-domain/cloud-sync-coordinator'
import {
  createS3HttpObjectStore,
  S3RequestError,
  type S3Credentials,
  type S3ObjectStore
} from '@zennotes/shared-domain/s3-object-store'
import { createS3SyncRemote, ensureS3SyncVault, S3SyncError } from '@zennotes/shared-domain/s3-sync-remote'
import { createDesktopCloudSyncCoordinator, DesktopCloudSyncStateStore } from '../cloud-sync-filesystem'

/**
 * S3 sync for a local vault: the folder the window already has open syncs
 * straight with a bucket the person owns, through the same engine Cloud and
 * the self-hosted server use. There is no copy folder: the vault is the
 * offline queue, and the engine plans what to send by comparing it with the
 * last state the bucket acknowledged.
 *
 * Layout under userData:
 *
 *   <storage>/settings.json            one entry per vault folder
 *   <storage>/<fingerprint>/state/     the engine's CloudSyncState
 *
 * The secret access key never goes in settings.json: it lives in the system's
 * secure storage, keyed by the vault's fingerprint, and the renderer only
 * hears whether one is saved.
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

export interface S3SyncServiceDependencies {
  storageDirectory: string
  secrets: S3SyncSecrets
  /** Defaults to signed requests over fetch. Tests pass an in-memory bucket. */
  createStore?(connection: S3SyncConnection): S3ObjectStore
  /** Why this folder already syncs elsewhere (Cloud), or null when it does not. */
  syncsElsewhere?(root: string): Promise<string | null>
  /** Draft saves in other windows on the folder, before a run touches it. */
  withWindowSync?(root: string, run: () => Promise<CloudSyncRunSummary>): Promise<CloudSyncRunSummary>
  now?: () => number
}

interface VaultSettings {
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

interface SettingsFile {
  version: 1
  vaults: Record<string, VaultSettings>
}

const DEFAULT_PREFIX = 'zotly/'

export class S3SyncInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'S3SyncInputError'
  }
}

export class S3SyncService {
  private readonly runs = new Map<string, Promise<S3SyncRunResult>>()
  private readonly operations = new Map<string, Promise<unknown>>()
  private settingsWrite: Promise<unknown> = Promise.resolve()
  private settingsCache: SettingsFile | null = null
  private readonly now: () => number

  constructor(private readonly dependencies: S3SyncServiceDependencies) {
    this.now = dependencies.now ?? Date.now
  }

  // --- Status ------------------------------------------------------------

  async status(root: string): Promise<S3SyncStatus> {
    const settings = await this.vaultSettings(root)
    const key = fingerprint(root)
    const hasSecretKey = settings ? !!(await this.dependencies.secrets.get(key).catch(() => null)) : false
    let conflicts: S3SyncConflictSummary[] = []
    if (settings) {
      conflicts = [
        ...settings.bootstrapConflicts.map((conflict) => ({
          id: `first-sync:${conflict.item_id}`,
          path: conflict.path,
          kind: 'first-sync' as const
        })),
        ...(await this.pendingConflicts(root, settings).catch(() => []))
      ]
    }
    return {
      available: true,
      unavailableReason: null,
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
      lastSyncedAt: settings?.lastSyncedAt ?? null,
      lastError: settings?.lastError ?? null,
      syncing: this.runs.has(key),
      conflicts
    }
  }

  // --- Turning it on and off --------------------------------------------

  /**
   * Check the bucket with the given keys, keep them, then run the first sync.
   * Nothing is saved when the bucket refuses, so a typo never leaves a
   * half-set-up vault behind.
   */
  async save(root: string, raw: unknown): Promise<S3SyncRunResult> {
    const elsewhere = await this.dependencies.syncsElsewhere?.(root)
    if (elsewhere) throw new S3SyncInputError(elsewhere)
    const input = normalizeInput(raw)
    const key = fingerprint(root)
    const current = await this.vaultSettings(root)
    const secretAccessKey = input.secretAccessKey ?? (await this.dependencies.secrets.get(key))
    if (!secretAccessKey) throw new S3SyncInputError('Paste the secret access key for this access key ID.')
    if (current && current.accessKeyId !== input.accessKeyId && !input.secretAccessKey) {
      throw new S3SyncInputError('A new access key ID needs its own secret access key.')
    }
    const vaultId = vaultIdFor(input.vaultName)
    if (current && current.vaultId !== vaultId) {
      // Pointing a vault that has synced at another bucket vault would read
      // every file there as a change against this one.
      throw new S3SyncInputError(
        'Disconnect S3 sync first to point this vault at a different vault in the bucket.'
      )
    }
    const store = this.store({ ...input, credentials: { accessKeyId: input.accessKeyId, secretAccessKey } })
    try {
      await ensureS3SyncVault(store, { prefix: input.prefix, vaultId, name: input.vaultName })
    } catch (error) {
      throw new Error(describeS3Error(error, input.bucket))
    }
    if (input.secretAccessKey) {
      const stored = await this.dependencies.secrets.set(key, input.secretAccessKey)
      if (!stored) {
        throw new S3SyncInputError(
          'This computer has no secure place to keep the secret key, so it was not saved.'
        )
      }
    }
    await this.updateSettings(root, () => ({
      root: path.resolve(root),
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
    return await this.sync(root)
  }

  /** Stop syncing this folder. The bucket and the notes here both stay as they are. */
  async disconnect(root: string): Promise<void> {
    const key = fingerprint(root)
    await this.exclusive(key, async () => {
      await this.updateSettings(root, () => null)
      await this.dependencies.secrets.delete(key)
      await fs.rm(path.join(this.dependencies.storageDirectory, key), { recursive: true, force: true })
    })
  }

  async isConfigured(root: string): Promise<boolean> {
    return !!(await this.vaultSettings(root))
  }

  // --- Sync --------------------------------------------------------------

  sync(root: string): Promise<S3SyncRunResult> {
    const key = fingerprint(root)
    const existing = this.runs.get(key)
    if (existing) return existing
    const run = async (): Promise<CloudSyncRunSummary> => {
      const settings = await this.requireSettings(root)
      return await this.exclusive(key, () => this.runOnce(root, settings))
    }
    const running = (this.dependencies.withWindowSync ? this.dependencies.withWindowSync(root, run) : run())
      .then((summary) => ({
        pulled: summary.pulled,
        pushed: summary.pushed,
        conflicts: (summary.pending_conflicts?.length ?? 0) + summary.bootstrap_conflicts.length
      }))
      .finally(() => this.runs.delete(key))
    this.runs.set(key, running)
    return running
  }

  private async runOnce(root: string, settings: VaultSettings): Promise<CloudSyncRunSummary> {
    const coordinator = await this.coordinator(root, settings)
    try {
      const result = await coordinator.sync()
      await this.updateSettings(root, (current) =>
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
      const message = describeS3Error(error, settings.bucket)
      await this.updateSettings(root, (current) => (current ? { ...current, lastError: message } : null))
      throw new Error(message)
    }
  }

  // --- Conflicts ----------------------------------------------------------

  async resolveConflict(root: string, conflictId: unknown, choice: unknown): Promise<void> {
    if (typeof conflictId !== 'string' || !conflictId || conflictId.length > 200) {
      throw new S3SyncInputError('That conflict is not one this vault has.')
    }
    if (choice !== 'local' && choice !== 'remote' && choice !== 'both') {
      throw new S3SyncInputError('Choose this computer’s version, the bucket’s, or both.')
    }
    const settings = await this.requireSettings(root)
    const key = fingerprint(root)
    await this.exclusive(key, async () => {
      const coordinator = await this.coordinator(root, settings)
      try {
        if (conflictId.startsWith('first-sync:')) {
          const itemId = conflictId.slice('first-sync:'.length)
          const conflict = settings.bootstrapConflicts.find((candidate) => candidate.item_id === itemId)
          if (!conflict) throw new S3SyncInputError('That conflict was already settled.')
          await coordinator.resolveBootstrapConflict({
            conflict,
            choice: choice === 'remote' ? 'cloud' : choice,
            ...(choice === 'both' ? { keep_both_path: keepBothPath(conflict.path) } : {})
          })
          await this.updateSettings(root, (current) =>
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
          ...(choice === 'both' ? { keep_both_path: keepBothPath(details.local.path ?? details.conflict.path) } : {})
        })
      } catch (error) {
        if (error instanceof S3SyncInputError) throw error
        throw new Error(describeS3Error(error, settings.bucket))
      }
    })
  }

  private async pendingConflicts(root: string, settings: VaultSettings): Promise<S3SyncConflictSummary[]> {
    const state = await new DesktopCloudSyncStateStore(this.stateDirectory(root)).load(settings.vaultId)
    return Object.values(state?.pending_conflicts ?? {}).map((conflict) => ({
      id: conflict.id,
      path: conflict.local.path ?? conflict.cloud.path ?? conflict.base.path ?? '',
      kind: 'edit' as const
    }))
  }

  // --- Plumbing ----------------------------------------------------------

  private stateDirectory(root: string): string {
    return path.join(this.dependencies.storageDirectory, fingerprint(root), 'state')
  }

  private store(connection: S3SyncConnection): S3ObjectStore {
    if (this.dependencies.createStore) return this.dependencies.createStore(connection)
    return createS3HttpObjectStore({
      bucket: connection.bucket,
      region: connection.region,
      credentials: connection.credentials,
      ...(connection.endpoint ? { endpoint: connection.endpoint } : {}),
      forcePathStyle: connection.forcePathStyle
    })
  }

  private async coordinator(root: string, settings: VaultSettings): Promise<CloudSyncCoordinator> {
    const secretAccessKey = await this.dependencies.secrets.get(fingerprint(root))
    if (!secretAccessKey) {
      throw new S3SyncInputError('The secret access key is missing from this computer. Paste it again in Settings.')
    }
    const store = this.store({
      bucket: settings.bucket,
      region: settings.region,
      endpoint: settings.endpoint,
      forcePathStyle: settings.forcePathStyle,
      credentials: { accessKeyId: settings.accessKeyId, secretAccessKey }
    })
    const remote = createS3SyncRemote({ store, prefix: settings.prefix })
    const name = `S3 (${settings.bucket})`
    return createDesktopCloudSyncCoordinator({
      root,
      stateDirectory: this.stateDirectory(root),
      vaultId: settings.vaultId,
      remote,
      coordinator: { remoteName: name, serviceName: name, pathFits: () => true }
    })
  }

  private async requireSettings(root: string): Promise<VaultSettings> {
    const settings = await this.vaultSettings(root)
    if (!settings) throw new S3SyncInputError('This vault does not sync with S3.')
    return settings
  }

  private async vaultSettings(root: string): Promise<VaultSettings | null> {
    return (await this.readSettings()).vaults[fingerprint(root)] ?? null
  }

  private async readSettings(): Promise<SettingsFile> {
    if (this.settingsCache) return this.settingsCache
    try {
      const parsed = JSON.parse(
        await fs.readFile(path.join(this.dependencies.storageDirectory, 'settings.json'), 'utf8')
      ) as SettingsFile
      if (parsed && parsed.version === 1 && parsed.vaults && typeof parsed.vaults === 'object') {
        this.settingsCache = parsed
        return parsed
      }
    } catch {
      // Missing or damaged: no vault syncs with S3.
    }
    this.settingsCache = { version: 1, vaults: {} }
    return this.settingsCache
  }

  private updateSettings(
    root: string,
    update: (current: VaultSettings | null) => VaultSettings | null
  ): Promise<VaultSettings | null> {
    const key = fingerprint(root)
    const write = this.settingsWrite.catch(() => undefined).then(async () => {
      const settings = await this.readSettings()
      const next = update(settings.vaults[key] ?? null)
      const vaults = { ...settings.vaults }
      if (next) vaults[key] = next
      else delete vaults[key]
      const file: SettingsFile = { version: 1, vaults }
      const target = path.join(this.dependencies.storageDirectory, 'settings.json')
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
      await fs.mkdir(this.dependencies.storageDirectory, { recursive: true })
      await fs.writeFile(temporary, JSON.stringify(file, null, 2), { encoding: 'utf8', mode: 0o600 })
      await fs.rename(temporary, target)
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

interface NormalizedInput {
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

export function normalizeInput(raw: unknown): NormalizedInput {
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
  vaultIdFor(vaultName)
  return {
    bucket,
    region,
    endpoint,
    prefix: normalizePrefix(typeof input.prefix === 'string' ? input.prefix : DEFAULT_PREFIX),
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

export function normalizePrefix(value: string): string {
  const trimmed = value.trim().replace(/^\/+/, '').replace(/\/{2,}/g, '/')
  if (!trimmed) return ''
  if (!/^[A-Za-z0-9!_.*'()\/-]{1,200}$/.test(trimmed) || trimmed.split('/').includes('..')) {
    throw new S3SyncInputError('The folder in the bucket can use letters, numbers and - _ . / only.')
  }
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`
}

/** The vault's folder name in the bucket: the same name on every device. */
export function vaultIdFor(name: string): string {
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
export function keepBothPath(relativePath: string): string {
  const extension = path.posix.extname(relativePath)
  const base = extension ? relativePath.slice(0, -extension.length) : relativePath
  return `${base} (this computer)${extension}`
}

function fingerprint(root: string): string {
  return createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 32)
}

/** Words for the settings page. Never includes keys: S3 errors name only the bucket. */
export function describeS3Error(error: unknown, bucket: string): string {
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

import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { CloudSyncRunSummary } from '@zennotes/bridge-contract/cloud-sync'
import type { S3SyncRunResult, S3SyncStatus } from '@zennotes/bridge-contract/s3-sync'
import type { S3ObjectStore } from '@zennotes/shared-domain/s3-object-store'
import {
  describeS3SyncError,
  normalizeS3Prefix,
  normalizeS3SyncInput,
  s3KeepBothPath,
  S3SyncHostService,
  s3VaultIdFor,
  type S3SyncConnection,
  type S3SyncSecrets,
  type S3SyncSettingsFile,
  type S3SyncVaultRef
} from '@zennotes/shared-domain/s3-sync-host-service'
import { createDesktopCloudSyncCoordinator, DesktopCloudSyncStateStore } from '../cloud-sync-filesystem'

export type { S3SyncConnection, S3SyncSecrets }
export { S3SyncInputError } from '@zennotes/shared-domain/s3-sync-host-service'

/**
 * S3 sync for a local vault: the folder the window already has open syncs
 * straight with a bucket the person owns, through the same engine Cloud and
 * the self-hosted server use. There is no copy folder: the vault is the
 * offline queue, and the engine plans what to send by comparing it with the
 * last state the bucket acknowledged.
 *
 * The rules live in shared-domain's S3SyncHostService, which the phones use
 * too; this file gives it the desktop's storage under userData:
 *
 *   <storage>/settings.json            one entry per vault folder
 *   <storage>/<fingerprint>/state/     the engine's CloudSyncState
 *
 * The secret access key never goes in settings.json: it lives in the system's
 * secure storage, keyed by the vault's fingerprint, and the renderer only
 * hears whether one is saved.
 */

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

export class S3SyncService {
  private readonly host: S3SyncHostService

  constructor(private readonly dependencies: S3SyncServiceDependencies) {
    const storage = dependencies.storageDirectory
    const stateDirectory = (vault: S3SyncVaultRef) => path.join(storage, vault.key, 'state')
    this.host = new S3SyncHostService({
      secrets: dependencies.secrets,
      ...(dependencies.createStore ? { createStore: dependencies.createStore } : {}),
      ...(dependencies.syncsElsewhere
        ? { syncsElsewhere: (vault: S3SyncVaultRef) => dependencies.syncsElsewhere!(vault.root) }
        : {}),
      ...(dependencies.withWindowSync
        ? {
            withRun: (vault: S3SyncVaultRef, run: () => Promise<CloudSyncRunSummary>) =>
              dependencies.withWindowSync!(vault.root, run)
          }
        : {}),
      ...(dependencies.now ? { now: dependencies.now } : {}),
      words: { device: 'computer' },
      persistence: {
        async loadSettings() {
          try {
            return JSON.parse(await fs.readFile(path.join(storage, 'settings.json'), 'utf8')) as unknown
          } catch {
            return null
          }
        },
        async saveSettings(file: S3SyncSettingsFile) {
          const target = path.join(storage, 'settings.json')
          const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
          await fs.mkdir(storage, { recursive: true })
          await fs.writeFile(temporary, JSON.stringify(file, null, 2), { encoding: 'utf8', mode: 0o600 })
          await fs.rename(temporary, target)
        },
        loadState: (vault, vaultId) => new DesktopCloudSyncStateStore(stateDirectory(vault)).load(vaultId),
        async clearState(vault) {
          await fs.rm(path.join(storage, vault.key), { recursive: true, force: true })
        }
      },
      createCoordinator: ({ vault, settings, remote, name }) =>
        createDesktopCloudSyncCoordinator({
          root: vault.root,
          stateDirectory: stateDirectory(vault),
          vaultId: settings.vaultId,
          remote,
          coordinator: { remoteName: name, serviceName: name, pathFits: () => true }
        })
    })
  }

  status(root: string): Promise<S3SyncStatus> {
    return this.host.status(ref(root))
  }

  save(root: string, raw: unknown): Promise<S3SyncRunResult> {
    return this.host.save(ref(root), raw)
  }

  disconnect(root: string): Promise<void> {
    return this.host.disconnect(ref(root))
  }

  isConfigured(root: string): Promise<boolean> {
    return this.host.isConfigured(ref(root))
  }

  sync(root: string): Promise<S3SyncRunResult> {
    return this.host.sync(ref(root))
  }

  resolveConflict(root: string, conflictId: unknown, choice: unknown): Promise<void> {
    return this.host.resolveConflict(ref(root), conflictId, choice)
  }
}

function ref(root: string): S3SyncVaultRef {
  const resolved = path.resolve(root)
  return { key: fingerprint(resolved), root: resolved }
}

function fingerprint(root: string): string {
  return createHash('sha256').update(root).digest('hex').slice(0, 32)
}

export const normalizeInput = normalizeS3SyncInput
export const normalizePrefix = normalizeS3Prefix
export const vaultIdFor = s3VaultIdFor
export const describeS3Error = describeS3SyncError

/** `Inbox/plan.md` becomes `Inbox/plan (this computer).md`. */
export function keepBothPath(relativePath: string): string {
  return s3KeepBothPath(relativePath, 'computer')
}

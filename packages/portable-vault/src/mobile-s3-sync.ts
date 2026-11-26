import type { S3SyncConflictChoice, S3SyncRunResult, S3SyncSettingsInput, S3SyncStatus } from '@zennotes/bridge-contract/s3-sync'
import { CloudSyncCoordinator, type CloudSyncStateStore } from '@zennotes/shared-domain/cloud-sync-coordinator'
import type { CloudSyncState } from '@zennotes/shared-domain/cloud-sync-engine'
import {
  PortableCloudSyncRepository,
  type PortableCloudSyncFileSystem
} from '@zennotes/shared-domain/cloud-sync-portable-filesystem'
import type { S3ObjectStore } from '@zennotes/shared-domain/s3-object-store'
import {
  S3SyncHostService,
  type S3SyncConnection,
  type S3SyncSettingsFile,
  type S3SyncVaultFiles,
  type S3SyncVaultRef
} from '@zennotes/shared-domain/s3-sync-host-service'
import { portableHost } from './host'
import { createHostFetch } from './host-fetch'
import { trackCloudSyncChanges } from './cloud-sync-refresh'
import { getMobileCloudVaultLink } from './mobile-cloud-sync'
import type { PortableVault } from './vault-fs'
import { randomUUID } from './uuid'

/**
 * S3 sync on a phone: the open on-device vault syncs straight with a bucket
 * the person owns, in exactly the format the desktop app writes
 * (shared-domain s3-sync-remote.ts), so a Mac and a phone that name the same
 * bucket, folder and vault share one set of notes.
 *
 * The rules are shared-domain's S3SyncHostService, the same object the desktop
 * app runs. What differs is where things live:
 *
 * - settings: `zennotes-s3-sync/settings.json` in the host's durable storage
 *   (Capacitor's Directory.Data on the phones), no secret in it;
 * - engine state: `zennotes-s3-sync/states/<vault>/<bucket vault>.json`;
 * - the secret access key: the host's SecretStorage (the iOS Keychain,
 *   Android's Keystore), under `s3-sync:<vault>`;
 * - requests: the host's native HTTP, so the bucket needs no CORS rule.
 *
 * Files go through the shared portable repository, which reads each file as
 * base64. The phones' native fast path hands out files above 5 MiB by
 * reference for Cloud's signed uploads, which a bucket of our own does not
 * have, so S3 reads every file's bytes.
 */

const STORAGE_ROOT = 'zennotes-s3-sync'
const SETTINGS_PATH = `${STORAGE_ROOT}/settings.json`
const SECRET_PREFIX = 's3-sync:'

export interface MobileS3SyncOverrides {
  /** Tests pass an in-memory bucket. */
  createStore?(connection: S3SyncConnection): S3ObjectStore
}

let overrides: MobileS3SyncOverrides = {}
let service: S3SyncHostService | null = null
const vaults = new Map<string, PortableVault>()

/** For tests: swap the bucket and start from a fresh service. */
export function configureMobileS3Sync(next: MobileS3SyncOverrides): void {
  overrides = next
  service = null
  vaults.clear()
}

function device(): string {
  return portableHost().shell.deviceWord ?? 'device'
}

function hostService(): S3SyncHostService {
  if (service) return service
  service = new S3SyncHostService({
    words: { device: device() },
    fetchImplementation: createHostFetch(),
    ...(overrides.createStore ? { createStore: overrides.createStore } : {}),
    secrets: {
      async get(id) {
        const secrets = portableHost().secrets
        if (!secrets.available()) return null
        await secrets.prepare?.()
        return secrets.get(SECRET_PREFIX + id)
      },
      async set(id, secret) {
        const secrets = portableHost().secrets
        if (!secrets.available()) return false
        await secrets.prepare?.()
        await secrets.set(SECRET_PREFIX + id, secret)
        return true
      },
      async delete(id) {
        const secrets = portableHost().secrets
        if (!secrets.available()) return
        await secrets.prepare?.()
        await secrets.remove(SECRET_PREFIX + id)
      },
      canStore: () => portableHost().secrets.available()
    },
    persistence: {
      async loadSettings() {
        const raw = await portableHost().storage.read(SETTINGS_PATH)
        return raw === null ? null : (JSON.parse(raw) as unknown)
      },
      async saveSettings(file: S3SyncSettingsFile) {
        await portableHost().storage.write(SETTINGS_PATH, JSON.stringify(file))
      },
      loadState: (vault, vaultId) => stateStore(vault).load(vaultId),
      async clearState(vault, vaultId) {
        // A vault points at one bucket vault at a time (save refuses a change).
        if (vaultId) await portableHost().storage.remove(statePath(vault, vaultId))
      }
    },
    async syncsElsewhere(vault) {
      const local = vaults.get(vault.key)
      if (!local) return null
      const other = await portableHost().vaults.syncsElsewhere?.(local)
      if (other) return other
      if (await getMobileCloudVaultLink(local).catch(() => null)) {
        return 'This vault already syncs with ZenNotes Cloud. Unlink it there before syncing it with S3.'
      }
      return null
    },
    async afterChange(vault) {
      await refreshers.get(vault.key)?.()
    },
    vaultFiles(vault) {
      const local = vaults.get(vault.key)
      if (!local) throw new Error('Open the vault again to sync it with S3.')
      return mobileVaultFiles(local)
    },
    createCoordinator({ vault, settings, remote, name }) {
      const local = vaults.get(vault.key)
      if (!local) throw new Error('Open the vault again to sync it with S3.')
      const changes = trackCloudSyncChanges(syncFileSystem(local), () => local.rescan())
      refreshers.set(vault.key, changes.refresh)
      return new CloudSyncCoordinator(
        settings.vaultId,
        remote,
        new PortableCloudSyncRepository(changes.fs),
        stateStore(vault),
        { itemId: randomUUID, operationId: randomUUID },
        { remoteName: name, serviceName: name, pathFits: () => true }
      )
    }
  })
  return service
}

const refreshers = new Map<string, () => Promise<void>>()

async function vaultRef(vault: PortableVault): Promise<S3SyncVaultRef> {
  const key = await fingerprint(vault.fs.syncKey)
  vaults.set(key, vault)
  return { key, root: vault.fs.syncKey }
}

export async function getMobileS3SyncStatus(vault: PortableVault): Promise<S3SyncStatus> {
  return hostService().status(await vaultRef(vault))
}

export async function saveMobileS3Sync(vault: PortableVault, input: S3SyncSettingsInput): Promise<S3SyncRunResult> {
  return hostService().save(await vaultRef(vault), input)
}

export async function syncMobileS3Vault(vault: PortableVault): Promise<S3SyncRunResult> {
  return hostService().sync(await vaultRef(vault))
}

export async function disconnectMobileS3Sync(vault: PortableVault): Promise<void> {
  await hostService().disconnect(await vaultRef(vault))
}

export async function resolveMobileS3SyncConflict(
  vault: PortableVault,
  conflictId: string,
  choice: S3SyncConflictChoice
): Promise<void> {
  await hostService().resolveConflict(await vaultRef(vault), conflictId, choice)
}

/** Whether this vault syncs with S3: Cloud linking refuses such a vault. */
export async function isMobileS3SyncConfigured(vault: PortableVault): Promise<boolean> {
  return hostService().isConfigured(await vaultRef(vault))
}

/** What S3 sync says when the open vault is not an on-device one. */
export function unavailableMobileS3SyncStatus(reason: string): S3SyncStatus {
  return {
    available: false,
    unavailableReason: reason,
    configured: false,
    bucket: null,
    region: null,
    endpoint: null,
    prefix: null,
    forcePathStyle: false,
    accessKeyId: null,
    vaultName: null,
    hasSecretKey: false,
    canStoreSecurely: portableHost().secrets.available(),
    lastSyncedAt: null,
    lastError: null,
    syncing: false,
    conflicts: [],
    device: device()
  }
}

// --- Plumbing --------------------------------------------------------------

function statePath(vault: S3SyncVaultRef, vaultId: string): string {
  return `${STORAGE_ROOT}/states/${vault.key}/${encodeURIComponent(vaultId)}.json`
}

function stateStore(vault: S3SyncVaultRef): CloudSyncStateStore {
  return {
    async load(vaultId: string): Promise<CloudSyncState | null> {
      // Only a verified absence reads as "no state": HostStorage throws on
      // anything else, so a flaky read never re-runs the first sync and
      // forgets deletions the bucket already acknowledged.
      const raw = await portableHost().storage.read(statePath(vault, vaultId))
      if (raw === null) return null
      return JSON.parse(raw) as CloudSyncState
    },
    async save(state: CloudSyncState): Promise<void> {
      await portableHost().storage.write(statePath(vault, state.vault_id), JSON.stringify(state))
    }
  }
}

/** The vault's files as the shared repository reads them (as Cloud's
 *  browser path does): strict listings, verified absence, base64 bytes. */
function syncFileSystem(vault: PortableVault): PortableCloudSyncFileSystem {
  const files = vault.fs
  const folders = new Set<string>()
  return {
    // Strict on purpose: readdir maps failure to [], which a scan would read
    // as an empty vault and plan a delete for every tracked item.
    readdir: async (directory) =>
      (await files.readdirStrict(directory)).map((entry) => ({
        name: entry.name,
        type: entry.type === 'directory' ? 'directory' : 'file'
      })),
    // Null only for a verified absence: an evicted iCloud file must never
    // read as deleted.
    stat: (path) => files.statVerified(path),
    readBase64: (path) => files.readBase64(path),
    writeText: async (path, value) => {
      await ensureParent(path)
      await files.writeText(path, value)
    },
    writeBase64: async (path, value) => {
      await ensureParent(path)
      await files.writeBase64(path, value)
    },
    deleteFile: (path) => files.deleteFile(path),
    rename: async (from, to) => {
      await ensureParent(to)
      try {
        await files.rename(from, to)
      } catch (error) {
        folders.clear()
        throw error
      }
    }
  }

  async function ensureParent(path: string): Promise<void> {
    // A pulled file or move may land in a folder this phone does not have
    // yet, and Capacitor's rename fails on a missing parent.
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    if (!parent || folders.has(parent)) return
    await files.mkdir(parent)
    folders.add(parent)
  }
}

/** The vault's files, for bringing in the older Zotly app's notes. */
export function mobileVaultFiles(vault: PortableVault): S3SyncVaultFiles {
  const files = vault.fs
  return {
    // Only a verified absence reads as missing, so an unreadable note is
    // never written over.
    exists: async (path) => (await files.statVerified(path)) !== null,
    readText: async (path) => ((await files.statVerified(path)) === null ? null : files.readText(path)),
    writeText: async (path, content) => {
      const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
      if (parent) await files.mkdir(parent)
      await files.writeText(path, content)
    }
  }
}

async function fingerprint(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

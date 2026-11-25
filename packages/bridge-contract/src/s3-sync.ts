/**
 * Sync a local vault with an S3 bucket the person owns (Amazon S3, or an
 * S3-compatible store such as Cloudflare R2 or MinIO). There is no ZenNotes
 * server in between: each device reads and writes the bucket directly, and
 * the shared sync engine keeps them in step (shared-domain s3-sync-remote.ts).
 *
 * The secret access key goes to the host once and stays in the system's
 * secure storage. The renderer hears only whether one is saved.
 */

export interface S3SyncSettingsInput {
  bucket: string
  region: string
  /** Base URL of an S3-compatible service, or null for Amazon S3. */
  endpoint: string | null
  /** Folder inside the bucket, e.g. `zotly/`. Empty for the bucket root. */
  prefix: string
  forcePathStyle: boolean
  accessKeyId: string
  /** A new secret, or null to keep the one already saved. */
  secretAccessKey: string | null
  /** The vault's name in the bucket. Devices that use the same name share it. */
  vaultName: string
}

export type S3SyncConflictKind = 'first-sync' | 'edit'

export interface S3SyncConflictSummary {
  id: string
  path: string
  kind: S3SyncConflictKind
}

/** `remote` takes the bucket's version, `both` keeps this computer's beside it. */
export type S3SyncConflictChoice = 'local' | 'remote' | 'both'

export interface S3SyncStatus {
  /** False when this window cannot use S3 sync, with the reason. */
  available: boolean
  unavailableReason: string | null
  configured: boolean
  bucket: string | null
  region: string | null
  endpoint: string | null
  prefix: string | null
  forcePathStyle: boolean
  accessKeyId: string | null
  vaultName: string | null
  hasSecretKey: boolean
  canStoreSecurely: boolean
  lastSyncedAt: number | null
  lastError: string | null
  syncing: boolean
  conflicts: S3SyncConflictSummary[]
}

export interface S3SyncRunResult {
  pulled: number
  pushed: number
  conflicts: number
}

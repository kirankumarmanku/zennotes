import type {
  CloudSyncChange,
  CloudSyncConflict,
  CloudSyncContent,
  CloudSyncContentEncoding,
  CloudSyncItemKind,
  CloudSyncManifestItem,
  CloudSyncManifestResponse,
  CloudSyncMutation,
  CloudSyncMutationAcknowledgement,
  CloudSyncMutationRequest,
  CloudSyncMutationResponse,
  CloudSyncRevisionResponse
} from '@zennotes/bridge-contract/cloud-sync'
import type { CloudSyncRemote } from './cloud-sync-coordinator'
import { cloudSyncPathKey } from './cloud-sync'
import { S3PreconditionFailedError, sha256Hex, type S3ObjectStore } from './s3-object-store'

/**
 * Cloud's sync engine talking straight to an S3 bucket, with no server in
 * between. The bucket holds an append-only change log; every device replays it
 * and applies the same rules the self-hosted server applies to a mutation
 * (znserver `syncApplyLocked`), so the coordinator, its merges and its
 * conflict screens work unchanged.
 *
 * Layout under `<prefix>vaults/<vaultId>/`:
 *
 * - `vault.json`: the vault's id and format, written once.
 * - `log/<first sequence, 12 digits>.json`: one accepted mutation batch. A
 *   batch is claimed with `If-None-Match: *` on the key right after the last
 *   batch, so two devices can never both append at the same place; the loser
 *   re-reads and re-checks its batch against what won.
 * - `blobs/<sha256>`: file bytes, content-addressed, uploaded before the log
 *   entry that names them, so no reader ever sees a change without its bytes.
 * - `snapshots/<sequence, 12 digits>.json`: the whole item index at a batch
 *   boundary, written every `snapshotEvery` changes so a new device does not
 *   replay the log from the start.
 *
 * Readable vaults only for now: `aes-gcm` content (ZNE1 end-to-end
 * encryption) is refused until the vault cipher is wired in.
 */

const FORMAT = 1
const SEQUENCE_DIGITS = 12
const DEFAULT_CHANGE_LIMIT = 200
const MAX_CHANGE_LIMIT = 1000
const CHANGES_PAGE_BYTES = 8 * 1024 * 1024
const DEFAULT_PER_PAGE = 500
const DEFAULT_SNAPSHOT_EVERY = 200
const DEFAULT_MUTATE_ATTEMPTS = 8
const RETAINED_OPERATIONS = 5000

interface S3SyncItem {
  item_id: string
  path: string
  kind: CloudSyncItemKind
  revision: number
  sha256: string
  byte_length: number
  media_type: string
  encoding: 'utf8' | 'base64'
}

interface S3SyncLogChange extends S3SyncItem {
  sequence: number
  operation_id: string
  type: 'upsert' | 'move' | 'delete'
  previous_path: string | null
}

interface S3SyncLogRecord {
  format: number
  first_sequence: number
  changes: S3SyncLogChange[]
}

interface S3SyncSnapshot {
  format: number
  sequence: number
  items: Record<string, S3SyncItem>
  tombstones: Record<string, number>
  operations: Record<string, CloudSyncMutationAcknowledgement>
}

interface S3SyncState {
  sequence: number
  items: Map<string, S3SyncItem>
  /** Path key -> item id, for PATH_CONFLICT. */
  byPath: Map<string, string>
  tombstones: Map<string, number>
  operations: Map<string, CloudSyncMutationAcknowledgement>
  /** The sequence the replay started from (a snapshot, or 0). */
  floor: number
  lastSnapshot: number
}

export interface S3SyncVaultInfo {
  format: number
  vault_id: string
  created_at: string
  name?: string
}

export interface S3SyncRemoteOptions {
  store: S3ObjectStore
  /** Key prefix inside the bucket, e.g. `zotly/`. Empty for the bucket root. */
  prefix?: string
  snapshotEvery?: number
  mutateAttempts?: number
}

/** A sync error the coordinator reads by status and code, as it reads Cloud's. */
export class S3SyncError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message)
    this.name = 'S3SyncError'
  }
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

function pad(sequence: number): string {
  return String(sequence).padStart(SEQUENCE_DIGITS, '0')
}

function sequenceOfKey(key: string): number {
  const match = key.match(/(\d+)\.json$/)
  return match ? Number(match[1]) : NaN
}

function base64Encode(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

function base64Decode(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function json(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value))
}

function parse<T>(bytes: Uint8Array, key: string): T {
  try {
    return JSON.parse(decoder.decode(bytes)) as T
  } catch {
    throw new S3SyncError(`${key} in the sync bucket is not readable.`, 500, 'SYNC_STORE_CORRUPT')
  }
}

function contentBytes(content: CloudSyncContent): Uint8Array {
  if (content.encoding === 'utf8') return encoder.encode(content.data)
  if (content.encoding === 'base64') return base64Decode(content.data)
  throw new S3SyncError('This S3 vault is not end-to-end encrypted, so it cannot take encrypted content.', 400, 'SYNC_ENCRYPTION_UNSUPPORTED')
}

function contentFromBytes(item: Pick<S3SyncItem, 'encoding' | 'sha256' | 'media_type'>, bytes: Uint8Array): CloudSyncContent {
  return {
    encoding: item.encoding as CloudSyncContentEncoding,
    data: item.encoding === 'utf8' ? new TextDecoder().decode(bytes) : base64Encode(bytes),
    sha256: item.sha256,
    byte_length: bytes.byteLength,
    media_type: item.media_type
  }
}

function emptyState(): S3SyncState {
  return {
    sequence: 0,
    items: new Map(),
    byPath: new Map(),
    tombstones: new Map(),
    operations: new Map(),
    floor: 0,
    lastSnapshot: 0
  }
}

function cloneState(state: S3SyncState): S3SyncState {
  return {
    ...state,
    items: new Map(state.items),
    byPath: new Map(state.byPath),
    tombstones: new Map(state.tombstones),
    operations: new Map(state.operations)
  }
}

/** Fold one accepted change into the index, the same way on every device. */
function applyChange(state: S3SyncState, change: S3SyncLogChange): void {
  const previous = state.items.get(change.item_id)
  if (previous) state.byPath.delete(cloudSyncPathKey(previous.path))
  if (change.type === 'delete') {
    state.items.delete(change.item_id)
    state.tombstones.set(change.item_id, change.revision)
  } else {
    const item: S3SyncItem = {
      item_id: change.item_id,
      path: change.path,
      kind: change.kind,
      revision: change.revision,
      sha256: change.sha256,
      byte_length: change.byte_length,
      media_type: change.media_type,
      encoding: change.encoding
    }
    state.items.set(change.item_id, item)
    state.byPath.set(cloudSyncPathKey(change.path), change.item_id)
    state.tombstones.delete(change.item_id)
  }
  state.operations.set(change.operation_id, {
    operation_id: change.operation_id,
    item_id: change.item_id,
    revision: change.revision,
    sequence: change.sequence
  })
  if (state.operations.size > RETAINED_OPERATIONS) {
    const oldest = state.operations.keys().next().value
    if (oldest !== undefined) state.operations.delete(oldest)
  }
  state.sequence = change.sequence
}

function mediaTypeFor(path: string, fallback: string): string {
  return /\.md$/i.test(path) ? 'text/markdown' : fallback
}

/** Make or read the vault's `vault.json`. Two devices racing get the same vault. */
export async function ensureS3SyncVault(
  store: S3ObjectStore,
  options: { prefix?: string; vaultId: string; name?: string }
): Promise<S3SyncVaultInfo> {
  const key = `${options.prefix ?? ''}vaults/${options.vaultId}/vault.json`
  const existing = await store.get(key)
  if (existing) return parse<S3SyncVaultInfo>(existing.body, key)
  const info: S3SyncVaultInfo = {
    format: FORMAT,
    vault_id: options.vaultId,
    created_at: new Date().toISOString(),
    ...(options.name ? { name: options.name } : {})
  }
  try {
    await store.put(key, json(info), { ifNoneMatch: '*', contentType: 'application/json' })
    return info
  } catch (error) {
    if (!(error instanceof S3PreconditionFailedError)) throw error
    const winner = await store.get(key)
    if (!winner) throw error
    return parse<S3SyncVaultInfo>(winner.body, key)
  }
}

/** Every vault the bucket holds under `prefix`, for a "connect to existing vault" list. */
export async function listS3SyncVaults(store: S3ObjectStore, prefix = ''): Promise<S3SyncVaultInfo[]> {
  const keys = (await store.list(`${prefix}vaults/`)).filter((key) => key.endsWith('/vault.json'))
  const vaults: S3SyncVaultInfo[] = []
  for (const key of keys) {
    const found = await store.get(key)
    if (found) vaults.push(parse<S3SyncVaultInfo>(found.body, key))
  }
  return vaults
}

export type S3SyncRemote = CloudSyncRemote & {
  /** Drop what this remote has cached, as after a long sleep. */
  reset(): void
}

export function createS3SyncRemote(options: S3SyncRemoteOptions): S3SyncRemote {
  const store = options.store
  const prefix = options.prefix ?? ''
  const snapshotEvery = Math.max(1, options.snapshotEvery ?? DEFAULT_SNAPSHOT_EVERY)
  const attempts = Math.max(1, options.mutateAttempts ?? DEFAULT_MUTATE_ATTEMPTS)

  /** Log records are immutable once written, so they are cached by key. */
  const records = new Map<string, S3SyncLogRecord>()
  const states = new Map<string, S3SyncState>()
  /** Log keys known per vault, ascending, from the state's floor on. */
  const logKeys = new Map<string, string[]>()

  const root = (vaultId: string) => `${prefix}vaults/${vaultId}/`
  const logKey = (vaultId: string, sequence: number) => `${root(vaultId)}log/${pad(sequence)}.json`
  const blobKey = (vaultId: string, sha: string) => `${root(vaultId)}blobs/${sha}`

  async function readRecord(key: string): Promise<S3SyncLogRecord> {
    const cached = records.get(key)
    if (cached) return cached
    const found = await store.get(key)
    if (!found) throw new S3SyncError(`${key} is missing from the sync bucket.`, 410, 'CURSOR_EXPIRED')
    const record = parse<S3SyncLogRecord>(found.body, key)
    records.set(key, record)
    return record
  }

  async function loadFresh(vaultId: string): Promise<S3SyncState> {
    const state = emptyState()
    const snapshotKeys = await store.list(`${root(vaultId)}snapshots/`)
    const latest = snapshotKeys.at(-1)
    if (latest) {
      const found = await store.get(latest)
      if (found) {
        const snapshot = parse<S3SyncSnapshot>(found.body, latest)
        state.sequence = snapshot.sequence
        state.floor = snapshot.sequence
        state.lastSnapshot = snapshot.sequence
        for (const item of Object.values(snapshot.items)) {
          state.items.set(item.item_id, item)
          state.byPath.set(cloudSyncPathKey(item.path), item.item_id)
        }
        for (const [id, revision] of Object.entries(snapshot.tombstones)) state.tombstones.set(id, revision)
        for (const [id, ack] of Object.entries(snapshot.operations)) state.operations.set(id, ack)
      }
    }
    logKeys.set(vaultId, [])
    states.set(vaultId, state)
    return state
  }

  /** Bring the cached index up to the newest batch in the bucket. */
  async function refresh(vaultId: string): Promise<S3SyncState> {
    const state = states.get(vaultId) ?? (await loadFresh(vaultId))
    const known = logKeys.get(vaultId) ?? []
    const startAfter = state.sequence > 0 ? logKey(vaultId, state.sequence) : undefined
    const fresh = (await store.list(`${root(vaultId)}log/`, startAfter ? { startAfter } : {})).filter(
      (key) => sequenceOfKey(key) > state.sequence
    )
    for (const key of fresh) {
      const record = await readRecord(key)
      if (record.first_sequence !== state.sequence + 1) {
        throw new S3SyncError(
          `The sync log has a gap after change ${state.sequence}.`,
          500,
          'SYNC_STORE_CORRUPT'
        )
      }
      for (const change of record.changes) applyChange(state, change)
      known.push(key)
    }
    logKeys.set(vaultId, known)
    return state
  }

  /** Every log record holding changes after `after`, oldest first. */
  async function recordsAfter(vaultId: string, after: number): Promise<S3SyncLogRecord[]> {
    const state = await refresh(vaultId)
    if (after > state.sequence) {
      throw new S3SyncError('This device is ahead of the sync bucket.', 410, 'CURSOR_EXPIRED')
    }
    let keys = logKeys.get(vaultId) ?? []
    if (after < state.floor) {
      // Older than the snapshot this device started from: read the log itself.
      keys = (await store.list(`${root(vaultId)}log/`)).filter((key) => sequenceOfKey(key) <= state.sequence)
    }
    const out: S3SyncLogRecord[] = []
    for (const key of keys) {
      const record = await readRecord(key)
      const last = record.first_sequence + record.changes.length - 1
      if (last > after) out.push(record)
    }
    if (out.length && out[0].first_sequence > after + 1) {
      throw new S3SyncError('The sync log no longer holds every change after this cursor.', 410, 'CURSOR_EXPIRED')
    }
    return out
  }

  async function readBlob(vaultId: string, sha: string): Promise<Uint8Array> {
    const key = blobKey(vaultId, sha)
    const found = await store.get(key)
    if (!found) throw new S3SyncError(`The bytes for ${sha} are missing from the sync bucket.`, 500, 'SYNC_STORE_CORRUPT')
    if ((await sha256Hex(found.body)) !== sha) {
      throw new S3SyncError(`The bytes stored for ${sha} do not match their hash.`, 500, 'SYNC_STORE_CORRUPT')
    }
    return found.body
  }

  async function writeSnapshot(vaultId: string, state: S3SyncState): Promise<void> {
    const snapshot: S3SyncSnapshot = {
      format: FORMAT,
      sequence: state.sequence,
      items: Object.fromEntries(state.items),
      tombstones: Object.fromEntries(state.tombstones),
      operations: Object.fromEntries(state.operations)
    }
    try {
      await store.put(`${root(vaultId)}snapshots/${pad(state.sequence)}.json`, json(snapshot), {
        ifNoneMatch: '*',
        contentType: 'application/json'
      })
    } catch (error) {
      if (!(error instanceof S3PreconditionFailedError)) throw error
    }
    state.lastSnapshot = state.sequence
  }

  /** One attempt at a batch against `state`; changes are not yet durable. */
  function plan(state: S3SyncState, mutations: CloudSyncMutation[]) {
    const draft = cloneState(state)
    const acknowledged: CloudSyncMutationAcknowledgement[] = []
    const conflicts: CloudSyncConflict[] = []
    const changes: S3SyncLogChange[] = []
    const uploads = new Map<string, Uint8Array>()

    for (const m of mutations) {
      const prior = draft.operations.get(m.operation_id)
      if (prior) {
        acknowledged.push(prior)
        continue
      }
      const item = draft.items.get(m.item_id)
      const conflict = (code: CloudSyncConflict['code']) => {
        conflicts.push({
          operation_id: m.operation_id,
          item_id: m.item_id,
          code,
          current_revision: item?.revision ?? draft.tombstones.get(m.item_id) ?? null,
          current_path: item?.path ?? null
        })
      }
      if (m.base_revision === null) {
        if (m.type !== 'upsert') throw new S3SyncError(`A ${m.type} needs a base revision.`, 422, 'VALIDATION_FAILED')
        if (item) { conflict('REVISION_CONFLICT'); continue }
        if (draft.tombstones.has(m.item_id)) { conflict('ITEM_DELETED'); continue }
      } else {
        if (!item) { conflict('ITEM_DELETED'); continue }
        if (item.revision !== m.base_revision) { conflict('REVISION_CONFLICT'); continue }
      }
      if (m.type !== 'delete') {
        const holder = draft.byPath.get(cloudSyncPathKey(m.path))
        if (holder !== undefined && holder !== m.item_id) { conflict('PATH_CONFLICT'); continue }
      }

      const sequence = draft.sequence + 1
      let change: S3SyncLogChange
      if (m.type === 'delete') {
        change = { ...item!, sequence, operation_id: m.operation_id, type: 'delete', previous_path: null, revision: item!.revision + 1 }
      } else if (m.type === 'move') {
        change = {
          ...item!,
          sequence,
          operation_id: m.operation_id,
          type: 'move',
          path: m.path,
          previous_path: item!.path,
          revision: item!.revision + 1
        }
      } else {
        const bytes = contentBytes(m.content)
        uploads.set(m.content.sha256, bytes)
        change = {
          item_id: m.item_id,
          sequence,
          operation_id: m.operation_id,
          type: 'upsert',
          path: m.path,
          previous_path: item && item.path !== m.path ? item.path : null,
          revision: item ? item.revision + 1 : 1,
          kind: m.kind,
          sha256: m.content.sha256,
          byte_length: bytes.byteLength,
          media_type: m.content.media_type || mediaTypeFor(m.path, 'application/octet-stream'),
          encoding: m.content.encoding === 'utf8' ? 'utf8' : 'base64'
        }
      }
      applyChange(draft, change)
      changes.push(change)
      acknowledged.push({
        operation_id: m.operation_id,
        item_id: m.item_id,
        revision: change.revision,
        sequence
      })
    }
    return { draft, acknowledged, conflicts, changes, uploads }
  }

  const uploaded = new Set<string>()

  async function upload(vaultId: string, uploads: Map<string, Uint8Array>): Promise<void> {
    for (const [sha, bytes] of uploads) {
      const key = blobKey(vaultId, sha)
      if (uploaded.has(key)) continue
      if ((await sha256Hex(bytes)) !== sha) {
        throw new S3SyncError(`A file's bytes do not match the hash sent with them (${sha}).`, 422, 'VALIDATION_FAILED')
      }
      try {
        await store.put(key, bytes, { ifNoneMatch: '*', contentType: 'application/octet-stream' })
      } catch (error) {
        // Already there: the same bytes, since the key is their hash.
        if (!(error instanceof S3PreconditionFailedError)) throw error
      }
      uploaded.add(key)
    }
  }

  async function contentOf(vaultId: string, item: S3SyncItem): Promise<CloudSyncContent> {
    return contentFromBytes(item, await readBlob(vaultId, item.sha256))
  }

  function manifestItem(item: S3SyncItem): CloudSyncManifestItem {
    return {
      item_id: item.item_id,
      path: item.path,
      kind: item.kind,
      revision: item.revision,
      sha256: item.sha256,
      byte_length: item.byte_length,
      media_type: item.media_type
    }
  }

  return {
    reset() {
      states.clear()
      logKeys.clear()
      uploaded.clear()
    },

    async manifest(vaultId, manifestOptions = {}): Promise<CloudSyncManifestResponse> {
      const state = await refresh(vaultId)
      const perPage = Math.max(1, manifestOptions.perPage ?? DEFAULT_PER_PAGE)
      const page = Math.max(1, manifestOptions.page ?? 1)
      const all = [...state.items.values()].sort((a, b) =>
        cloudSyncPathKey(a.path) < cloudSyncPathKey(b.path) ? -1 : 1
      )
      const slice = all.slice((page - 1) * perPage, page * perPage)
      const data: CloudSyncManifestItem[] = []
      for (const item of slice) {
        const entry = manifestItem(item)
        if (manifestOptions.includeContent) entry.content = await contentOf(vaultId, item)
        data.push(entry)
      }
      return {
        data,
        cursor: state.sequence,
        next_page: page * perPage < all.length ? page + 1 : null
      }
    },

    async changes(vaultId, after, limit = DEFAULT_CHANGE_LIMIT) {
      const max = Math.min(Math.max(1, limit), MAX_CHANGE_LIMIT)
      const out: CloudSyncChange[] = []
      let cursor = after
      let budget = 0
      let more = false
      outer: for (const record of await recordsAfter(vaultId, after)) {
        for (const change of record.changes) {
          if (change.sequence <= after) continue
          if (out.length >= max) { more = true; break outer }
          const entry: CloudSyncChange = {
            sequence: change.sequence,
            item_id: change.item_id,
            type: change.type,
            path: change.path,
            previous_path: change.previous_path,
            revision: change.revision
          }
          if (change.type === 'upsert') {
            const content = contentFromBytes(change, await readBlob(vaultId, change.sha256))
            if (out.length > 0 && budget + content.byte_length > CHANGES_PAGE_BYTES) { more = true; break outer }
            budget += content.byte_length
            entry.content = content
          }
          out.push(entry)
          cursor = change.sequence
        }
      }
      return { data: out, cursor, has_more: more }
    },

    async mutate(vaultId, body: CloudSyncMutationRequest): Promise<CloudSyncMutationResponse> {
      for (let attempt = 0; attempt < attempts; attempt++) {
        const state = await refresh(vaultId)
        const { draft, acknowledged, conflicts, changes, uploads } = plan(state, body.mutations)
        if (changes.length === 0) return { acknowledged, conflicts, cursor: state.sequence }
        await upload(vaultId, uploads)
        const record: S3SyncLogRecord = { format: FORMAT, first_sequence: changes[0].sequence, changes }
        const key = logKey(vaultId, record.first_sequence)
        try {
          await store.put(key, json(record), { ifNoneMatch: '*', contentType: 'application/json' })
        } catch (error) {
          if (error instanceof S3PreconditionFailedError) continue
          throw error
        }
        records.set(key, record)
        logKeys.get(vaultId)?.push(key)
        // The batch is durable: adopt the draft as this device's index.
        draft.floor = state.floor
        states.set(vaultId, draft)
        if (draft.sequence - draft.lastSnapshot >= snapshotEvery) await writeSnapshot(vaultId, draft)
        return { acknowledged, conflicts, cursor: draft.sequence }
      }
      throw new S3SyncError(
        'Other devices kept writing to the sync bucket at the same moment. Sync will try again.',
        503,
        'SYNC_BUSY'
      )
    },

    async revision(vaultId, itemId, revision): Promise<CloudSyncRevisionResponse> {
      const state = await refresh(vaultId)
      const current = state.items.get(itemId)
      if (current && current.revision === revision) {
        return {
          data: {
            item_id: itemId,
            revision,
            path: current.path,
            kind: current.kind,
            deleted: false,
            content: await contentOf(vaultId, current)
          }
        }
      }
      for (const record of await recordsAfter(vaultId, 0)) {
        for (const change of record.changes) {
          if (change.item_id !== itemId || change.revision !== revision) continue
          const deleted = change.type === 'delete'
          return {
            data: {
              item_id: itemId,
              revision,
              path: change.path,
              kind: change.kind,
              deleted,
              content: deleted ? null : contentFromBytes(change, await readBlob(vaultId, change.sha256))
            }
          }
        }
      }
      throw new S3SyncError(`Revision ${revision} of this file is not in the sync bucket.`, 404, 'REVISION_NOT_RETAINED')
    }
  }
}

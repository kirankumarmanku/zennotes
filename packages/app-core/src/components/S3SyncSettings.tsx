import { useCallback, useEffect, useState } from 'react'
import type {
  S3SyncConflictChoice,
  S3SyncSettingsInput,
  S3SyncStatus
} from '@zennotes/bridge-contract/s3-sync'
import { Button } from './ui/Button'

/** Whether this host can sync a vault with S3 (the desktop app). */
export function s3SyncSupported(): boolean {
  return typeof window.zen?.s3SyncStatus === 'function'
}

type Tone = 'ok' | 'error'
interface Message {
  tone: Tone
  text: string
}

const FIELD =
  'w-full min-w-0 rounded-xl border border-paper-300/70 bg-paper-100/80 px-3 py-2 text-sm text-ink-900 outline-none placeholder:text-ink-400 focus:border-accent/45'

function blankDraft(status: S3SyncStatus | null, vaultName: string): S3SyncSettingsInput {
  return {
    bucket: status?.bucket ?? '',
    region: status?.region ?? 'us-east-1',
    endpoint: status?.endpoint ?? null,
    prefix: status?.prefix ?? 'zotly/',
    forcePathStyle: status?.forcePathStyle ?? false,
    accessKeyId: status?.accessKeyId ?? '',
    secretAccessKey: null,
    vaultName: status?.vaultName ?? vaultName
  }
}

function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  // Electron prefixes rejected invoke errors with the channel.
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

function summary(result: { pulled: number; pushed: number; conflicts: number }): string {
  const parts = [`Sent ${result.pushed}`, `received ${result.pulled}`]
  const conflicts = result.conflicts
    ? ` ${result.conflicts === 1 ? '1 note needs' : `${result.conflicts} notes need`} you to pick a version below.`
    : ''
  return `Synced. ${parts.join(', ')}.${conflicts}`
}

/**
 * Settings → S3 sync. The open vault syncs straight with a bucket the person
 * owns: Amazon S3, Cloudflare R2, MinIO or anything else that speaks S3 with
 * conditional writes. The secret key field is write-only: the host keeps it
 * in system storage and this page hears only whether one is saved.
 */
export function S3SyncSettings({ localVaultName }: { localVaultName: string }): JSX.Element {
  const [status, setStatus] = useState<S3SyncStatus | null>(null)
  const [draft, setDraft] = useState<S3SyncSettingsInput>(() => blankDraft(null, localVaultName))
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<Message | null>(null)

  const refresh = useCallback(async (resetDraft: boolean) => {
    const get = window.zen?.s3SyncStatus
    if (!get) return
    const next = await get()
    setStatus(next)
    if (resetDraft) setDraft(blankDraft(next, localVaultName))
  }, [localVaultName])

  useEffect(() => {
    void refresh(true)
  }, [refresh])

  const run = async (label: string, task: () => Promise<Message>): Promise<void> => {
    if (busy) return
    setBusy(label)
    try {
      setMessage(await task())
    } catch (error) {
      setMessage({ tone: 'error', text: errorText(error) })
    } finally {
      await refresh(false).catch(() => undefined)
      setBusy(null)
    }
  }

  const save = (): void => {
    const call = window.zen?.s3SyncSave
    if (!call) return
    void run('Checking the bucket and syncing…', async () => {
      const result = await call({ ...draft, secretAccessKey: secret.trim() || null })
      setSecret('')
      return { tone: 'ok', text: summary(result) }
    })
  }

  const syncNow = (): void => {
    const call = window.zen?.s3SyncNow
    if (call) void run('Syncing…', async () => ({ tone: 'ok', text: summary(await call()) }))
  }

  const disconnect = (): void => {
    const call = window.zen?.s3SyncDisconnect
    if (!call) return
    void run('Disconnecting…', async () => {
      await call()
      setDraft(blankDraft(null, localVaultName))
      return { tone: 'ok', text: 'Disconnected. Your notes here and the copy in the bucket both stay as they are.' }
    })
  }

  const resolve = (conflictId: string, choice: S3SyncConflictChoice): void => {
    const call = window.zen?.s3SyncResolveConflict
    if (!call) return
    void run('Saving your choice…', async () => {
      await call(conflictId, choice)
      return { tone: 'ok', text: 'Done. The next sync sends your choice to the bucket.' }
    })
  }

  if (status && !status.available) {
    return (
      <div className="px-5 py-4 text-sm text-ink-600" data-settings-search-id="s3-sync">
        {status.unavailableReason}
      </div>
    )
  }

  const set = <K extends keyof S3SyncSettingsInput>(key: K, value: S3SyncSettingsInput[K]): void =>
    setDraft((current) => ({ ...current, [key]: value }))
  const canSave = !!draft.bucket.trim() && !!draft.accessKeyId.trim() && !!draft.vaultName.trim() &&
    (status?.hasSecretKey || !!secret.trim())
  const device = status?.device ?? 'computer'
  const lastSynced = status?.lastSyncedAt ? new Date(status.lastSyncedAt).toLocaleString() : null

  return (
    <div data-settings-search-id="s3-sync" aria-busy={busy !== null} className="space-y-4 px-5 py-4">
      <div className="text-xs leading-5 text-ink-500">
        Sync this vault with a bucket you own on Amazon S3, Cloudflare R2, MinIO or another S3-compatible store.
        Each {device === 'computer' ? 'computer' : 'device'} reads and writes the bucket directly. Use keys that can only read and write this bucket’s
        folder: the S3 sync guide in the docs has a policy you can copy. The secret key stays in{' '}
        {status?.canStoreSecurely === false ? `nowhere safe on this ${device} yet` : `this ${device}’s secure storage`}.
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs text-ink-600">
          <span>Bucket</span>
          <input className={FIELD} value={draft.bucket} placeholder="my-notes-bucket" spellCheck={false}
            onChange={(e) => set('bucket', e.target.value)} />
        </label>
        <label className="space-y-1 text-xs text-ink-600">
          <span>Region</span>
          <input className={FIELD} value={draft.region} placeholder="us-east-1" spellCheck={false}
            onChange={(e) => set('region', e.target.value)} />
        </label>
        <label className="space-y-1 text-xs text-ink-600">
          <span>Folder in the bucket</span>
          <input className={FIELD} value={draft.prefix} placeholder="zotly/" spellCheck={false}
            onChange={(e) => set('prefix', e.target.value)} />
        </label>
        <label className="space-y-1 text-xs text-ink-600">
          <span>Vault name in the bucket</span>
          <input className={FIELD} value={draft.vaultName} placeholder="Notes" spellCheck={false}
            disabled={status?.configured}
            onChange={(e) => set('vaultName', e.target.value)} />
        </label>
        <label className="space-y-1 text-xs text-ink-600 sm:col-span-2">
          <span>Endpoint (leave empty for Amazon S3)</span>
          <input className={FIELD} value={draft.endpoint ?? ''} spellCheck={false}
            placeholder="https://<account>.r2.cloudflarestorage.com"
            onChange={(e) => set('endpoint', e.target.value.trim() ? e.target.value : null)} />
        </label>
        <label className="space-y-1 text-xs text-ink-600">
          <span>Access key ID</span>
          <input className={FIELD} value={draft.accessKeyId} spellCheck={false} autoComplete="off"
            data-1p-ignore="" data-lpignore="true"
            onChange={(e) => set('accessKeyId', e.target.value)} />
        </label>
        <label className="space-y-1 text-xs text-ink-600">
          <span>Secret access key</span>
          <input className={FIELD} type="password" value={secret} spellCheck={false} autoComplete="off"
            data-1p-ignore="" data-lpignore="true"
            placeholder={status?.hasSecretKey ? 'Saved. Paste a new one to replace it' : 'Paste the secret'}
            onChange={(e) => setSecret(e.target.value)} />
        </label>
      </div>
      <label className="flex items-center gap-2 text-xs text-ink-600">
        <input type="checkbox" checked={draft.forcePathStyle || !!draft.endpoint}
          disabled={!!draft.endpoint}
          onChange={(e) => set('forcePathStyle', e.target.checked)} />
        Put the bucket in the path (custom endpoints always do)
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={!canSave} onClick={save}>
          {status?.configured ? 'Save and sync' : 'Connect and sync'}
        </Button>
        <Button disabled={!status?.configured} onClick={syncNow}>
          Sync now
        </Button>
        <Button variant="ghost" disabled={!status?.configured} onClick={disconnect}>
          Disconnect
        </Button>
      </div>

      <div role="status" aria-live="polite"
        className={`text-xs leading-5 ${message?.tone === 'error' ? 'text-[color:rgb(var(--z-red))]' : 'text-ink-700'}`}>
        {busy ??
          message?.text ??
          (status?.lastError
            ? status.lastError
            : status?.configured
              ? lastSynced ? `Last synced ${lastSynced}.` : 'Connected. Not synced yet.'
              : 'Not connected.')}
      </div>

      {status && status.conflicts.length > 0 && (
        <div className="space-y-2">
          <div className="text-sm font-medium text-ink-900">Notes changed in two places</div>
          <div className="text-xs leading-5 text-ink-500">
            Your version here is untouched until you pick. Keep both saves this {device}’s version beside the
            other as “(this {device})”.
          </div>
          {status.conflicts.map((conflict) => (
            <div key={conflict.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-paper-300/70 px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-sm text-ink-800" title={conflict.path}>{conflict.path}</span>
              <Button size="sm" onClick={() => resolve(conflict.id, 'local')}>Keep this {device}’s</Button>
              <Button size="sm" onClick={() => resolve(conflict.id, 'remote')}>Use the bucket’s</Button>
              <Button size="sm" variant="ghost" onClick={() => resolve(conflict.id, 'both')}>Keep both</Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

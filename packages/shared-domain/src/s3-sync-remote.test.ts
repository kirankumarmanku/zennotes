import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type {
  CloudSyncChange,
  CloudSyncContent,
  CloudSyncMutation
} from '@zennotes/bridge-contract/cloud-sync'
import {
  CloudSyncCoordinator,
  type CloudSyncRepository,
  type CloudSyncStateStore
} from './cloud-sync-coordinator'
import type { CloudSyncIdSource, CloudSyncLocalItem, CloudSyncState, CloudSyncTrackedItem } from './cloud-sync-engine'
import {
  createMemoryS3ObjectStore,
  createS3HttpObjectStore,
  S3PreconditionFailedError,
  signSigV4,
  type S3ObjectStore
} from './s3-object-store'
import { createS3SyncRemote, ensureS3SyncVault, listS3SyncVaults } from './s3-sync-remote'

const VAULT = 'vault-1'

function text(data: string): CloudSyncContent {
  return {
    encoding: 'utf8',
    data,
    sha256: createHash('sha256').update(data, 'utf8').digest('hex'),
    byte_length: Buffer.byteLength(data),
    media_type: 'text/markdown'
  }
}

let op = 0
function upsert(itemId: string, path: string, body: string, base: number | null): CloudSyncMutation {
  return { type: 'upsert', operation_id: `op-${++op}`, item_id: itemId, base_revision: base, path, kind: 'text', content: text(body) }
}

describe('SigV4 signing', () => {
  it('matches the GET object example in the Amazon S3 documentation', async () => {
    const authorization = await signSigV4(
      {
        method: 'GET',
        path: '/test.txt',
        headers: {
          host: 'examplebucket.s3.amazonaws.com',
          range: 'bytes=0-9',
          'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          'x-amz-date': '20130524T000000Z'
        },
        payloadSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
      },
      { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
      'us-east-1',
      's3',
      '20130524T000000Z'
    )
    expect(authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41'
    )
  })

  it('sends conditional puts and reads a 412 as a lost race', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = []
    const store = createS3HttpObjectStore({
      bucket: 'notes',
      region: 'us-east-1',
      credentials: { accessKeyId: 'AKID', secretAccessKey: 'secret', sessionToken: 'token' },
      now: () => new Date('2026-11-25T00:00:00Z'),
      fetchImplementation: (async (url: string, init: RequestInit) => {
        seen.push({ url, headers: init.headers as Record<string, string> })
        return new Response('<Error><Code>PreconditionFailed</Code></Error>', { status: 412 })
      }) as unknown as typeof fetch
    })
    await expect(store.put('vaults/a b/log/1.json', new Uint8Array([1]), { ifNoneMatch: '*' })).rejects.toThrow(
      'written by someone else first'
    )
    expect(seen[0].url).toBe('https://notes.s3.us-east-1.amazonaws.com/vaults/a%20b/log/1.json')
    expect(seen[0].headers['if-none-match']).toBe('*')
    expect(seen[0].headers['x-amz-security-token']).toBe('token')
    expect(seen[0].headers.authorization).toMatch(/SignedHeaders=host;if-none-match;x-amz-content-sha256;x-amz-date;x-amz-security-token/)
  })

  it('pages ListObjectsV2 and unescapes keys', async () => {
    const pages = [
      '<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>t2</NextContinuationToken><Contents><Key>p/a&amp;b</Key></Contents></ListBucketResult>',
      '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>p/c</Key></Contents></ListBucketResult>'
    ]
    const urls: string[] = []
    const store = createS3HttpObjectStore({
      bucket: 'notes',
      region: 'us-west-2',
      endpoint: 'http://127.0.0.1:9000',
      credentials: { accessKeyId: 'AKID', secretAccessKey: 'secret' },
      fetchImplementation: (async (url: string) => {
        urls.push(url)
        return new Response(pages.shift(), { status: 200 })
      }) as unknown as typeof fetch
    })
    expect(await store.list('p/', { startAfter: 'p/0' })).toEqual(['p/a&b', 'p/c'])
    expect(urls[0]).toBe('http://127.0.0.1:9000/notes?list-type=2&prefix=p%2F&start-after=p%2F0')
    expect(urls[1]).toBe('http://127.0.0.1:9000/notes?list-type=2&prefix=p%2F&continuation-token=t2')
  })
})

describe('S3 sync remote', () => {
  it('creates, edits, moves and deletes a note, and serves the changes in order', async () => {
    const remote = createS3SyncRemote({ store: createMemoryS3ObjectStore() })
    const created = await remote.mutate(VAULT, { mutations: [upsert('n1', 'Inbox/a.md', 'one', null)] })
    expect(created.acknowledged).toMatchObject([{ item_id: 'n1', revision: 1, sequence: 1 }])
    const edited = await remote.mutate(VAULT, { mutations: [upsert('n1', 'Inbox/a.md', 'two', 1)] })
    expect(edited.acknowledged[0].revision).toBe(2)
    await remote.mutate(VAULT, {
      mutations: [{ type: 'move', operation_id: `op-${++op}`, item_id: 'n1', base_revision: 2, path: 'Done/a.md' }]
    })
    const deleted = await remote.mutate(VAULT, {
      mutations: [{ type: 'delete', operation_id: `op-${++op}`, item_id: 'n1', base_revision: 3 }]
    })
    expect(deleted.cursor).toBe(4)

    const changes = await remote.changes(VAULT, 0)
    expect(changes.data.map((c) => [c.type, c.path, c.previous_path, c.revision])).toEqual([
      ['upsert', 'Inbox/a.md', null, 1],
      ['upsert', 'Inbox/a.md', null, 2],
      ['move', 'Done/a.md', 'Inbox/a.md', 3],
      ['delete', 'Done/a.md', null, 4]
    ])
    expect(changes.data[1].content?.data).toBe('two')
    expect(changes.has_more).toBe(false)
    expect((await remote.manifest(VAULT, {})).data).toEqual([])
  })

  it('answers the same conflicts the self-hosted server does', async () => {
    const remote = createS3SyncRemote({ store: createMemoryS3ObjectStore() })
    await remote.mutate(VAULT, { mutations: [upsert('n1', 'a.md', 'one', null), upsert('n2', 'b.md', 'b', null)] })
    const result = await remote.mutate(VAULT, {
      mutations: [
        upsert('n1', 'a.md', 'stale', 0),
        upsert('n3', 'A.md', 'same name, other case', null),
        upsert('n1', 'a.md', 'new', null),
        upsert('gone', 'x.md', 'x', 4)
      ]
    })
    expect(result.acknowledged).toEqual([])
    expect(result.conflicts.map((c) => [c.item_id, c.code, c.current_revision, c.current_path])).toEqual([
      ['n1', 'REVISION_CONFLICT', 1, 'a.md'],
      ['n3', 'PATH_CONFLICT', null, null],
      ['n1', 'REVISION_CONFLICT', 1, 'a.md'],
      ['gone', 'ITEM_DELETED', null, null]
    ])
    await remote.mutate(VAULT, {
      mutations: [{ type: 'delete', operation_id: `op-${++op}`, item_id: 'n2', base_revision: 1 }]
    })
    const recreate = await remote.mutate(VAULT, { mutations: [upsert('n2', 'b.md', 'again', null)] })
    expect(recreate.conflicts).toMatchObject([{ code: 'ITEM_DELETED', current_revision: 2 }])
  })

  it('answers a retried operation with its first acknowledgement', async () => {
    const store = createMemoryS3ObjectStore()
    const mutation = upsert('n1', 'a.md', 'one', null)
    const first = await createS3SyncRemote({ store }).mutate(VAULT, { mutations: [mutation] })
    // Another process (the same device after a restart) sends it again.
    const again = await createS3SyncRemote({ store }).mutate(VAULT, { mutations: [mutation] })
    expect(again.acknowledged).toEqual(first.acknowledged)
    expect(again.cursor).toBe(1)
  })

  it('lets two devices append at once without losing either batch', async () => {
    const store = createMemoryS3ObjectStore()
    const a = createS3SyncRemote({ store })
    const b = createS3SyncRemote({ store })
    await a.manifest(VAULT, {})
    await b.manifest(VAULT, {})
    const [ra, rb] = await Promise.all([
      a.mutate(VAULT, { mutations: [upsert('na', 'from-a.md', 'a', null)] }),
      b.mutate(VAULT, { mutations: [upsert('nb', 'from-b.md', 'b', null)] })
    ])
    expect([ra.acknowledged[0].sequence, rb.acknowledged[0].sequence].sort()).toEqual([1, 2])
    expect((await a.manifest(VAULT, {})).data.map((item) => item.path)).toEqual(['from-a.md', 'from-b.md'])
  })

  it('re-checks a batch that lost the race, so a concurrent edit becomes a conflict', async () => {
    const store = createMemoryS3ObjectStore()
    const seed = createS3SyncRemote({ store })
    await seed.mutate(VAULT, { mutations: [upsert('n1', 'a.md', 'base', null)] })
    const a = createS3SyncRemote({ store })
    const b = createS3SyncRemote({ store })
    await a.manifest(VAULT, {})
    await b.manifest(VAULT, {})
    const [ra, rb] = await Promise.all([
      a.mutate(VAULT, { mutations: [upsert('n1', 'a.md', 'edit from a', 1)] }),
      b.mutate(VAULT, { mutations: [upsert('n1', 'a.md', 'edit from b', 1)] })
    ])
    const outcomes = [ra, rb].map((r) => (r.acknowledged.length ? 'ack' : r.conflicts[0].code)).sort()
    expect(outcomes).toEqual(['REVISION_CONFLICT', 'ack'])
  })

  it('gives up with a retryable error when it keeps losing the race', async () => {
    const inner = createMemoryS3ObjectStore()
    const store: S3ObjectStore = {
      ...inner,
      async put(key, body, options) {
        if (key.includes('/log/')) throw new S3PreconditionFailedError(key)
        return inner.put(key, body, options)
      }
    }
    const remote = createS3SyncRemote({ store, mutateAttempts: 3 })
    await expect(remote.mutate(VAULT, { mutations: [upsert('n1', 'a.md', 'x', null)] })).rejects.toThrow(
      'Sync will try again'
    )
  })

  it('starts a new device from a snapshot and still serves older revisions', async () => {
    const store = createMemoryS3ObjectStore()
    const writer = createS3SyncRemote({ store, snapshotEvery: 2 })
    await writer.mutate(VAULT, { mutations: [upsert('n1', 'a.md', 'v1', null)] })
    await writer.mutate(VAULT, { mutations: [upsert('n1', 'a.md', 'v2', 1)] })
    await writer.mutate(VAULT, { mutations: [upsert('n1', 'a.md', 'v3', 2)] })
    expect([...store.objects.keys()].filter((k) => k.includes('/snapshots/'))).toHaveLength(1)

    const reader = createS3SyncRemote({ store })
    const manifest = await reader.manifest(VAULT, { includeContent: true })
    expect(manifest.cursor).toBe(3)
    expect(manifest.data[0].content?.data).toBe('v3')
    expect((await reader.changes(VAULT, 0)).data.map((c) => c.content?.data)).toEqual(['v1', 'v2', 'v3'])
    expect((await reader.revision!(VAULT, 'n1', 1)).data.content?.data).toBe('v1')
    expect((await reader.revision!(VAULT, 'n1', 3)).data.content?.data).toBe('v3')
  })

  it('pages changes and the manifest', async () => {
    const remote = createS3SyncRemote({ store: createMemoryS3ObjectStore() })
    await remote.mutate(VAULT, {
      mutations: ['c', 'a', 'b'].map((name, i) => upsert(`n${i}`, `${name}.md`, name, null))
    })
    const first = await remote.changes(VAULT, 0, 2)
    expect(first.data.map((c) => c.sequence)).toEqual([1, 2])
    expect(first.has_more).toBe(true)
    const rest = await remote.changes(VAULT, first.cursor, 2)
    expect(rest.data.map((c) => c.sequence)).toEqual([3])
    expect(rest.has_more).toBe(false)
    const page1 = await remote.manifest(VAULT, { perPage: 2 })
    expect(page1.data.map((i) => i.path)).toEqual(['a.md', 'b.md'])
    expect(page1.next_page).toBe(2)
    expect((await remote.manifest(VAULT, { perPage: 2, page: 2 })).data.map((i) => i.path)).toEqual(['c.md'])
  })

  it('keeps binary files byte for byte', async () => {
    const remote = createS3SyncRemote({ store: createMemoryS3ObjectStore() })
    const bytes = Buffer.from([0, 255, 1, 254, 128])
    await remote.mutate(VAULT, {
      mutations: [
        {
          type: 'upsert',
          operation_id: `op-${++op}`,
          item_id: 'img',
          base_revision: null,
          path: 'assets/x.png',
          kind: 'binary',
          content: {
            encoding: 'base64',
            data: bytes.toString('base64'),
            sha256: createHash('sha256').update(bytes).digest('hex'),
            byte_length: bytes.length,
            media_type: 'image/png'
          }
        }
      ]
    })
    const own = (await remote.changes(VAULT, 0)).data[0]
    expect(own.content?.encoding).toBe('base64')
    expect(Buffer.from(own.content!.data, 'base64').equals(bytes)).toBe(true)
  })

  it('refuses bytes that do not match their hash', async () => {
    const remote = createS3SyncRemote({ store: createMemoryS3ObjectStore() })
    const bad = upsert('n1', 'a.md', 'one', null) as Extract<CloudSyncMutation, { type: 'upsert' }>
    bad.content = { ...bad.content, sha256: '0'.repeat(64) }
    await expect(remote.mutate(VAULT, { mutations: [bad] })).rejects.toThrow('do not match the hash')
  })

  it('makes one vault record when two devices set up the same vault', async () => {
    const store = createMemoryS3ObjectStore()
    const [a, b] = await Promise.all([
      ensureS3SyncVault(store, { prefix: 'zotly/', vaultId: VAULT, name: 'Notes' }),
      ensureS3SyncVault(store, { prefix: 'zotly/', vaultId: VAULT, name: 'Notes' })
    ])
    expect(a.created_at).toBe(b.created_at)
    expect((await listS3SyncVaults(store, 'zotly/')).map((v) => v.vault_id)).toEqual([VAULT])
  })
})

// Two devices running the real sync engine against one bucket.

function stateStore(): CloudSyncStateStore {
  let current: CloudSyncState | null = null
  return {
    async load() {
      return current ? structuredClone(current) : null
    },
    async save(state) {
      current = structuredClone(state)
    }
  }
}

function deviceIds(device: string): CloudSyncIdSource {
  let n = 0
  return { itemId: () => `${device}-item-${++n}`, operationId: () => `${device}-op-${++n}` }
}

function folder(): CloudSyncRepository & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    async scan(): Promise<CloudSyncLocalItem[]> {
      return [...files].map(([path, body]) => ({ path, kind: 'text', content: text(body) }))
    },
    async apply(change: CloudSyncChange, previous: CloudSyncTrackedItem | undefined) {
      const local = previous ? files.get(previous.path) : files.get(change.path)
      if (previous && local !== undefined && text(local).sha256 !== previous.sha256 && change.type !== 'move') {
        const copy = change.path.replace(/\.md$/, ' (conflict).md')
        if (change.content) files.set(copy, change.content.data)
        return { code: 'LOCAL_EDIT_CONFLICT', path: change.path, conflict_copy_path: copy }
      }
      if (change.type === 'delete') files.delete(previous?.path ?? change.path)
      else if (change.type === 'move') {
        const body = files.get(previous?.path ?? '')
        if (previous) files.delete(previous.path)
        if (body !== undefined) files.set(change.path, body)
      } else if (change.content) {
        if (previous && previous.path !== change.path) files.delete(previous.path)
        files.set(change.path, change.content.data)
      }
    }
  }
}

function device(store: S3ObjectStore, name: string) {
  const files = folder()
  const coordinator = new CloudSyncCoordinator(VAULT, createS3SyncRemote({ store, prefix: 'zotly/' }), files, stateStore(), deviceIds(name), {
    remoteName: 'S3',
    serviceName: 'your S3 bucket',
    pathFits: () => true
  })
  return { files: files.files, sync: () => coordinator.sync() }
}

describe('S3 sync with the sync engine', () => {
  it('carries notes, edits, renames and deletes between two devices', async () => {
    const store = createMemoryS3ObjectStore()
    const laptop = device(store, 'laptop')
    const phone = device(store, 'phone')

    laptop.files.set('Meetings/standup.md', '# Standup\n')
    await laptop.sync()
    await phone.sync()
    expect(phone.files.get('Meetings/standup.md')).toBe('# Standup\n')

    phone.files.set('Meetings/standup.md', '# Standup\n\n- shipped S3 sync\n')
    await phone.sync()
    await laptop.sync()
    expect(laptop.files.get('Meetings/standup.md')).toBe('# Standup\n\n- shipped S3 sync\n')

    const body = laptop.files.get('Meetings/standup.md')!
    laptop.files.delete('Meetings/standup.md')
    laptop.files.set('Archive/standup.md', body)
    await laptop.sync()
    await phone.sync()
    expect([...phone.files.keys()]).toEqual(['Archive/standup.md'])

    phone.files.delete('Archive/standup.md')
    await phone.sync()
    await laptop.sync()
    expect([...laptop.files.keys()]).toEqual([])
  })

  it('reports a conflict instead of losing an edit when both devices change one note', async () => {
    const store = createMemoryS3ObjectStore()
    const laptop = device(store, 'laptop')
    const phone = device(store, 'phone')
    laptop.files.set('todo.md', 'base\n')
    await laptop.sync()
    await phone.sync()

    laptop.files.set('todo.md', 'base\nlaptop line\n')
    phone.files.set('todo.md', 'base\nphone line\n')
    await laptop.sync()
    const result = await phone.sync()

    const seen = [...phone.files.values()].join('\n')
    expect(seen).toContain('laptop line')
    expect(seen).toContain('phone line')
    expect(result.conflicts.length + result.localConflicts.length + result.pendingConflicts.length).toBeGreaterThan(0)
  })
})

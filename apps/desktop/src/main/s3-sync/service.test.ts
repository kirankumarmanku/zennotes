import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryS3ObjectStore, S3RequestError, type S3ObjectStore } from '@zennotes/shared-domain/s3-object-store'
import { keepBothPath, normalizePrefix, S3SyncService, vaultIdFor, type S3SyncSecrets } from './service'

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zn-s3-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function memorySecrets(): S3SyncSecrets & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    get: async (id) => values.get(id) ?? null,
    set: async (id, secret) => {
      values.set(id, secret)
      return true
    },
    delete: async (id) => {
      values.delete(id)
    },
    canStore: () => true
  }
}

const input = {
  bucket: 'kiran-notes',
  region: 'us-east-1',
  endpoint: null,
  prefix: 'zotly/',
  forcePathStyle: false,
  accessKeyId: 'AKIAEXAMPLEKEY',
  secretAccessKey: 'secret-for-tests',
  vaultName: 'Notes'
}

async function device(store: S3ObjectStore, extra: Partial<ConstructorParameters<typeof S3SyncService>[0]> = {}) {
  const root = await tempDir()
  const secrets = memorySecrets()
  const service = new S3SyncService({
    storageDirectory: await tempDir(),
    secrets,
    createStore: () => store,
    ...extra
  })
  return { root, secrets, service }
}

describe('S3SyncService', () => {
  it('syncs a note from one computer to another through the bucket', async () => {
    const store = createMemoryS3ObjectStore()
    const a = await device(store)
    const b = await device(store)
    await mkdir(path.join(a.root, 'Inbox'), { recursive: true })
    await writeFile(path.join(a.root, 'Inbox', 'Plan.md'), '# Plan\n')

    expect(await a.service.save(a.root, input)).toMatchObject({ pushed: 1, conflicts: 0 })
    expect(await b.service.save(b.root, input)).toMatchObject({ pulled: 1, conflicts: 0 })
    expect(await readFile(path.join(b.root, 'Inbox', 'Plan.md'), 'utf8')).toBe('# Plan\n')

    await writeFile(path.join(b.root, 'Inbox', 'Plan.md'), '# Plan\n\nFrom B\n')
    await b.service.sync(b.root)
    await a.service.sync(a.root)
    expect(await readFile(path.join(a.root, 'Inbox', 'Plan.md'), 'utf8')).toBe('# Plan\n\nFrom B\n')
    expect([...store.objects.keys()].every((key) => key.startsWith('zotly/vaults/notes/'))).toBe(true)
  })

  it('keeps the secret in system storage, never in its settings file', async () => {
    const store = createMemoryS3ObjectStore()
    const storageDirectory = await tempDir()
    const secrets = memorySecrets()
    const root = await tempDir()
    const service = new S3SyncService({ storageDirectory, secrets, createStore: () => store })
    await service.save(root, input)
    const settings = await readFile(path.join(storageDirectory, 'settings.json'), 'utf8')
    expect(settings).not.toContain('secret-for-tests')
    expect([...secrets.values.values()]).toEqual(['secret-for-tests'])
    const status = await service.status(root)
    expect(status).toMatchObject({ configured: true, bucket: 'kiran-notes', hasSecretKey: true, vaultName: 'Notes' })
    expect(JSON.stringify(status)).not.toContain('secret-for-tests')

    // Saving again without a new secret keeps the saved one.
    await service.save(root, { ...input, secretAccessKey: null })
    expect([...secrets.values.values()]).toEqual(['secret-for-tests'])

    await service.disconnect(root)
    expect(secrets.values.size).toBe(0)
    expect((await service.status(root)).configured).toBe(false)
  })

  it('saves nothing when the bucket refuses the keys', async () => {
    const refusing: S3ObjectStore = {
      get: async () => {
        throw new S3RequestError('Access Denied', 403, 'AccessDenied')
      },
      put: async () => {
        throw new S3RequestError('Access Denied', 403, 'AccessDenied')
      },
      list: async () => []
    }
    const { root, secrets, service } = await device(refusing)
    await expect(service.save(root, input)).rejects.toThrow(/refused these keys/)
    expect(secrets.values.size).toBe(0)
    expect((await service.status(root)).configured).toBe(false)
  })

  it('refuses a vault that already syncs with ZenNotes Cloud', async () => {
    const { root, service } = await device(createMemoryS3ObjectStore(), {
      syncsElsewhere: async () => 'This vault already syncs with ZenNotes Cloud.'
    })
    await expect(service.save(root, input)).rejects.toThrow(/ZenNotes Cloud/)
  })

  it('checks what the settings page sends', async () => {
    const { root, service } = await device(createMemoryS3ObjectStore())
    await expect(service.save(root, { ...input, bucket: 'Bad_Bucket' })).rejects.toThrow(/Bucket names/)
    await expect(service.save(root, { ...input, endpoint: 'http://example.com' })).rejects.toThrow(/https/)
    await expect(service.save(root, { ...input, secretAccessKey: null })).rejects.toThrow(/secret access key/)
    await expect(service.save(root, { ...input, vaultName: '!!!' })).rejects.toThrow(/letter or number/)
    expect(normalizePrefix('/zotly')).toBe('zotly/')
    expect(normalizePrefix('')).toBe('')
    expect(() => normalizePrefix('a/../b')).toThrow()
    expect(vaultIdFor('Kiran’s Notes')).toBe('kiran-s-notes')
    expect(keepBothPath('Inbox/plan.md')).toBe('Inbox/plan (this computer).md')
  })

  it('holds a note edited on both computers until one is picked', async () => {
    const store = createMemoryS3ObjectStore()
    const a = await device(store)
    const b = await device(store)
    await writeFile(path.join(a.root, 'Plan.md'), 'base\n')
    await a.service.save(a.root, input)
    await b.service.save(b.root, input)

    await writeFile(path.join(a.root, 'Plan.md'), 'edit from A\n')
    await writeFile(path.join(b.root, 'Plan.md'), 'edit from B\n')
    await a.service.sync(a.root)
    expect((await b.service.sync(b.root)).conflicts).toBe(1)
    const [conflict] = (await b.service.status(b.root)).conflicts
    expect(conflict).toMatchObject({ path: 'Plan.md', kind: 'edit' })
    expect(await readFile(path.join(b.root, 'Plan.md'), 'utf8')).toBe('edit from B\n')

    await b.service.resolveConflict(b.root, conflict.id, 'remote')
    await b.service.sync(b.root)
    expect(await readFile(path.join(b.root, 'Plan.md'), 'utf8')).toBe('edit from A\n')
    expect((await b.service.status(b.root)).conflicts).toEqual([])
  })

  it('asks which version to keep when both computers start with different notes', async () => {
    const store = createMemoryS3ObjectStore()
    const a = await device(store)
    const b = await device(store)
    await writeFile(path.join(a.root, 'Plan.md'), 'from A\n')
    await writeFile(path.join(b.root, 'Plan.md'), 'from B\n')
    await a.service.save(a.root, input)
    expect((await b.service.save(b.root, input)).conflicts).toBe(1)
    // The engine raises a first-sync clash as a pending conflict, like any other.
    const conflicts = (await b.service.status(b.root)).conflicts
    expect(conflicts.map((c) => c.path)).toEqual(['Plan.md'])
    const [conflict] = conflicts

    await b.service.resolveConflict(b.root, conflict.id, 'both')
    await b.service.sync(b.root)
    await a.service.sync(a.root)
    expect(await readFile(path.join(b.root, 'Plan.md'), 'utf8')).toBe('from A\n')
    expect(await readFile(path.join(b.root, 'Plan (this computer).md'), 'utf8')).toBe('from B\n')
    expect(await readFile(path.join(a.root, 'Plan (this computer).md'), 'utf8')).toBe('from B\n')
    expect((await b.service.status(b.root)).conflicts).toEqual([])
  })
})

/**
 * S3 sync on a phone: two devices over one in-memory bucket, through the same
 * shared rules the desktop app runs, so the bucket layout is the desktop's.
 */
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'vitest'
import { createMemoryS3ObjectStore } from '@zennotes/shared-domain/s3-object-store'
import type { S3SyncSettingsInput } from '@zennotes/bridge-contract/s3-sync'
import { installTestHost, type TestHost } from '../test/test-host'
import { MemoryVaultFileSystem } from './memory-fs'
import { PortableVault } from './vault-fs'
import {
  configureMobileS3Sync,
  disconnectMobileS3Sync,
  getMobileS3SyncStatus,
  isMobileS3SyncConfigured,
  saveMobileS3Sync,
  syncMobileS3Vault
} from './mobile-s3-sync'

const input: S3SyncSettingsInput = {
  bucket: 'kiran-notes',
  region: 'us-east-1',
  endpoint: null,
  prefix: 'zotly/',
  forcePathStyle: false,
  accessKeyId: 'AKIATEST',
  secretAccessKey: 'secret-for-tests',
  vaultName: 'Notes'
}

let bucket: ReturnType<typeof createMemoryS3ObjectStore>

function device(word: string, key: string): { host: TestHost; vault: PortableVault<MemoryVaultFileSystem> } {
  const host = installTestHost({ shell: { deviceWord: word } })
  configureMobileS3Sync({ createStore: () => bucket })
  return { host, vault: new PortableVault('Notes', new MemoryVaultFileSystem(key)) }
}

beforeEach(() => {
  bucket = createMemoryS3ObjectStore()
})

afterEach(() => {
  configureMobileS3Sync({})
})

describe('mobile S3 sync', () => {
  it('shares notes between two devices through the desktop bucket layout', async () => {
    const phone = device('iPhone', 'phone/vault')
    phone.vault.fs.put('inbox/idea.md', '# Idea\n\nFrom the phone.\n')
    const first = await saveMobileS3Sync(phone.vault, input)
    assert.equal(first.pushed >= 1, true)

    const keys = [...bucket.objects.keys()]
    assert.ok(keys.includes('zotly/vaults/notes/vault.json'), keys.join('\n'))
    assert.ok(keys.some((key) => key.startsWith('zotly/vaults/notes/log/')))
    assert.ok(keys.some((key) => key.startsWith('zotly/vaults/notes/blobs/')))

    // The secret sits in the host's secure storage, never in the settings.
    const secretKeys = [...phone.host.secrets.values.keys()]
    assert.equal(secretKeys.length, 1)
    assert.match(secretKeys[0]!, /^s3-sync:[0-9a-f]{32}$/)
    const settings = phone.host.storage.values.get('zennotes-s3-sync/settings.json') ?? ''
    assert.ok(settings.length > 0)
    assert.equal(settings.includes('secret-for-tests'), false)

    const mac = device('computer', 'mac/vault')
    const joined = await saveMobileS3Sync(mac.vault, input)
    assert.equal(joined.pulled >= 1, true)
    assert.equal(await mac.vault.fs.readText('inbox/idea.md'), '# Idea\n\nFrom the phone.\n')

    await mac.vault.fs.writeText('inbox/idea.md', '# Idea\n\nEdited on the Mac.\n')
    await syncMobileS3Vault(mac.vault)

    // Back on the phone: its own host and fresh service, same bucket.
    installTestHost({ shell: { deviceWord: 'iPhone' }, storage: phone.host.storage, secrets: phone.host.secrets })
    configureMobileS3Sync({ createStore: () => bucket })
    const back = await syncMobileS3Vault(phone.vault)
    assert.equal(back.pulled, 1)
    assert.equal(await phone.vault.fs.readText('inbox/idea.md'), '# Idea\n\nEdited on the Mac.\n')

    const status = await getMobileS3SyncStatus(phone.vault)
    assert.equal(status.configured, true)
    assert.equal(status.hasSecretKey, true)
    assert.equal(status.prefix, 'zotly/')
    assert.notEqual(status.lastSyncedAt, null)
  })

  it('disconnect forgets the secret and the engine state but leaves the bucket', async () => {
    const phone = device('iPhone', 'phone/vault')
    phone.vault.fs.put('a.md', 'a\n')
    await saveMobileS3Sync(phone.vault, input)
    assert.equal(await isMobileS3SyncConfigured(phone.vault), true)
    const objects = bucket.objects.size

    await disconnectMobileS3Sync(phone.vault)
    assert.equal(await isMobileS3SyncConfigured(phone.vault), false)
    assert.equal(phone.host.secrets.values.size, 0)
    assert.equal(
      [...phone.host.storage.values.keys()].some((key) => key.startsWith('zennotes-s3-sync/states/')),
      false
    )
    assert.equal(bucket.objects.size, objects)
  })

  it('refuses a vault that already syncs another way', async () => {
    const host = installTestHost({
      shell: { deviceWord: 'iPhone' },
      vaults: { syncsElsewhere: async () => 'This vault is in iCloud Drive.' }
    })
    configureMobileS3Sync({ createStore: () => bucket })
    void host
    const vault = new PortableVault('Notes', new MemoryVaultFileSystem('icloud/vault'))
    await assert.rejects(saveMobileS3Sync(vault, input), /iCloud Drive/)
    await assert.rejects(syncMobileS3Vault(vault), /iCloud Drive/)
    const status = await getMobileS3SyncStatus(vault)
    assert.equal(status.available, false)
    assert.match(status.unavailableReason ?? '', /iCloud Drive/)
    assert.equal(bucket.objects.size, 0)
  })

  it('says it needs secure storage when the Keychain is missing', async () => {
    const phone = device('iPhone', 'phone/vault')
    phone.host.secrets.isAvailable = false
    const status = await getMobileS3SyncStatus(phone.vault)
    assert.equal(status.canStoreSecurely, false)
    await assert.rejects(saveMobileS3Sync(phone.vault, input))
    assert.equal(bucket.objects.size, 0)
  })
})
